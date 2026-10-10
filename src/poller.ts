import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PI_PR_PROTOCOL,
  type CiFailureEvent,
  type PullRequestHealth,
  type PullRequestSnapshot,
  type PullRequestStateEvent,
  type PullRequestTarget,
  type ReviewFeedback,
} from "./api.ts";
import {
  type CiSnapshot,
  ciHeadIsCurrent,
  fetchCiSnapshot,
  withCiDiagnostics,
} from "./ci.ts";
import {
  type DiscoveredPullRequest,
  currentBranch,
  discoverPullRequest,
} from "./discovery.ts";
import {
  type FeedbackSnapshot,
  type FetchOutcome,
  type ThreadCountSnapshot,
  fetchFeedback,
  fetchThreadCount,
} from "./feedback.ts";
import { samePullRequest } from "./watch-state.ts";

function isFeedbackSnapshot(
  snapshot: FeedbackSnapshot | ThreadCountSnapshot,
): snapshot is FeedbackSnapshot {
  return "feedback" in snapshot;
}

/**
 * Opinionated cadences. pi-prs is the only GitHub poller in a session, so these
 * are deliberately conservative; configuration comes later.
 */
const IDLE_INTERVAL_MS = 60_000;
const WATCH_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;

export interface PollerTimer {
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

export interface ResumeWatch {
  target: PullRequestTarget;
  /** IDs from feedback actually delivered to the session, not queued messages. */
  feedbackIds: string[];
  ciFailureIds: string[];
}

export interface PollerOptions {
  pi: ExtensionAPI;
  onState: (state: PullRequestStateEvent) => void;
  onFeedback: (target: PullRequestTarget, feedback: ReviewFeedback[]) => void;
  /** Return false when the event could not be delivered; it will be retried. */
  onCiFailure?: (event: CiFailureEvent) => boolean | void;
  /** Watch intent changes only; stopping the poller preserves the intent. */
  onWatchChange?: (target: PullRequestTarget | undefined) => void;
  timers?: PollerTimer;
}

export interface WatchResult {
  ok: boolean;
  target?: PullRequestTarget;
  error?: string;
}

export interface Poller {
  start(cwd: string, resume?: ResumeWatch): void;
  stop(): void;
  setCwd(cwd: string): void;
  /** Invoke onReady once watching starts, before initial feedback is delivered. */
  watch(cwd: string, onReady?: () => void): Promise<WatchResult>;
  unwatch(): boolean;
  isWatching(): boolean;
  currentState(): PullRequestStateEvent | undefined;
}

export function createPoller(options: PollerOptions): Poller {
  const { pi, onState, onFeedback } = options;
  const timers: PollerTimer = options.timers ?? {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  let active = false;
  let cwd = process.cwd();
  let timer: unknown;
  let cycleRunning = false;
  let restartRequested = false;
  let pendingWatch: object | undefined;
  let failures = 0;

  let branch = "";
  let branchInitialized = false;
  let pendingResume: ResumeWatch | undefined;
  let resumeBaseline = false;
  let repository = "";
  let discovered: DiscoveredPullRequest | undefined;
  let watching = false;
  let seen = new Set<string>();
  let seenCi = new Set<string>();
  // Invalidates in-flight work on watch changes, target changes, and shutdown.
  let generation = 0;
  let state: PullRequestStateEvent | undefined;
  let ciStatus: PullRequestSnapshot["ci"];
  let unresolvedThreadCount = 0;

  const reportWatch = (target: PullRequestTarget | undefined): void => {
    try {
      options.onWatchChange?.(target);
    } catch {
      // Persistence and other consumers must not break polling or delivery.
    }
  };

  const endWatch = (report = true): number => {
    const hadIntent = watching || pendingResume !== undefined;
    const token = ++generation;
    watching = false;
    pendingResume = undefined;
    resumeBaseline = false;
    if (report && hadIntent) reportWatch(undefined);
    return token;
  };

  const clearTarget = (report = true): number => {
    const hadIntent = watching || pendingResume !== undefined;
    const token = endWatch(false);
    discovered = undefined;
    seen = new Set<string>();
    seenCi = new Set<string>();
    ciStatus = undefined;
    unresolvedThreadCount = 0;
    if (report && hadIntent) reportWatch(undefined);
    return token;
  };

  const publish = (health: PullRequestHealth): void => {
    const pullRequest: PullRequestSnapshot | undefined = discovered
      ? {
          target: discovered.target,
          lifecycle: discovered.lifecycle,
          isDraft: discovered.isDraft,
          autoMergeEnabled: discovered.autoMergeEnabled,
          mergeState: discovered.mergeState,
          headRefOid: discovered.headRefOid,
          ...(ciStatus ? { ci: ciStatus } : {}),
          unresolvedThreadCount,
          watching,
        }
      : undefined;

    state = {
      protocol: PI_PR_PROTOCOL,
      source: "pi-prs",
      repository,
      branch,
      health,
      ...(pullRequest ? { pullRequest } : {}),
      updatedAt: Date.now(),
    };
    try {
      onState(state);
    } catch {
      // State consumers must not break the polling loop.
    }
  };

  const schedule = (health: PullRequestHealth): void => {
    if (!active) return;
    if (timer !== undefined) timers.clear(timer);

    const base = watching ? WATCH_INTERVAL_MS : IDLE_INTERVAL_MS;
    const delay =
      health === "ok"
        ? base
        : Math.min(base * 2 ** Math.min(failures, 5), MAX_BACKOFF_MS);
    timer = timers.set(() => {
      timer = undefined;
      void cycle();
    }, delay);
  };

  const deliverCi = async (
    snapshot: CiSnapshot,
    target: PullRequestTarget,
    pollCwd: string,
    token: number,
  ): Promise<void> => {
    const current = () =>
      active &&
      watching &&
      generation === token &&
      cwd === pollCwd &&
      discovered?.target.url === target.url &&
      discovered.lifecycle === "open" &&
      snapshot.open &&
      discovered.headRefOid === snapshot.headRefOid;
    const onCiFailure = options.onCiFailure;
    if (!current() || !onCiFailure) return;
    // Large matrices are drained over successive polls instead of flooding a turn.
    const fresh = snapshot.failures
      .filter((item) => !seenCi.has(item.id))
      .slice(0, 20);
    if (fresh.length === 0) return;
    const failures = await withCiDiagnostics(pi, pollCwd, target, fresh);
    if (!current()) return;
    const [sameHead, nextBranch] = await Promise.all([
      ciHeadIsCurrent(pi, pollCwd, target, snapshot.headRefOid),
      currentBranch(pi, pollCwd),
    ]);
    if (!current() || !sameHead || nextBranch !== branch) return;
    const delivered = seenCi;
    try {
      const accepted = onCiFailure({
        protocol: PI_PR_PROTOCOL,
        source: "pi-prs",
        target,
        headRefOid: snapshot.headRefOid,
        failures,
      });
      if (accepted === false) return;
      for (const item of fresh) delivered.add(item.id);
    } catch {
      // Leave failed deliveries unseen so the next poll can retry.
    }
  };

  /** One poll: resolve the pull request, refresh its state, publish. */
  const cycle = async (): Promise<void> => {
    if (!active || cycleRunning || pendingWatch) return;
    cycleRunning = true;
    restartRequested = false;
    const pollCwd = cwd;
    const initialGeneration = generation;
    let nextHealth: PullRequestHealth = state?.health ?? "ok";

    try {
      const nextBranch = await currentBranch(pi, pollCwd);
      if (!active || generation !== initialGeneration) return;
      if (!branchInitialized) {
        // The first branch read belongs to the saved intent, not a branch change.
        branchInitialized = true;
        branch = nextBranch;
      } else if (nextBranch !== branch || pollCwd !== cwd) {
        branch = nextBranch;
        const token = clearTarget();
        if (!active || generation !== token) return;
      }

      if (!branch) {
        const token = clearTarget();
        if (!active || generation !== token) return;
        repository = "";
        ciStatus = undefined;
        unresolvedThreadCount = 0;
        failures = 0;
        nextHealth = "ok";
        publish(nextHealth);
        return;
      }

      const discoveryGeneration = generation;
      const result = await discoverPullRequest(pi, pollCwd, branch);
      if (!active || pollCwd !== cwd || generation !== discoveryGeneration)
        return;
      repository = result.repository;
      if (result.authFailed || result.failed) {
        failures += 1;
        nextHealth = result.authFailed ? "unauthenticated" : "error";
        publish(nextHealth);
        return;
      }

      const nextPullRequest = result.pullRequest;
      if (!nextPullRequest) {
        const token = clearTarget();
        if (!active || generation !== token) return;
        failures = 0;
        nextHealth = "ok";
        publish(nextHealth);
        return;
      }
      const restore = pendingResume;
      if (
        restore &&
        (!samePullRequest(restore.target, nextPullRequest.target) ||
          nextPullRequest.lifecycle !== "open")
      ) {
        const token = endWatch();
        if (!active || generation !== token) return;
      }
      if (
        !discovered ||
        !samePullRequest(discovered.target, nextPullRequest.target)
      ) {
        // A matching pending restore is transferred to this discovered target.
        const token = clearTarget(!pendingResume);
        if (!active || generation !== token) return;
      }
      discovered = nextPullRequest;
      if (
        restore &&
        samePullRequest(restore.target, discovered.target) &&
        discovered.lifecycle === "open"
      ) {
        pendingResume = undefined;
        watching = true;
        resumeBaseline = true;
        seen = new Set(restore.feedbackIds);
        seenCi = new Set(restore.ciFailureIds);
        const token = generation;
        reportWatch(discovered.target);
        if (!active || generation !== token) return;
      }
      if (watching && discovered.lifecycle !== "open") {
        const token = endWatch();
        if (!active || generation !== token) return;
      }

      const target = discovered.target;
      const token = generation;
      const [ci, threads] = await Promise.all([
        fetchCiSnapshot(pi, pollCwd, target),
        (watching
          ? fetchFeedback(pi, pollCwd, target)
          : fetchThreadCount(pi, pollCwd, target)) as Promise<
          FetchOutcome<FeedbackSnapshot | ThreadCountSnapshot>
        >,
      ]);
      if (
        !active ||
        pollCwd !== cwd ||
        generation !== token ||
        discovered?.target.url !== target.url
      ) {
        return;
      }

      if (!threads.value) {
        failures += 1;
        nextHealth = threads.authFailed ? "unauthenticated" : "error";
        if (watching && ci.value) {
          ciStatus = ci.value.status;
          await deliverCi(ci.value, target, pollCwd, token);
          if (!active || generation !== token) return;
        }
        publish(nextHealth);
        return;
      }

      nextHealth = "ok";
      if (ci.value) {
        failures = 0;
        ciStatus = ci.value.status;
      } else {
        failures += 1;
        nextHealth = ci.authFailed ? "unauthenticated" : "error";
      }
      unresolvedThreadCount = threads.value.unresolvedThreadCount;
      if (threads.value.lifecycle)
        discovered.lifecycle = threads.value.lifecycle;

      if (
        watching &&
        discovered.lifecycle === "open" &&
        isFeedbackSnapshot(threads.value)
      ) {
        const snapshot = threads.value;
        const fresh = (
          resumeBaseline ? snapshot.openFeedback : snapshot.feedback
        ).filter((item) => !seen.has(item.id));
        if (resumeBaseline) {
          seen = new Set(snapshot.feedback.map((item) => item.id));
          resumeBaseline = false;
        } else {
          for (const item of snapshot.feedback) seen.add(item.id);
        }
        const external = fresh.filter(
          (item) =>
            !snapshot.viewerLogin || item.author !== snapshot.viewerLogin,
        );
        if (external.length > 0) {
          try {
            onFeedback(target, external);
          } catch {
            // Feedback consumers must not break the polling loop.
          }
        }
      }

      if (!active || generation !== token) return;
      // Watching a pull request ends when the pull request does.
      if (watching && discovered.lifecycle !== "open") {
        const endedToken = endWatch();
        if (!active || generation !== endedToken) return;
        publish(nextHealth);
        return;
      }
      if (ci.value) await deliverCi(ci.value, target, pollCwd, token);
      if (!active || generation !== token) return;

      publish(nextHealth);
    } catch {
      failures += 1;
      nextHealth = "error";
      publish(nextHealth);
    } finally {
      cycleRunning = false;
      // A watch/unwatch may already have scheduled a newer timer. Preserve it.
      // If it fired while this cycle was busy, restart using the latest health.
      if (active && restartRequested && !pendingWatch) {
        // A new session must not wait an idle interval for stale work to drain.
        if (timer !== undefined) timers.clear(timer);
        timer = undefined;
        void cycle();
      } else if (!pendingWatch && timer === undefined) {
        schedule(state?.health ?? nextHealth);
      }
    }
  };

  return {
    start: (nextCwd, resume) => {
      active = true;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      cwd = nextCwd;
      branch = "";
      branchInitialized = false;
      repository = "";
      failures = 0;
      pendingWatch = undefined;
      clearTarget(false);
      restartRequested = cycleRunning;
      pendingResume = resume
        ? {
            target: { ...resume.target },
            feedbackIds: [...resume.feedbackIds],
            ciFailureIds: [...resume.ciFailureIds],
          }
        : undefined;
      void cycle();
    },
    stop: () => {
      active = false;
      restartRequested = false;
      pendingWatch = undefined;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      clearTarget(false);
      state = undefined;
    },
    setCwd: (nextCwd) => {
      if (nextCwd === cwd) return;
      cwd = nextCwd;
      branch = "";
      branchInitialized = false;
      clearTarget();
    },
    watch: async (nextCwd, onReady) => {
      active = true;
      let token = ++generation;
      const request = {};
      pendingWatch = request;
      try {
        const cancelled = (): WatchResult => ({
          ok: false,
          error: "Watching was canceled",
        });
        // A failed manual retry must not erase a saved intent or its baseline.
        // Supersede it only after success or a confirmed checkout/target change.
        const cwdChanged = cwd !== nextCwd;
        cwd = nextCwd;

        const nextBranch = await currentBranch(pi, nextCwd);
        if (!active || generation !== token) return cancelled();
        if (!nextBranch) {
          token = clearTarget();
          if (!active || generation !== token) return cancelled();
          return { ok: false, error: "No branch is checked out" };
        }
        if (!branchInitialized && !cwdChanged) {
          branch = nextBranch;
        } else if (nextBranch !== branch || cwdChanged) {
          branch = nextBranch;
          token = clearTarget();
          if (!active || generation !== token) return cancelled();
        }
        branchInitialized = true;

        const result = await discoverPullRequest(pi, nextCwd, branch);
        if (!active || generation !== token) return cancelled();
        repository = result.repository;
        if (result.authFailed || result.failed) {
          return {
            ok: false,
            error: result.authFailed
              ? "GitHub authentication failed; run gh auth login"
              : "Failed to resolve the current pull request from GitHub",
          };
        }
        if (!result.pullRequest) {
          token = clearTarget();
          if (!active || generation !== token) return cancelled();
          return {
            ok: false,
            error: "No pull request found for the current branch",
          };
        }
        if (
          !discovered ||
          !samePullRequest(discovered.target, result.pullRequest.target)
        ) {
          const restore =
            pendingResume &&
            samePullRequest(pendingResume.target, result.pullRequest.target) &&
            result.pullRequest.lifecycle === "open"
              ? pendingResume
              : undefined;
          token = clearTarget(!restore);
          if (!active || generation !== token) return cancelled();
          pendingResume = restore;
        }
        discovered = result.pullRequest;
        if (discovered.lifecycle !== "open") {
          token = endWatch();
          if (!active || generation !== token) return cancelled();
          return {
            ok: false,
            error: `The pull request is ${discovered.lifecycle}`,
          };
        }

        const target = discovered.target;
        const [snapshot, ci] = await Promise.all([
          fetchFeedback(pi, nextCwd, target),
          fetchCiSnapshot(pi, nextCwd, target),
        ]);
        if (!active || generation !== token) return cancelled();
        if (!snapshot.value) {
          return {
            ok: false,
            error: snapshot.authFailed
              ? "GitHub authentication failed; run gh auth login"
              : "Failed to read pull request feedback from GitHub",
          };
        }

        if (snapshot.value.lifecycle && snapshot.value.lifecycle !== "open") {
          discovered.lifecycle = snapshot.value.lifecycle;
          token = endWatch();
          if (!active || generation !== token) return cancelled();
          publish("ok");
          return {
            ok: false,
            error: `The pull request is ${snapshot.value.lifecycle}`,
          };
        }
        watching = true;
        pendingResume = undefined;
        resumeBaseline = false;
        unresolvedThreadCount = snapshot.value.unresolvedThreadCount;
        seen = new Set(snapshot.value.feedback.map((item) => item.id));
        if (ci.value) ciStatus = ci.value.status;
        reportWatch(target);
        if (!active || generation !== token) return cancelled();

        const health = ci.value
          ? "ok"
          : ci.authFailed
            ? "unauthenticated"
            : "error";
        publish(health);
        if (!active || generation !== token) return cancelled();
        onReady?.();
        if (!active || generation !== token) return cancelled();
        if (snapshot.value.openFeedback.length > 0) {
          onFeedback(target, snapshot.value.openFeedback);
        }
        if (ci.value) await deliverCi(ci.value, target, nextCwd, token);
        if (!active || generation !== token) return cancelled();
        return { ok: true, target };
      } finally {
        if (pendingWatch === request) {
          pendingWatch = undefined;
          schedule(state?.health ?? "ok");
        }
      }
    },
    unwatch: () => {
      // Cancelling an in-flight watch or restore counts as stopping it.
      const hadIntent = watching || pendingResume !== undefined;
      const wasPending = pendingWatch !== undefined;
      pendingWatch = undefined;
      const token = endWatch();
      if (!hadIntent && wasPending) reportWatch(undefined);
      if (active && generation === token && (hadIntent || wasPending)) {
        publish("ok");
        schedule("ok");
      }
      return hadIntent || wasPending;
    },
    isWatching: () => watching,
    currentState: () => state,
  };
}
