import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  PullRequestLifecycle,
  PullRequestMergeState,
  PullRequestTarget,
} from "./api.ts";
import { gh, git, isAuthFailure } from "./exec.ts";

export interface GitHubRepositoryRef {
  host: string;
  owner: string;
  name: string;
  repository: string;
}

export interface DiscoveredPullRequest {
  target: PullRequestTarget;
  lifecycle: PullRequestLifecycle;
  isDraft: boolean;
  autoMergeEnabled: boolean;
  mergeState: PullRequestMergeState;
  headRefOid: string;
}

export interface PullRequestLookupPlan {
  baseRepositories: GitHubRepositoryRef[];
  headOwners: string[];
}

export interface RepositoryContext {
  repository: string;
  plan: PullRequestLookupPlan | undefined;
}

export interface DiscoveryResult {
  repository: string;
  pullRequest: DiscoveredPullRequest | undefined;
  authFailed: boolean;
  failed: boolean;
}

interface GitHubRemote {
  name: string;
  ref: GitHubRepositoryRef;
}

interface PullRequestCandidate extends DiscoveredPullRequest {
  headOwner: string;
}

interface CandidateNode {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  isDraft?: unknown;
  autoMergeRequest?: unknown;
  mergeStateStatus?: unknown;
  headRefOid?: unknown;
  headRepositoryOwner?: { login?: unknown } | null;
}

const PULL_REQUEST_FIELDS = [
  "number",
  "url",
  "state",
  "isDraft",
  "autoMergeRequest { enabledAt }",
  "mergeStateStatus",
  "headRefOid",
  "headRepositoryOwner { login }",
].join(" ");

const PULL_REQUEST_QUERY = [
  "query($owner: String!, $name: String!, $branch: String!) {",
  "  repository(owner: $owner, name: $name) {",
  "    open: pullRequests(states: OPEN, headRefName: $branch, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {",
  `      nodes { ${PULL_REQUEST_FIELDS} }`,
  "    }",
  "    merged: pullRequests(states: MERGED, headRefName: $branch, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {",
  `      nodes { ${PULL_REQUEST_FIELDS} }`,
  "    }",
  "  }",
  "}",
].join(" ");

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseGitHubHost(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized === "github.com") return normalized;
  if (/^github(?:[.-][a-z0-9][a-z0-9-]*)+\.[a-z]{2,}$/i.test(normalized)) {
    return normalized;
  }
  return "";
}

export function parseGitHubRemote(
  url: string,
): GitHubRepositoryRef | undefined {
  const trimmed = url.trim();
  const scpLike = trimmed.includes("://")
    ? undefined
    : trimmed.match(/^.+@([^:/]+):([^/][^:]*\/[^:]+)$/);
  const urlLike = trimmed.match(
    /^(?:https?:\/\/|ssh:\/\/.+@)([^/:]+)(?::\d+)?\/(.+\/.+)$/,
  );
  const match = scpLike ?? urlLike;
  if (!match) return undefined;

  const [, rawHost, rawRepository] = match;
  const host = parseGitHubHost(rawHost ?? "");
  if (!host || !rawRepository) return undefined;

  const repository = rawRepository.replace(/\.git$/i, "");
  const slash = repository.indexOf("/");
  if (slash <= 0 || slash >= repository.length - 1) return undefined;

  return {
    host,
    owner: repository.slice(0, slash),
    name: repository.slice(slash + 1),
    repository,
  };
}

export function parsePullRequestUrl(
  url: string,
): Omit<PullRequestTarget, "url"> | undefined {
  const match = url.match(
    /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/,
  );
  if (!match) return undefined;

  const [, rawHost, owner, name, numberText] = match;
  const hostRef = parseGitHubRemote(`https://${rawHost}/${owner}/${name}.git`);
  const number = Math.max(0, Math.floor(toNumber(numberText)));
  if (!hostRef || !owner || !name || number <= 0) return undefined;
  return { host: hostRef.host, owner, name, number };
}

function parseRemoteUrls(output: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^remote\.([^\s]+)\.url\s+(.+)$/);
    if (!match) continue;
    const [, remoteName, url] = match;
    if (!remoteName || !url) continue;
    remotes.set(remoteName, url.trim());
  }
  return remotes;
}

