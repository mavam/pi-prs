import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CiFailureEvent,
  PullRequestStateEvent,
  PullRequestTarget,
  ReviewFeedback,
} from "./api.ts";
import { parseCiSnapshot } from "./ci.ts";
import { createPoller, type ResumeWatch } from "./poller.ts";

const target: PullRequestTarget = {
  host: "github.com",
  owner: "acme",
  name: "repo",
  number: 1,
  url: "https://github.com/acme/repo/pull/1",
};

function check(name: string) {
  return {
    __typename: "StatusContext",
    context: name,
    state: "FAILURE",
    createdAt: "2026-01-01T00:00:00Z",
    targetUrl: "https://ci.example/failure",
  };
}

function ciSnapshot(names: string[]) {
  return JSON.stringify({
    headRefOid: "sha-1",
    state: "OPEN",
    statusCheckRollup: names.map(check),
  });
}

function resume(): ResumeWatch {
  return {
    target,
    feedbackIds: ["delivered"],
    ciFailureIds: parseCiSnapshot(ciSnapshot(["delivered"]), target.url)!
      .failures.map((failure) => failure.id),
  };
}

function comment(id: string, author = "reviewer") {
  return {
    id,
    body: `Feedback ${id}`,
    url: `${target.url}#${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    author: { login: author },
  };
}

function thread(id: string, isResolved = false, author = "reviewer") {
  return { isResolved, comments: { nodes: [comment(id, author)] } };
}

function response(stdout: string, code = 0, stderr = "") {
  return { stdout, code, stderr };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "expected asynchronous operation to complete");
}

function harness(onWatchChange?: (value: PullRequestTarget | undefined) => void) {
  const scenario = {
    branch: "feature",
    target: { ...target },
    lifecycle: "OPEN",
    feedbackLifecycle: "OPEN",
    noPr: false,
    discoveryError: "",
    feedbackError: "",
    checks: ["delivered"],
    threads: [thread("delivered"), thread("historical-resolved", true)],
    comments: [comment("historical-conversation")],
    reviews: [comment("historical-review")],
    discoveryGate: undefined as Promise<void> | undefined,
    feedbackGate: undefined as Promise<void> | undefined,
  };
  const feedback: ReviewFeedback[][] = [];
  const ci: CiFailureEvent[] = [];
  const states: PullRequestStateEvent[] = [];
  const changes: Array<PullRequestTarget | undefined> = [];
  const order: string[] = [];
  const timers = new Map<number, () => void>();
  let handle = 0;
  let discoveryCalls = 0;
  let feedbackCalls = 0;
  const pi = {
    exec: async (command: string, args: string[]) => {
      if (command === "git") {
        if (args.includes("symbolic-ref")) return response(scenario.branch);
        if (args.includes("rev-parse")) return response("origin/feature");
        if (args.includes("config")) {
          return response("remote.origin.url https://github.com/acme/repo.git");
        }
      }
      if (command === "gh" && args[0] === "pr") {
        if (args.includes("headRefOid,state,statusCheckRollup")) {
          return response(ciSnapshot(scenario.checks));
        }
        if (args.includes("headRefOid,state")) {
          return response(JSON.stringify({ headRefOid: "sha-1", state: scenario.lifecycle }));
        }
        return response("", 1, scenario.discoveryError || "no pull requests found");
      }
      if (command === "gh" && args[0] === "api") {
        const query = args.find((arg) => arg.startsWith("query=")) ?? "";
        if (query.includes("headRefName")) {
          discoveryCalls++;
          await scenario.discoveryGate;
          if (scenario.discoveryError) return response("", 1, scenario.discoveryError);
          return response(JSON.stringify({
            data: { repository: { open: { nodes: scenario.noPr ? [] : [{
              number: scenario.target.number,
              url: scenario.target.url,
              state: scenario.lifecycle,
              headRefOid: "sha-1",
              headRepositoryOwner: { login: "acme" },
            }] } } },
          }));
        }
        if (query.includes("viewer { login }")) {
          feedbackCalls++;
          await scenario.feedbackGate;
          if (scenario.feedbackError) return response("", 1, scenario.feedbackError);
        }
        return response(JSON.stringify({
          data: {
            viewer: { login: "me" },
            repository: { pullRequest: {
              state: scenario.feedbackLifecycle,
              comments: { nodes: scenario.comments },
              reviews: { nodes: scenario.reviews },
              reviewThreads: { nodes: scenario.threads },
            } },
          },
        }));
      }
      assert.fail(`Unexpected command: ${command} ${args.join(" ")}`);
    },
    sendMessage: () => assert.fail("restoring must not inject instructions"),
    sendUserMessage: () => assert.fail("restoring must not inject instructions"),
  } as unknown as ExtensionAPI;
  const poller = createPoller({
    pi,
    onState: (value) => { states.push(value); },
    onFeedback: (_target, value) => { feedback.push(value); order.push("feedback"); },
    onCiFailure: (value) => { ci.push(value); order.push("ci"); },
    onWatchChange: (value) => {
      changes.push(value);
      order.push(value ? "watch" : "unwatch");
      onWatchChange?.(value);
    },
    timers: {
      set: (callback) => { timers.set(++handle, callback); return handle; },
      clear: (id) => { timers.delete(id as number); },
    },
  });
  const settled = () => until(() => timers.size > 0);
  const tick = async () => {
    const entry = timers.entries().next().value;
    assert.ok(entry, "expected a scheduled poll");
    timers.delete(entry[0]);
    entry[1]();
    await settled();
  };
  return {
    poller, scenario, feedback, ci, states, changes, order, settled, tick,
    discoveryCalls: () => discoveryCalls,
    feedbackCalls: () => feedbackCalls,
    timerCount: () => timers.size,
  };
}

test("restoring the same PR does not replay delivered feedback or CI", async () => {
  const h = harness();
  h.poller.start("/repo", resume());
  await h.settled();
  assert.equal(h.poller.isWatching(), true);
  assert.equal(h.states.at(-1)?.pullRequest?.watching, true);
  assert.deepEqual(h.changes, [target]);
  assert.deepEqual(h.feedback, []);
  assert.deepEqual(h.ci, []);
  await h.tick();
  assert.deepEqual(h.feedback, []);
  assert.deepEqual(h.ci, []);
  h.poller.stop();
  assert.deepEqual(h.changes, [target]);
});

test("restore emits offline unresolved feedback and current CI, then uses the full baseline", async () => {
  const h = harness();
  h.scenario.threads.push(thread("offline"), thread("self", false, "me"));
  h.scenario.checks.push("offline");
  h.poller.start("/repo", resume());
  await h.settled();
  assert.deepEqual(h.feedback.flat().map((item) => item.id), ["offline"]);
  assert.deepEqual(h.ci.flatMap((event) => event.failures.map((item) => item.name)), ["offline"]);
  assert.deepEqual(h.order, ["watch", "feedback", "ci"]);
  // Historical conversation/review/resolved IDs were baselined, not delivered.
  await h.tick();
  assert.equal(h.feedback.length, 1);
  assert.equal(h.ci.length, 1);
  h.scenario.comments.push(comment("later-conversation"));
  h.scenario.threads.push(thread("later-resolved", true));
  await h.tick();
  assert.deepEqual(h.feedback[1]?.map((item) => item.id), ["later-conversation", "later-resolved"]);
  h.poller.stop();
});

test("resume IDs describe delivered transcript entries, not the previous poller's queued output", async () => {
  const h = harness();
  h.scenario.threads.push(thread("queued"));
  h.scenario.checks.push("queued");
  h.poller.start("/repo", resume());
  await h.settled();
  h.poller.stop();
  h.feedback.length = 0;
  h.ci.length = 0;
  // Neither queued output was added to the actual session transcript.
  h.poller.start("/repo", resume());
  await h.settled();
  assert.deepEqual(h.feedback.flat().map((item) => item.id), ["queued"]);
  assert.deepEqual(h.ci.flatMap((event) => event.failures.map((item) => item.name)), ["queued"]);
  h.poller.stop();
});

test("resume compares repository identity case-insensitively, not URL spelling", async () => {
  const h = harness();
  const saved = resume();
  saved.target = { ...target, host: "GITHUB.COM", owner: "Acme", name: "Repo", url: "https://github.com/Acme/Repo/pull/1/" };
  h.poller.start("/repo", saved);
  await h.settled();
  assert.equal(h.poller.isWatching(), true);
  assert.deepEqual(h.feedback, []);
  assert.deepEqual(h.ci, []);
  h.poller.stop();
});

for (const mismatch of ["number", "repository", "host", "closed", "merged", "no-pr", "no-branch"]) {
  test(`restore cancels ${mismatch} without any delivery`, async () => {
    const h = harness();
    if (mismatch === "number") h.scenario.target = { ...target, number: 2, url: "https://github.com/acme/repo/pull/2" };
    if (mismatch === "repository") h.scenario.target = { ...target, name: "other", url: "https://github.com/acme/other/pull/1" };
    if (mismatch === "host") h.scenario.target = { ...target, host: "github.enterprise.com", url: "https://github.enterprise.com/acme/repo/pull/1" };
    if (mismatch === "closed" || mismatch === "merged") h.scenario.lifecycle = mismatch.toUpperCase();
    if (mismatch === "no-pr") h.scenario.noPr = true;
    if (mismatch === "no-branch") h.scenario.branch = "";
    h.scenario.threads.push(thread("fresh"));
    h.scenario.checks.push("fresh");
    h.poller.start("/repo", resume());
    await h.settled();
    assert.equal(h.poller.isWatching(), false);
    assert.deepEqual(h.changes, [undefined]);
    assert.deepEqual(h.feedback, []);
    assert.deepEqual(h.ci, []);
    assert.equal(h.feedbackCalls(), 0);
    // Returning to the saved target must not resurrect canceled intent.
    h.scenario.target = { ...target };
    h.scenario.lifecycle = "OPEN";
    h.scenario.noPr = false;
    h.scenario.branch = "feature";
    await h.tick();
    assert.equal(h.poller.isWatching(), false);
    assert.deepEqual(h.changes, [undefined]);
    assert.deepEqual(h.feedback, []);
    assert.deepEqual(h.ci, []);
    h.poller.stop();
  });
}

for (const error of ["HTTP 401: Bad credentials", "network unavailable"]) {
  test(`restore retries transient discovery failure: ${error}`, async () => {
    const h = harness();
    h.scenario.discoveryError = error;
    h.scenario.threads.push(thread("fresh"));
    h.poller.start("/repo", resume());
    await h.settled();
    assert.equal(h.poller.isWatching(), false);
    assert.equal(h.states.at(-1)?.health, error.includes("401") ? "unauthenticated" : "error");
    assert.deepEqual(h.changes, []);
    assert.deepEqual(h.ci, []);
    await h.tick();
    assert.deepEqual(h.changes, []);
    h.scenario.discoveryError = "";
    await h.tick();
    assert.equal(h.poller.isWatching(), true);
    assert.deepEqual(h.changes, [target]);
    assert.deepEqual(h.feedback.flat().map((item) => item.id), ["fresh"]);
    h.poller.stop();
  });
}

for (const phase of ["discovery", "feedback"]) {
  test(`failed manual watch during ${phase} preserves pending resume intent`, async () => {
    const h = harness();
    h.scenario.discoveryError = "network unavailable";
    h.scenario.threads.push(thread("fresh"));
    h.poller.start("/repo", resume());
    await h.settled();
    if (phase === "feedback") {
      h.scenario.discoveryError = "";
      h.scenario.feedbackError = "network unavailable";
    }
    assert.equal((await h.poller.watch("/repo")).ok, false);
    assert.deepEqual(h.changes, []);
    assert.equal(h.poller.isWatching(), false);
    h.scenario.discoveryError = "";
    h.scenario.feedbackError = "";
    await h.tick();
    assert.equal(h.poller.isWatching(), true);
    assert.deepEqual(h.changes, [target]);
    assert.deepEqual(h.feedback.flat().map((item) => item.id), ["fresh"]);
    assert.deepEqual(h.ci, []);
    h.poller.stop();
  });
}

test("failed manual watch preserves the unresolved-only baseline after restore matched", async () => {
  const h = harness();
  h.scenario.feedbackError = "network unavailable";
  h.scenario.threads.push(thread("fresh"));
  h.poller.start("/repo", resume());
  await h.settled();
  assert.equal(h.poller.isWatching(), true);
  assert.equal((await h.poller.watch("/repo")).ok, false);
  assert.deepEqual(h.changes, [target]);
  h.scenario.feedbackError = "";
  await h.tick();
  assert.deepEqual(h.feedback.flat().map((item) => item.id), ["fresh"]);
  assert.deepEqual(h.ci, []);
  await h.tick();
  assert.equal(h.feedback.length, 1);
  h.poller.stop();
});

test("feedback snapshot failure retains the initial unresolved-only baseline while CI can arrive", async () => {
  const h = harness();
  h.scenario.feedbackError = "HTTP 401: Bad credentials";
  h.scenario.threads.push(thread("fresh"));
  h.scenario.checks.push("fresh");
  h.poller.start("/repo", resume());
  await h.settled();
  assert.equal(h.poller.isWatching(), true);
  assert.equal(h.feedback.length, 0);
  assert.equal(h.ci.length, 1);
  await h.tick();
  h.scenario.feedbackError = "";
  await h.tick();
  assert.deepEqual(h.feedback.flat().map((item) => item.id), ["fresh"]);
  assert.equal(h.ci.length, 1);
  await h.tick();
  assert.equal(h.feedback.length, 1);
  h.poller.stop();
});

for (const change of ["branch", "cwd", "unwatch"]) {
  test(`${change} cancels pending resume after a discovery error`, async () => {
    const h = harness();
    h.scenario.discoveryError = "network unavailable";
    h.poller.start("/repo", resume());
    await h.settled();
    if (change === "branch") h.scenario.branch = "other";
    if (change === "cwd") h.poller.setCwd("/other");
    if (change === "unwatch") assert.equal(h.poller.unwatch(), true);
    await h.tick();
    assert.deepEqual(h.changes, [undefined]);
    h.scenario.discoveryError = "";
    await h.tick();
    assert.equal(h.poller.isWatching(), false);
    assert.deepEqual(h.feedback, []);
    assert.deepEqual(h.ci, []);
    assert.equal(h.poller.unwatch(), false);
    h.poller.stop();
  });
}

test("unwatch cancels in-flight resume discovery", async () => {
  const h = harness();
  const gate = deferred();
  h.scenario.discoveryGate = gate.promise;
  h.poller.start("/repo", resume());
  await until(() => h.discoveryCalls() === 1);
  assert.equal(h.poller.unwatch(), true);
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.tick();
  assert.equal(h.poller.isWatching(), false);
  assert.deepEqual(h.changes, [undefined]);
  assert.deepEqual(h.feedback, []);
  assert.deepEqual(h.ci, []);
  h.poller.stop();
});

test("stop preserves pending intent without reporting unwatch", async () => {
  const h = harness();
  h.scenario.discoveryError = "network unavailable";
  h.poller.start("/repo", resume());
  await h.settled();
  h.poller.stop();
  assert.deepEqual(h.changes, []);
  assert.equal(h.timerCount(), 0);
});

test("explicit watch overrides pending resume and retains onReady ordering", async () => {
  const h = harness();
  h.scenario.discoveryError = "network unavailable";
  h.poller.start("/repo", resume());
  await h.settled();
  h.scenario.discoveryError = "";
  h.scenario.target = { ...target, number: 2, url: "https://github.com/acme/repo/pull/2" };
  const result = await h.poller.watch("/repo", () => { h.order.push("ready"); });
  assert.equal(result.ok, true);
  assert.deepEqual(h.changes, [undefined, h.scenario.target]);
  assert.deepEqual(h.order, ["unwatch", "watch", "ready", "feedback", "ci"]);
  assert.deepEqual(h.feedback.flat().map((item) => item.id), ["delivered"]);
  h.poller.stop();
});

for (const mode of ["resume", "watch"]) {
  test(`reentrant unwatch during ${mode} intent notification prevents delivery`, async () => {
    const h = harness((value) => { if (value) h.poller.unwatch(); });
    h.scenario.threads.push(thread("fresh"));
    h.scenario.checks.push("fresh");
    if (mode === "resume") {
      h.poller.start("/repo", resume());
      await h.settled();
    } else {
      assert.equal((await h.poller.watch("/repo")).ok, false);
    }
    assert.equal(h.poller.isWatching(), false);
    assert.deepEqual(h.changes, [target, undefined]);
    assert.deepEqual(h.feedback, []);
    assert.deepEqual(h.ci, []);
    await h.tick();
    assert.deepEqual(h.changes, [target, undefined]);
    h.poller.stop();
  });
}

test("throwing watch-intent consumers cannot break polling or delivery", async () => {
  const h = harness(() => { throw new Error("consumer failed"); });
  h.scenario.threads.push(thread("fresh"));
  h.poller.start("/repo", resume());
  await h.settled();
  assert.equal(h.poller.isWatching(), true);
  assert.deepEqual(h.feedback.flat().map((item) => item.id), ["fresh"]);
  assert.equal(h.poller.unwatch(), true);
  await h.tick();
  assert.equal(h.poller.isWatching(), false);
  assert.deepEqual(h.changes, [target, undefined]);
  h.poller.stop();
});

for (const phase of ["discovery", "feedback"]) {
  test(`stop/start while old ${phase} is in flight promptly runs the new resume`, async () => {
    const h = harness();
    const gate = deferred();
    if (phase === "discovery") h.scenario.discoveryGate = gate.promise;
    else h.scenario.feedbackGate = gate.promise;
    h.poller.start("/repo", resume());
    await until(() => phase === "discovery" ? h.discoveryCalls() === 1 : h.feedbackCalls() === 1);
    h.poller.stop();
    h.changes.length = 0;
    h.scenario.threads.push(thread("fresh"));
    h.poller.start("/repo", resume());
    gate.resolve();
    // No timer tick: completing stale work must immediately refresh the session.
    await h.settled();
    assert.deepEqual(h.ci, []);
    assert.equal(h.poller.isWatching(), true);
    assert.deepEqual(h.changes, [target]);
    assert.deepEqual(h.feedback.flat().map((item) => item.id), ["fresh"]);
    assert.equal(h.timerCount(), 1);
    h.poller.stop();
  });
}

for (const phase of ["discovery", "feedback"]) {
  test(`a closed PR reported by ${phase} ends active watch intent`, async () => {
    const h = harness();
    h.poller.start("/repo", resume());
    await h.settled();
    if (phase === "discovery") h.scenario.lifecycle = "CLOSED";
    h.scenario.feedbackLifecycle = "CLOSED";
    h.scenario.threads.push(thread("fresh"));
    h.scenario.checks.push("fresh");
    await h.tick();
    assert.equal(h.poller.isWatching(), false);
    assert.deepEqual(h.changes, [target, undefined]);
    assert.deepEqual(h.feedback, []);
    assert.deepEqual(h.ci, []);
    h.poller.stop();
  });
}
