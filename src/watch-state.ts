import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isCiFailureEvent, isFeedbackEvent, type PullRequestTarget } from "./api.ts";
import { CI_FAILURE_MESSAGE_TYPE } from "./ci-message.ts";
import { parsePullRequestUrl } from "./discovery.ts";
import { FEEDBACK_MESSAGE_TYPE } from "./message.ts";
import type { ResumeWatch } from "./poller.ts";

export const WATCH_STATE_TYPE = "pi-prs-watch-state";

export interface WatchState {
  version: 1;
  /** Null records an explicit stop or a pull request that is no longer watched. */
  target: PullRequestTarget | null;
}

type PullRequestIdentity = Pick<
  PullRequestTarget, "host" | "owner" | "name" | "number"
>;

export function samePullRequest(
  left: PullRequestIdentity,
  right: PullRequestIdentity,
): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.number === right.number
  );
}

function parseTarget(value: unknown): PullRequestTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const target = value as Partial<PullRequestTarget>;
  if (
    typeof target.host !== "string" ||
    typeof target.owner !== "string" ||
    typeof target.name !== "string" ||
    typeof target.url !== "string" ||
    typeof target.number !== "number"
  ) return undefined;
  const parsed = parsePullRequestUrl(target.url);
  return parsed && samePullRequest(target as PullRequestTarget, parsed)
    ? { ...parsed, url: target.url } : undefined;
}

function savedTarget(data: unknown): PullRequestTarget | undefined {
  if (!data || typeof data !== "object") return undefined;
  const state = data as Partial<WatchState>;
  return state.version === 1 ? parseTarget(state.target) : undefined;
}

/** Restore only the selected session branch, never abandoned alternative histories. */
export function restoreWatch(
  entries: readonly SessionEntry[],
): ResumeWatch | undefined {
  const latest = entries.findLast(
    (entry) => entry.type === "custom" && entry.customType === WATCH_STATE_TYPE,
  );
  if (!latest || latest.type !== "custom") return undefined;
  const target = savedTarget(latest.data);
  if (!target) return undefined;

  // Only persisted deliveries count. Feedback still queued when Pi shut down
  // must remain eligible for delivery after reattaching the session.
  const feedbackIds = new Set<string>();
  const ciFailureIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    if (
      entry.customType === FEEDBACK_MESSAGE_TYPE && isFeedbackEvent(entry.details)
    ) {
      const source = parseTarget(entry.details.target);
      if (!source || !samePullRequest(target, source)) continue;
      // The public feedback guard only validates the envelope, not every item.
      for (const item of entry.details.feedback) {
        if (typeof item?.id === "string") feedbackIds.add(item.id);
      }
    }
    if (
      entry.customType === CI_FAILURE_MESSAGE_TYPE && isCiFailureEvent(entry.details)
    ) {
      const source = parseTarget(entry.details.target);
      if (!source || !samePullRequest(target, source)) continue;
      for (const item of entry.details.failures) ciFailureIds.add(item.id);
    }
  }
  return { target, feedbackIds: [...feedbackIds], ciFailureIds: [...ciFailureIds] };
}
