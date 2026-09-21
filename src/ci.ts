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

const CHECK_BUCKET_STATES = new Map<string, PullRequestCiState>([
  ["fail", "failed"],
  ["cancel", "failed"],
  ["pending", "running"],
  ["pass", "okay"],
  ["skipping", "okay"],
]);

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

/** Interpret `gh pr checks` output for the aggregate footer status. */
export function selectCiStatus(
  output: string,
  pullRequestUrl = "",
): PullRequestCiStatus | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return undefined;
    const checks: PullRequestCheck[] = [];
    for (const check of parsed) {
      if (!check || typeof check.bucket !== "string") return undefined;
      const state = CHECK_BUCKET_STATES.get(check.bucket);
      if (!state) return undefined;
      checks.push({
        state,
        url: text(check.link),
        startedAt: text(check.startedAt),
        completedAt: text(check.completedAt),
      });
    }
    return selectStatus(checks, pullRequestUrl);
  } catch {
    return undefined;
  }
}

export async function fetchCiStatus(
  pi: ExtensionAPI,
  cwd: string,
  pullRequestUrl: string,
): Promise<PullRequestCiStatus | undefined> {
  const result = await gh(
    pi,
    [
      "pr",
      "checks",
      pullRequestUrl,
      "--json",
      "bucket,link,startedAt,completedAt",
    ],
    cwd,
  );
  return result.stdout
    ? selectCiStatus(result.stdout, pullRequestUrl)
    : undefined;
}

export interface CiSnapshot {
  headRefOid: string;
  open: boolean;
  status?: PullRequestCiStatus;
  failures: CiFailure[];
}

function text(value: unknown): string {
  return typeof value === "string"
    ? stripVTControlCharacters(value)
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
    : "";
}

const FAILURE_CONCLUSIONS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

/** Read checks and their PR head together, rather than attaching a guessed SHA. */
export function parseCiSnapshot(
  output: string,
  pullRequestUrl: string,
): CiSnapshot | undefined {
  try {
    const parsed = JSON.parse(output);
    if (
      !parsed ||
      typeof parsed.headRefOid !== "string" ||
      !["OPEN", "CLOSED", "MERGED"].includes(parsed.state) ||
      (parsed.statusCheckRollup !== null &&
        !Array.isArray(parsed.statusCheckRollup))
    ) {
      return undefined;
    }
    const checks: PullRequestCheck[] = [];
    const failures: CiFailure[] = [];
    for (const item of parsed.statusCheckRollup ?? []) {
      if (!item || !["CheckRun", "StatusContext"].includes(item.__typename))
        return undefined;
      const isRun = item.__typename === "CheckRun";
      const conclusion = text(isRun ? item.conclusion : item.state);
      if (
        isRun &&
        ![
          "QUEUED",
          "IN_PROGRESS",
          "COMPLETED",
          "WAITING",
          "REQUESTED",
          "PENDING",
        ].includes(item.status)
      ) {
        return undefined;
      }
      if (
        (!isRun || item.status === "COMPLETED") &&
        !FAILURE_CONCLUSIONS.has(conclusion) &&
        ![
          "SUCCESS",
          "NEUTRAL",
          "SKIPPED",
          "CANCELLED",
          "STALE",
          "PENDING",
          "EXPECTED",
        ].includes(conclusion)
      ) {
        return undefined;
      }
      const pending = isRun
        ? item.status !== "COMPLETED"
        : ["PENDING", "EXPECTED"].includes(conclusion);
      const failed = !pending && FAILURE_CONCLUSIONS.has(conclusion);
      const check: PullRequestCheck = {
        state: pending
          ? "running"
          : failed || ["CANCELLED", "STALE"].includes(conclusion)
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
        if (match?.[1] !== target.owner || match?.[2] !== target.name)
          return failure;
        job = match[3];
      } catch {
        return failure;
      }
      if (!job) return failure;
      const result = await gh(
        pi,
        [
          "run",
          "view",
          "--repo",
          `${target.host}/${target.owner}/${target.name}`,
          "--job",
          job,
          "--log-failed",
        ],
        cwd,
      );
      if (result.code !== 0 || !result.stdout.trim()) return failure;
      return { ...failure, log: ciLogExcerpt(result.stdout) };
    }),
  );
}

export function ciLogExcerpt(output: string): string {
  const clean = stripVTControlCharacters(output)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  const tail = clean.split("\n").slice(-80).join("\n").slice(-4000);
  return tail.length < clean.length
    ? `[Excerpt truncated; open the job for full logs.]\n${tail}`
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
    const parsed = JSON.parse(result.stdout);
    return (
      result.code === 0 &&
      parsed.state === "OPEN" &&
      parsed.headRefOid === headRefOid
    );
  } catch {
    return false;
  }
}