function parseGitHubRemotes(remoteUrls: string): GitHubRemote[] {
  const remotes: GitHubRemote[] = [];
  for (const [name, url] of parseRemoteUrls(remoteUrls)) {
    const ref = parseGitHubRemote(url);
    if (ref) remotes.push({ name, ref });
  }
  return remotes;
}

function orderedRemoteValues<T>(
  remotes: GitHubRemote[],
  preferredNames: string[],
  pick: (remote: GitHubRemote) => T,
  keyFor: (value: T) => string = String,
): T[] {
  const byName = new Map(remotes.map((remote) => [remote.name, remote]));
  const ordered: T[] = [];
  const seen = new Set<string>();

  for (const remoteName of [
    ...preferredNames,
    ...remotes.map((remote) => remote.name),
  ]) {
    if (!remoteName) continue;
    const remote = byName.get(remoteName);
    if (!remote) continue;
    const value = pick(remote);
    const key = keyFor(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ordered.push(value);
  }

  return ordered;
}

function parseRemoteName(upstream: string): string {
  const slash = upstream.indexOf("/");
  return slash <= 0 ? "" : upstream.slice(0, slash);
}

export function createRepositoryContext(
  remoteUrls: string,
  upstream: string,
): RepositoryContext {
  const preferredRemote = parseRemoteName(upstream);
  const remotes = parseGitHubRemotes(remoteUrls);
  if (remotes.length === 0) return { repository: "", plan: undefined };

  return {
    repository:
      orderedRemoteValues(
        remotes,
        [preferredRemote, "origin", "upstream"],
        (remote) => remote.ref.repository,
      )[0] ?? "",
    plan: {
      // Pull requests often live in the upstream repository even when the
      // branch tracks a fork remote.
      baseRepositories: orderedRemoteValues(
        remotes,
        ["upstream", preferredRemote, "origin"],
        (remote) => remote.ref,
        (ref) => `${ref.host}/${ref.repository}`,
      ),
      headOwners: orderedRemoteValues(
        remotes,
        [preferredRemote, "origin", "upstream"],
        (remote) => remote.ref.owner,
      ),
    },
  };
}

export function parseLifecycle(
  value: unknown,
): PullRequestLifecycle | undefined {
  if (typeof value !== "string") return undefined;
  const state = value.toLowerCase();
  return state === "open" || state === "merged" || state === "closed"
    ? state
    : undefined;
}

/** Map GitHub's `mergeStateStatus` onto the states the footer distinguishes. */
export function parseMergeState(value: unknown): PullRequestMergeState {
  if (typeof value !== "string") return "unknown";
  switch (value.toUpperCase()) {
    // UNSTABLE means only non-required checks fail; GitHub still allows merging.
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
      return "mergeable";
    case "DIRTY":
      return "conflicting";
    case "BLOCKED":
    case "BEHIND":
    case "DRAFT":
      return "blocked";
    default:
      return "unknown";
  }
}

function toDiscovered(
  node: CandidateNode,
  fallbackHost: string,
): (DiscoveredPullRequest & { headOwner: string }) | undefined {
  const number = Math.max(0, Math.floor(toNumber(node.number)));
  const url = typeof node.url === "string" ? node.url : "";
  const lifecycle = parseLifecycle(node.state);
  if (number <= 0 || !url || !lifecycle) return undefined;

  const location = parsePullRequestUrl(url);
  return {
    target: {
      host: location?.host ?? fallbackHost,
      owner: location?.owner ?? "",
      name: location?.name ?? "",
      number,
      url,
    },
    lifecycle,
    isDraft: node.isDraft === true,
    autoMergeEnabled:
      typeof node.autoMergeRequest === "object" && node.autoMergeRequest !== null,
    mergeState: parseMergeState(node.mergeStateStatus),
    headRefOid: typeof node.headRefOid === "string" ? node.headRefOid : "",
    headOwner:
      typeof node.headRepositoryOwner?.login === "string"
        ? node.headRepositoryOwner.login
        : "",
  };
}

export function selectPullRequestFromGraphQL(
  output: string,
  headOwners: string[],
  fallbackHost: string,
): DiscoveredPullRequest | undefined {
  let nodes: CandidateNode[];
  try {
    const parsed = JSON.parse(output) as {
      data?: {
        repository?: {
          open?: { nodes?: CandidateNode[] };
          merged?: { nodes?: CandidateNode[] };
        } | null;
      };
    };
    const repository = parsed?.data?.repository;
    nodes = [
      ...(Array.isArray(repository?.open?.nodes) ? repository.open.nodes : []),
      ...(Array.isArray(repository?.merged?.nodes)
        ? repository.merged.nodes
        : []),
    ];
  } catch {
    return undefined;
  }

  const candidates: PullRequestCandidate[] = [];
  for (const node of nodes) {
    const candidate = toDiscovered(node, fallbackHost);
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length === 0 || headOwners.length === 0) return undefined;

  let best: PullRequestCandidate | undefined;
  let bestOwnerRank = Number.POSITIVE_INFINITY;
  let bestStateRank = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const ownerRank = headOwners.indexOf(candidate.headOwner);
    if (ownerRank < 0) continue;
    // Within the most likely head owner, prefer an active pull request when a
    // branch name has also been used by a merged one.
    const stateRank = candidate.lifecycle === "open" ? 0 : 1;
    if (
      ownerRank < bestOwnerRank ||
      (ownerRank === bestOwnerRank && stateRank < bestStateRank)
    ) {
      best = candidate;
      bestOwnerRank = ownerRank;
      bestStateRank = stateRank;
    }
  }
  if (!best) return undefined;

  const { headOwner: _headOwner, ...pullRequest } = best;
  return pullRequest;
}

