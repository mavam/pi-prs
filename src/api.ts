import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Public contract of pi-prs.
 *
 * pi-prs is the single owner of GitHub polling in a Pi session. Other
 * extensions consume pull request state and review feedback from the event
 * bus instead of shelling out to `gh` themselves.
 */
export const PI_PR_PROTOCOL = 1 as const;
export const PI_PR_STATE_CHANNEL = "pi-prs:state";
export const PI_PR_FEEDBACK_CHANNEL = "pi-prs:feedback";
export const PI_PR_CI_FAILURE_CHANNEL = "pi-prs:ci-failure";

export interface PullRequestTarget {
  host: string;
  owner: string;
  name: string;
  number: number;
  url: string;
}

export type PullRequestLifecycle = "open" | "merged" | "closed";
export type PullRequestCiState = "running" | "failed" | "okay";
export type PullRequestHealth = "ok" | "unauthenticated" | "error";

export interface PullRequestCiStatus {
  state: PullRequestCiState;
  url: string;
}

export interface PullRequestSnapshot {
  target: PullRequestTarget;
  lifecycle: PullRequestLifecycle;
  isDraft: boolean;
  autoMergeEnabled: boolean;
  headRefOid: string;
  ci?: PullRequestCiStatus;
  unresolvedThreadCount: number;
  /** True while `/pr watch` streams reviews and CI failures for this pull request. */
  watching: boolean;
}

/** Latest known GitHub state for the current checkout. */
export interface PullRequestStateEvent {
  protocol: typeof PI_PR_PROTOCOL;
  source: "pi-prs";
  /** `owner/name` of the resolved GitHub repository, or "" outside GitHub. */
  repository: string;
  branch: string;
  health: PullRequestHealth;
  pullRequest?: PullRequestSnapshot;
  updatedAt: number;
}

export type FeedbackKind = "conversation" | "review" | "inline";

export interface ReviewFeedback {
  id: string;
  kind: FeedbackKind;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  priority?: string;
  title?: string;
  reviewedCommit?: string;
  path?: string;
  line?: number;
  diffLine?: number;
  diffHunk?: string;
}

/** Review feedback that the session has not seen yet. */
export interface FeedbackEvent {
  protocol: typeof PI_PR_PROTOCOL;
  source: "pi-prs";
  target: PullRequestTarget;
  feedback: ReviewFeedback[];
}

export interface CiFailure {
  /** Execution identity, including commit and timestamps to distinguish reruns. */
  id: string;
  name: string;
  workflow: string;
  conclusion: string;
  url: string;
  /** Bounded, untrusted diagnostic output; absent when unavailable. */
  log?: string;
}

export interface CiFailureEvent {
  protocol: typeof PI_PR_PROTOCOL;
  source: "pi-prs";
  target: PullRequestTarget;
  headRefOid: string;
  failures: CiFailure[];
}

export function isCiFailureEvent(value: unknown): value is CiFailureEvent {
  return (
    isRecord(value) &&
    value.protocol === PI_PR_PROTOCOL &&
    value.source === "pi-prs" &&
    isRecord(value.target) &&
    ["host", "owner", "name", "url"].every(
      (key) =>
        typeof (value.target as Record<string, unknown>)[key] === "string",
    ) &&
    typeof value.target.number === "number" &&
    typeof value.headRefOid === "string" &&
    Array.isArray(value.failures) &&
    value.failures.every(
      (item) =>
        isRecord(item) &&
        ["id", "name", "workflow", "conclusion", "url"].every(
          (key) => typeof item[key] === "string",
        ) &&
        (item.log === undefined || typeof item.log === "string"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPullRequestStateEvent(
  value: unknown,
): value is PullRequestStateEvent {
  return (
    isRecord(value) &&
    value.protocol === PI_PR_PROTOCOL &&
    value.source === "pi-prs" &&
    typeof value.repository === "string" &&
    typeof value.branch === "string"
  );
}

export function isFeedbackEvent(value: unknown): value is FeedbackEvent {
  return (
    isRecord(value) &&
    value.protocol === PI_PR_PROTOCOL &&
    value.source === "pi-prs" &&
    isRecord(value.target) &&
    Array.isArray(value.feedback)
  );
}

export interface PiPrClient {
  onState(handler: (event: PullRequestStateEvent) => void): () => void;
  onFeedback(handler: (event: FeedbackEvent) => void): () => void;
  onCiFailure(handler: (event: CiFailureEvent) => void): () => void;
}

/** Create a typed client over the import-free event-bus protocol. */
export function createPiPrClient(pi: ExtensionAPI): PiPrClient {
  return {
    onState: (handler) =>
      pi.events.on(PI_PR_STATE_CHANNEL, (raw) => {
        if (isPullRequestStateEvent(raw)) handler(raw);
      }),
    onFeedback: (handler) =>
      pi.events.on(PI_PR_FEEDBACK_CHANNEL, (raw) => {
        if (isFeedbackEvent(raw)) handler(raw);
      }),
    onCiFailure: (handler) =>
      pi.events.on(PI_PR_CI_FAILURE_CHANNEL, (raw) => {
        if (isCiFailureEvent(raw)) handler(raw);
      }),
  };
}
