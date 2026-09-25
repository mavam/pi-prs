import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import type {
  CiFailure,
  PullRequestCiState,
  PullRequestCiStatus,
  PullRequestTarget,
} from "./api.ts";
import type { FetchOutcome } from "./feedback.ts";
import { gh, isAuthFailure } from "./exec.ts";

interface PullRequestCheck {
  state: PullRequestCiState;
  url: string;
  startedAt: string;
  completedAt: string;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectStatus(
  checks: PullRequestCheck[],
  pullRequestUrl: string,
): PullRequestCiStatus | undefined {
  const newest = [...checks].sort((left, right) => {
    const leftAt = timestamp(left.completedAt) || timestamp(left.startedAt);
    const rightAt = timestamp(right.completedAt) || timestamp(right.startedAt);
    return rightAt - leftAt;
  });
  const selected =
    newest.find((check) => check.state === "failed") ??
    newest.find((check) => check.state === "running") ??
    newest[0];
  return selected
    ? { state: selected.state, url: selected.url || pullRequestUrl }
    : undefined;
}

export interface CiSnapshot {
  headRefOid: string;
  open: boolean;
  status?: PullRequestCiStatus;
  failures: CiFailure[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string"
    ? stripVTControlCharacters(value)
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
    : "";
}

/** Conclusions the agent can act on; these start agent turns. */
const FAILURE_CONCLUSIONS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "STARTUP_FAILURE",
]);

/** Terminal but not actionable by the agent; shown as failed in the footer. */
const BLOCKED_CONCLUSIONS = new Set(["ACTION_REQUIRED", "CANCELLED", "STALE"]);

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** Read checks and their PR head together, rather than attaching a guessed SHA. */
export function parseCiSnapshot(
  output: string,
  pullRequestUrl: string,
): CiSnapshot | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      !isRecord(parsed) ||
      typeof parsed.headRefOid !== "string" ||
      !["OPEN", "CLOSED", "MERGED"].includes(text(parsed.state)) ||
      (parsed.statusCheckRollup !== null &&
        !Array.isArray(parsed.statusCheckRollup))
    ) {
      return undefined;
    }
    const checks: PullRequestCheck[] = [];
    const failures: CiFailure[] = [];
    for (const raw of (parsed.statusCheckRollup ?? []) as unknown[]) {
      // Incomplete or unfamiliar checks must not hide valid failures or make
      // the rollup green. Keep them pending without degrading transport health.
      const item = isRecord(raw) ? raw : {};
      const isRun = item.__typename === "CheckRun";
      const known = isRun || item.__typename === "StatusContext";
      const conclusion = text(isRun ? item.conclusion : item.state);
      const terminal =
        FAILURE_CONCLUSIONS.has(conclusion) ||
        BLOCKED_CONCLUSIONS.has(conclusion) ||
        PASSING_CONCLUSIONS.has(conclusion);
      const pending =
        !known || !terminal || (isRun && item.status !== "COMPLETED");
      const failed = !pending && FAILURE_CONCLUSIONS.has(conclusion);
      const check: PullRequestCheck = {
        state: pending
          ? "running"
          : failed || BLOCKED_CONCLUSIONS.has(conclusion)
            ? "failed"
            : "okay",
        url: text(isRun ? item.detailsUrl : item.targetUrl),
        startedAt: text(isRun ? item.startedAt : item.createdAt),
        completedAt: text(isRun ? item.completedAt : item.createdAt),
      };
      checks.push(check);
      if (!failed) continue;
      const name = text(isRun ? item.name : item.context) || "CI check";
      const workflow = text(item.workflowName);
      // Job URLs identify Actions reruns; timestamps also cover providers that
      // reuse a check URL and legacy commit statuses that have no execution ID.
      const id = JSON.stringify([
        parsed.headRefOid,
        item.__typename,
        workflow,
        name,
        check.url,
        check.startedAt,
        check.completedAt,
      ]);
      failures.push({
        id,
        name,
        workflow,
        conclusion,
        url: check.url || pullRequestUrl,
      });
    }
    return {
      headRefOid: parsed.headRefOid,
      open: parsed.state === "OPEN",
      status: selectStatus(checks, pullRequestUrl),
      failures,
    };
  } catch {
    return undefined;
  }
}