export function parsePullRequestView(
  output: string,
): DiscoveredPullRequest | undefined {
  try {
    return toDiscovered(JSON.parse(output) as CandidateNode, "github.com");
  } catch {
    return undefined;
  }
}

export async function currentBranch(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string> {
  const head = await git(pi, ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  return head.trim();
}

/** Resolve the pull request for `branch`, preferring the upstream repository. */
export async function discoverPullRequest(
  pi: ExtensionAPI,
  cwd: string,
  branch: string,
): Promise<DiscoveryResult> {
  if (!branch) {
    return {
      repository: "",
      pullRequest: undefined,
      authFailed: false,
      failed: false,
    };
  }

  const [upstream, remoteUrls] = await Promise.all([
    git(pi, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd),
    git(pi, ["config", "--get-regexp", "^remote\\..*\\.url$"], cwd),
  ]);

  const context = createRepositoryContext(remoteUrls, upstream);
  if (!context.plan) {
    return {
      repository: context.repository,
      pullRequest: undefined,
      authFailed: false,
      failed: false,
    };
  }

  let authFailed = false;
  let failed = false;
  let lookupSucceeded = false;
  for (const baseRepository of context.plan.baseRepositories) {
    const result = await gh(
      pi,
      [
        "api",
        "graphql",
        "--hostname",
        baseRepository.host,
        "-f",
        `query=${PULL_REQUEST_QUERY}`,
        "-F",
        `owner=${baseRepository.owner}`,
        "-F",
        `name=${baseRepository.name}`,
        "-F",
        `branch=${branch}`,
      ],
      cwd,
    );
    if (result.code !== 0 || !result.stdout) {
      if (isAuthFailure(result)) authFailed = true;
      else failed = true;
      continue;
    }
    lookupSucceeded = true;

    const pullRequest = selectPullRequestFromGraphQL(
      result.stdout,
      context.plan.headOwners,
      baseRepository.host,
    );
    if (pullRequest) {
      return {
        repository: context.repository,
        pullRequest,
        authFailed: false,
        failed: false,
      };
    }
  }

  const fallback = await gh(
    pi,
    ["pr", "view", "--json", "number,url,headRefOid,state,isDraft,autoMergeRequest,mergeStateStatus"],
    cwd,
  );
  if (isAuthFailure(fallback)) authFailed = true;
  const pullRequest =
    fallback.code === 0 && fallback.stdout
      ? parsePullRequestView(fallback.stdout)
      : undefined;
  if (pullRequest) {
    return {
      repository: context.repository,
      pullRequest,
      authFailed: false,
      failed: false,
    };
  }
  if (fallback.code === 0 && !pullRequest) failed = true;
  if (fallback.code !== 0 && !lookupSucceeded && !authFailed) failed = true;

  return {
    repository: context.repository,
    pullRequest: undefined,
    authFailed,
    failed,
  };
}
