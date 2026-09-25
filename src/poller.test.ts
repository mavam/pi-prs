import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPoller, type Poller, type PollerTimer } from "./poller.ts";
import type { PullRequestStateEvent } from "./api.ts";

interface Scenario {
  metadataVersion: number;
  targetNumber: number;
  unresolvedThreadCount: number;
  failDiscovery: boolean;
  failDetails: boolean;
}

function response(code: number, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

function fakePi(scenario: Scenario): ExtensionAPI {
  return {
    exec: async (command: string, args: string[]) => {
      if (command === "git" && args.includes("symbolic-ref")) {
        return response(0, "feature\n");
      }
      if (command === "git" && args.includes("rev-parse")) {
        return response(0, "origin/feature\n");
      }
      if (command === "git" && args.includes("config")) {
        return response(
          0,
          "remote.origin.url https://github.com/acme/repo.git\n",
        );
      }
      if (
        command === "gh" &&
        args.includes("headRefOid,state,statusCheckRollup")
      ) {
        return response(
          0,
          JSON.stringify({
            headRefOid: `oid-${scenario.metadataVersion}`,
            state: "OPEN",
            statusCheckRollup: [
              {
                __typename: "CheckRun",
                status: "COMPLETED",
                conclusion: "FAILURE",
                detailsUrl: `https://github.com/acme/repo/actions/runs/${scenario.targetNumber}`,
                startedAt: "2026-01-01T10:00:00Z",
                completedAt: "2026-01-01T10:01:00Z",
              },
            ],
          }),
        );
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return response(1, "", "no pull requests found");
      }
      if (command === "gh" && args[0] === "api") {
        const query = args.find((arg) => arg.startsWith("query=")) ?? "";
        if (query.includes("headRefName")) {
          if (scenario.failDiscovery) {
            return response(1, "", "network unavailable");
          }
          const version = scenario.metadataVersion;
          const number = scenario.targetNumber;
          return response(
            0,
            JSON.stringify({
              data: {
                repository: {
                  open: {
                    nodes: [
                      {
                        number,
                        url: `https://github.com/acme/repo/pull/${number}`,
                        state: "OPEN",
                        isDraft: version > 1,
                        autoMergeRequest: version > 1 ? {} : null,
                        headRefOid: `oid-${version}`,
                        headRepositoryOwner: { login: "acme" },
                      },
                    ],
                  },
                  merged: { nodes: [] },
                },
              },
            }),
          );
        }
        if (scenario.failDetails) {
          return response(1, "", "network unavailable");
        }
        return response(
          0,
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  state: "OPEN",
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: Array.from(
                      { length: scenario.unresolvedThreadCount },
                      () => ({ isResolved: false }),
                    ),
                  },
                },
              },
            },
          }),
        );
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;
}

function createHarness(
  scenario: Scenario,
  afterState?: (state: PullRequestStateEvent) => void,
): {
  poller: Poller;
  states: PullRequestStateEvent[];
  runNextCycle(): void;
  delays: number[];
} {
  const states: PullRequestStateEvent[] = [];
  const scheduled: Array<() => void> = [];
  const delays: number[] = [];
  const timers: PollerTimer = {
    set: (callback, delay) => {
      scheduled.push(callback);
      delays.push(delay);
      return callback;
    },
    clear: () => {},
  };
  const poller = createPoller({
    pi: fakePi(scenario),
    onState: (state) => {
      states.push(state);
      afterState?.(state);
    },
    onFeedback: () => {},
    timers,
  });
  return {
    poller,
    states,
    delays,
    runNextCycle: () => {
      const callback = scheduled.shift();
      assert.ok(callback, "expected a scheduled poll cycle");
      callback();
    },
  };
}

async function waitForStates(
  states: PullRequestStateEvent[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100 && states.length < count; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(states.length, count);
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    metadataVersion: 1,
    targetNumber: 1,
    unresolvedThreadCount: 0,
    failDiscovery: false,
    failDetails: false,
    ...overrides,
  };
}

test("poll cycles refresh pull request metadata", async () => {
  const current = scenario();
  const harness = createHarness(current);
  harness.poller.start("/repo");
  await waitForStates(harness.states, 1);

  current.metadataVersion = 2;
  harness.runNextCycle();
  await waitForStates(harness.states, 2);

  assert.deepEqual(
    harness.states.map((state) => ({
      isDraft: state.pullRequest?.isDraft,
      autoMergeEnabled: state.pullRequest?.autoMergeEnabled,
      headRefOid: state.pullRequest?.headRefOid,
    })),
    [
      { isDraft: false, autoMergeEnabled: false, headRefOid: "oid-1" },
      { isDraft: true, autoMergeEnabled: true, headRefOid: "oid-2" },
    ],
  );
  harness.poller.stop();
});

test("unexpected callback errors do not stop the timer chain", async () => {
  let shouldThrow = true;
  const harness = createHarness(scenario(), () => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error("consumer failed");
    }
  });
  harness.poller.start("/repo");
  await waitForStates(harness.states, 1);

  harness.runNextCycle();
  await waitForStates(harness.states, 2);

  assert.equal(harness.states[1]?.health, "ok");
  harness.poller.stop();
});

test("discovery failures publish error health and back off", async () => {
  const harness = createHarness(scenario({ failDiscovery: true }));
  harness.poller.start("/repo");
  await waitForStates(harness.states, 1);

  assert.equal(harness.states[0]?.health, "error");
  assert.equal(harness.states[0]?.pullRequest, undefined);
  assert.equal(harness.delays[0], 120_000);
  harness.poller.stop();
});

test("changing targets clears old CI and thread state before errors", async () => {
  const current = scenario({ unresolvedThreadCount: 3 });
  const harness = createHarness(current);
  harness.poller.start("/repo");
  await waitForStates(harness.states, 1);
  assert.equal(harness.states[0]?.pullRequest?.unresolvedThreadCount, 3);
  assert.equal(harness.states[0]?.pullRequest?.ci?.state, "failed");

  current.targetNumber = 2;
  current.failDetails = true;
  harness.runNextCycle();
  await waitForStates(harness.states, 2);

  const next = harness.states[1];
  assert.equal(next?.health, "error");
  assert.equal(next?.pullRequest?.target.number, 2);
  assert.equal(next?.pullRequest?.unresolvedThreadCount, 0);
  assert.equal(next?.pullRequest?.ci, undefined);
  harness.poller.stop();
});