export async function fetchCiSnapshot(
  pi: ExtensionAPI,
  cwd: string,
  target: PullRequestTarget,
): Promise<FetchOutcome<CiSnapshot>> {
  const result = await gh(
    pi,
    ["pr", "view", target.url, "--json", "headRefOid,state,statusCheckRollup"],
    cwd,
  );
  return {
    value:
      result.code === 0
        ? parseCiSnapshot(result.stdout, target.url)
        : undefined,
    authFailed: isAuthFailure(result),
  };
}

async function fetchJobLog(
  pi: ExtensionAPI,
  cwd: string,
  target: PullRequestTarget,
  job: string,
): Promise<string | undefined> {
  // Unlike `gh run view --log-failed`, the jobs API serves a job's log as soon
  // as the job completes, even while other jobs in the run are still going.
  const args = [
    "api",
    "--hostname",
    target.host,
    `repos/${target.owner}/${target.name}/actions/jobs/${job}/logs`,
  ];
  // Newer gh refuses raw output with escape sequences unless allowed; older gh
  // lacks the flag. We strip escape sequences ourselves either way.
  let result = await gh(pi, [...args, "--allow-escape-sequences"], cwd);
  if (result.code !== 0 && /unknown flag/i.test(result.stderr)) {
    result = await gh(pi, args, cwd);
  }
  return result.code === 0 && result.stdout.trim() ? result.stdout : undefined;
}

/** Logs can lag behind checks. Never suppress a failure because logs are missing. */
export async function withCiDiagnostics(
  pi: ExtensionAPI,
  cwd: string,
  target: PullRequestTarget,
  failures: CiFailure[],
): Promise<CiFailure[]> {
  // Bound both network work and injected output, even for large job matrices.
  return Promise.all(
    failures.map(async (failure, index) => {
      if (index >= 3) return failure;
      let job: string | undefined;
      try {
        const url = new URL(failure.url);
        if (url.protocol !== "https:" || url.host !== target.host)
          return failure;
        const match =
          /^\/([^/]+)\/([^/]+)\/actions\/runs\/\d+(?:\/attempts\/\d+)?\/job\/(\d+)$/.exec(
            url.pathname,
          );
        // GitHub owner and repository names are case-insensitive.
        if (
          match?.[1]?.toLowerCase() !== target.owner.toLowerCase() ||
          match?.[2]?.toLowerCase() !== target.name.toLowerCase()
        )
          return failure;
        job = match[3];
      } catch {
        return failure;
      }
      if (!job) return failure;
      const log = await fetchJobLog(pi, cwd, target, job);
      if (!log) return failure;
      const excerpt = ciLogExcerpt(jobLogFailureWindow(log));
      return excerpt ? { ...failure, log: excerpt } : failure;
    }),
  );
}

const LOG_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/**
 * Focus a full Actions job log on its failure: drop per-line timestamps and
 * end at the last error annotation, so post-job cleanup doesn't crowd out the
 * output that explains the failure.
 */
export function jobLogFailureWindow(log: string): string {
  const lines = log
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(LOG_TIMESTAMP, ""))
    .filter((line) => !line.startsWith("##[endgroup]"));
  let end = lines.length;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.startsWith("##[error]")) {
      end = index + 1;
      break;
    }
  }
  return lines.slice(0, end).join("\n");
}

const TRUNCATED_HEADER = "[Excerpt truncated; open the job for full logs.]";

/** Bound a log excerpt; idempotent, so it also guards third-party events. */
export function ciLogExcerpt(output: string): string {
  let clean = stripVTControlCharacters(output)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  const truncated = clean.startsWith(TRUNCATED_HEADER);
  if (truncated) clean = clean.slice(TRUNCATED_HEADER.length).trimStart();
  const tail = clean.split("\n").slice(-80).join("\n").slice(-4000);
  return truncated || tail.length < clean.length
    ? `${TRUNCATED_HEADER}\n${tail}`
    : tail;
}


/** Recheck after fetching diagnostics: the PR may have advanced or closed. */
export async function ciHeadIsCurrent(
  pi: ExtensionAPI,
  cwd: string,
  target: PullRequestTarget,
  headRefOid: string,
): Promise<boolean> {
  const result = await gh(
    pi,
    ["pr", "view", target.url, "--json", "headRefOid,state"],
    cwd,
  );
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return (
      result.code === 0 &&
      isRecord(parsed) &&
      parsed.state === "OPEN" &&
      parsed.headRefOid === headRefOid
    );
  } catch {
    return false;
  }
}
