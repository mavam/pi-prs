import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { isPullRequestStateEvent, PI_PR_STATE_CHANNEL, type PullRequestStateEvent } from "./api.ts";
import { BABYSIT_MESSAGE_TYPE, BABYSIT_PROMPT } from "./babysit.ts";
import { CI_FAILURE_MESSAGE_TYPE } from "./ci-message.ts";
import extension from "./index.ts";
import { FEEDBACK_MESSAGE_TYPE } from "./message.ts";
import { WATCH_STATE_TYPE } from "./watch-state.ts";

// Use the SDK's actual command dispatch, input hooks, queues, message conversion,
// and agent loop. Only subprocesses and the model transport are replaced.
type Stream = Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
type ModelContext = Parameters<AgentSession["agent"]["streamFunction"]>[1];
type Assistant = Awaited<ReturnType<Stream["result"]>>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function modelText(context: ModelContext) {
  return context.messages.map((message) =>
    typeof message.content === "string"
      ? message.content
      : message.content.map((part) => "text" in part ? part.text : "").join("\n"),
  );
}

interface SetupOptions {
  persist?: boolean;
  sessionFile?: string;
  sessionManager?: SessionManager;
  branch?: string;
  batch?: number;
  number?: number;
  feedbackBatches?: number[];
  resolvedBatches?: number[];
  ciBatches?: number[];
  holdInitialModel?: boolean;
}

async function setup(
  t: TestContext,
  followUpMode: "all" | "one-at-a-time" = "one-at-a-time",
  options: SetupOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-prs-delivery-"));
  const restored = options.sessionManager ?? (options.sessionFile ? SessionManager.open(options.sessionFile) : undefined);
  const cwd = restored?.getCwd() ?? join(root, "workspace");
  const agentDir = join(root, "agent");
  const gates: ReturnType<typeof deferred>[] = [];
  const gate = () => {
    const value = deferred();
    gates.push(value);
    return value;
  };
  let session: AgentSession | undefined;
  const errors: unknown[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Release even deliberately blocked legacy input hooks on assertion failure.
    for (const pending of gates) pending.resolve();
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  };
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, [], "the real SDK must not swallow extension errors");
  });
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir)]);
  const settingsManager = SettingsManager.inMemory({
    followUpMode,
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "model-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("delivery-test", {
    api: "openai-completions",
    baseUrl: "https://delivery-test.invalid",
    apiKey: "not-a-real-key",
    models: [{
      id: "fake",
      name: "Fake model (no network)",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 1024,
    }],
  });
  const model = modelRuntime.getModel("delivery-test", "fake");
  assert.ok(model);

  const calls: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const userCalls: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
  const babysitInputs: string[] = [];
  const inputRelease = gate();
  const lifecycle: string[] = [];
  const states: PullRequestStateEvent[] = [];
  const initialPoll = gate();
  const state = {
    // Existing delivery tests start with a silent poll; resumed boots discover a PR.
    branch: options.branch ?? "",
    batch: options.batch ?? 1,
    number: options.number ?? 1,
    feedbackBatches: options.feedbackBatches,
    resolvedBatches: options.resolvedBatches ?? [],
    ciBatches: options.ciBatches,
    beforeFeedback: undefined as (() => Promise<void>) | undefined,
  };
  const url = () => `https://github.com/acme/repo/pull/${state.number}`;
  const response = (value: unknown) => ({
    code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", killed: false,
  });
  const metadata = () => ({
    number: state.number, url: url(), state: "OPEN", headRefOid: `sha-${state.batch}`,
    headRepositoryOwner: { login: "acme" },
  });
  const exec: ExtensionAPI["exec"] = async (name, args) => {
    if (name === "git") {
      if (args.includes("symbolic-ref")) return response(state.branch);
      if (args.includes("rev-parse")) return response("origin/feature");
      if (args.includes("config"))
        return response("remote.origin.url https://github.com/acme/repo.git");
    }
    if (name === "gh" && args[0] === "api") {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.includes("headRefName"))
        return response({ data: { repository: { open: { nodes: [metadata()] } } } });
      if (query.includes("body")) await state.beforeFeedback?.();
      return response({ data: { repository: { pullRequest: {
        state: "OPEN",
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: (state.feedbackBatches ?? [state.batch]).map((batch) => ({
            isResolved: state.resolvedBatches.includes(batch),
            comments: { nodes: [{
              id: `comment-${batch}`,
              body: `Review finding ${batch}: please fix this.`,
              author: { login: "reviewer" },
              url: `${url()}#discussion_r${batch}`,
              createdAt: "2026-01-01T00:00:00Z",
            }] },
          })),
        },
      } } } });
    }
    if (name === "gh" && args[0] === "pr" && args[1] === "view") {
      return response({
        ...metadata(),
        statusCheckRollup: (state.ciBatches ?? [state.batch]).map((batch) => ({
          __typename: "CheckRun", name: `failed-check-${batch}`,
          status: "COMPLETED", conclusion: "FAILURE",
          detailsUrl: "https://ci.example/test",
        })),
      });
    }
    throw new Error(`Unexpected subprocess: ${name} ${args.join(" ")}`);
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    systemPrompt: "You are a fake model in a delivery regression test.",
    extensionFactories: [async (pi) => {
      pi.events.on(PI_PR_STATE_CHANNEL, (event) => {
        assert.ok(isPullRequestStateEvent(event));
        states.push(event);
        initialPoll.resolve();
      });
      pi.on("input", async (event) => {
        if (event.text === BABYSIT_PROMPT) {
          babysitInputs.push(event.text);
          // The old sendUserMessage path suspends here, while feedback overtakes
          // it. Custom messages must bypass input hooks entirely.
          await inputRelease.promise;
        }
        return { action: "continue" };
      });
      pi.on("agent_start", () => { lifecycle.push("start"); });
      pi.on("agent_end", () => { lifecycle.push("end"); });
      await extension({
        ...pi,
        exec,
        sendMessage: (...args) => { calls.push(args); pi.sendMessage(...args); },
        sendUserMessage: (...args) => { userCalls.push(args); pi.sendUserMessage(...args); },
      });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model, settingsManager, resourceLoader,
    sessionManager: restored ?? (options.persist
      ? SessionManager.create(cwd, join(root, "sessions"))
      : SessionManager.inMemory(cwd)),
    tools: [],
  }));
  const contexts: ModelContext[] = [];
  const initialModel = options.holdInitialModel ? { entered: gate(), release: gate() } : undefined;
  let nextModel: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined = initialModel;
  session.agent.streamFunction = async (selectedModel, context) => {
    contexts.push(structuredClone(context));
    const blocked = nextModel;
    nextModel = undefined;
    blocked?.entered.resolve();
    if (blocked) await blocked.release.promise;
    const message: Assistant = {
      role: "assistant", content: [{ type: "text", text: "Done." }],
      api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop", timestamp: Date.now(),
    };
    // The loop consumes only the async iterable and result(); no pi-ai import
    // or real provider stream is needed for this transport stub.
    return {
      async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; },
      result: async () => message,
    } as unknown as Stream;
  };
  await session.bindExtensions({ onError: (error) => { errors.push(error); } });
  await initialPoll.promise;
  if (!restored) {
    assert.equal(calls.length, 0, "a fresh session must not deliver feedback");
    assert.equal(contexts.length, 0);
  }
  state.branch = options.branch ?? "feature";
  return {
    session, state, calls, userCalls, babysitInputs, contexts, lifecycle, gate,
    states, close, initialModel,
    holdNextModel() {
      assert.equal(nextModel, undefined);
      nextModel = { entered: gate(), release: gate() };
      return nextModel;
    },
  };
}

function assertInstructionsBeforeFeedback(contexts: ModelContext[]) {
  let feedbackContexts = 0;
  for (const context of contexts) {
    const texts = modelText(context);
    for (const marker of ["Review finding 1:", "failed-check-1"]) {
      const feedback = texts.findIndex((text) => text.includes(marker));
      if (feedback < 0) continue;
      feedbackContexts++;
      const instructions = texts.findIndex((text) => text.includes(BABYSIT_PROMPT));
      assert.ok(instructions >= 0 && instructions < feedback,
        `model received ${marker} without preceding babysitting instructions`);
    }
  }
  assert.ok(feedbackContexts > 0, "the model must actually receive feedback");
  const last = modelText(contexts.at(-1)!);
  assert.ok(last.some((text) => text.includes("Review finding 1:")));
  assert.ok(last.some((text) => text.includes("failed-check-1")));
}

function assertCustomDelivery(h: Awaited<ReturnType<typeof setup>>) {
  assert.deepEqual(h.userCalls, [], "babysitting must not use the async user-input route");
  assert.deepEqual(h.babysitInputs, [], "custom instructions must bypass input hooks");
  assert.deepEqual(h.calls.map(([message]) => message.customType), [
    BABYSIT_MESSAGE_TYPE, FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
  ]);
  assert.equal(h.calls[0]![0].content, BABYSIT_PROMPT);
  assert.equal(h.calls[0]![0].display, true);
  for (const [, options] of h.calls)
    assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
}

for (const mode of ["one-at-a-time", "all"] as const) {
  test(`real SDK: busy babysitting bypasses async input and preserves already queued user follow-ups (${mode})`, { timeout: 10000 }, async (t) => {
    const h = await setup(t, mode);
    const model = h.holdNextModel();
    const running = h.session.prompt("Work already in progress");
    await model.entered.promise;
    // This input has finished preflight and is already queued before /pr watch.
    // No priority is promised over user inputs submitted later.
    await h.session.followUp("Previously queued user request");
    await h.session.prompt("/pr watch --babysit");
    assert.equal(h.contexts.length, 1, "watch must not interrupt the current model call");
    model.release.resolve();
    await running;
    await h.session.waitForIdle();

    // Assert model-visible order first: API call order alone misses the old bug.
    assertInstructionsBeforeFeedback(h.contexts);
    const texts = modelText(h.contexts.at(-1)!);
    const userRequest = texts.findIndex((text) => text.includes("Previously queued user request"));
    const instructions = texts.findIndex((text) => text.includes(BABYSIT_PROMPT));
    assert.ok(userRequest >= 0 && userRequest < instructions,
      "the already queued user request must reach the model before babysitting");
    assertCustomDelivery(h);
  });
}

test("real SDK: idle babysitting starts with instructions and delivers each feedback message once", { timeout: 10000 }, async (t) => {
  const h = await setup(t);
  await h.session.prompt("/pr watch --babysit");
  await h.session.waitForIdle();
  assertInstructionsBeforeFeedback(h.contexts);
  assert.ok(modelText(h.contexts[0]!).some((text) => text.includes(BABYSIT_PROMPT)));
  assertCustomDelivery(h);
  const expected = [BABYSIT_MESSAGE_TYPE, FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE];
  assert.deepEqual(h.session.messages.filter((message) => message.role === "custom")
    .map((message) => message.customType), expected);
  assert.deepEqual(h.session.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom_message")
    .map((entry) => entry.customType), expected);
});

test("real SDK: a busy session becoming idle during GitHub fetch still receives instructions first", { timeout: 10000 }, async (t) => {
  const h = await setup(t);
  const model = h.holdNextModel();
  const running = h.session.prompt("Finish existing work");
  await model.entered.promise;
  const fetching = h.gate();
  const fetched = h.gate();
  h.state.beforeFeedback = async () => { fetching.resolve(); await fetched.promise; };
  const watching = h.session.prompt("/pr watch --babysit");
  await fetching.promise;
  assert.deepEqual(h.calls, [], "instructions must wait for a successful watch");
  model.release.resolve();
  await running;
  assert.equal(h.session.isStreaming, false);
  assert.deepEqual(h.calls, [], "agent_end must not release anything during discovery");
  fetched.resolve();
  await watching;
  await h.session.waitForIdle();
  assertInstructionsBeforeFeedback(h.contexts);
  assertCustomDelivery(h);
});

test("real SDK: repeated babysitting and plain watch do not replay instructions on agent lifecycle events", { timeout: 10000 }, async (t) => {
  const h = await setup(t);
  for (const [index, command] of ["/pr watch --babysit", "/pr watch --babysit", "/pr watch"].entries()) {
    h.state.batch = index + 1;
    await h.session.prompt(command);
    await h.session.waitForIdle();
  }
  const expected = [
    BABYSIT_MESSAGE_TYPE, FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
    BABYSIT_MESSAGE_TYPE, FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
    FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
  ];
  assert.deepEqual(h.calls.map(([message]) => message.customType), expected);
  assert.deepEqual(h.userCalls, []);
  await h.session.prompt("/pr unwatch");
  const starts = h.lifecycle.filter((event) => event === "start").length;
  await h.session.prompt("An unrelated later turn");
  await h.session.waitForIdle();
  assert.equal(h.lifecycle.filter((event) => event === "start").length, starts + 1);
  assert.equal(h.lifecycle.filter((event) => event === "end").length, starts + 1);
  assert.deepEqual(h.calls.map(([message]) => message.customType), expected);
  assert.deepEqual(h.session.messages.filter((message) => message.role === "custom")
    .map((message) => message.customType), expected);
  const texts = modelText(h.contexts.at(-1)!);
  assert.equal(texts.filter((text) => text.includes(BABYSIT_PROMPT)).length, 2);
  for (let batch = 1; batch <= 3; batch++) {
    assert.equal(texts.filter((text) => text.includes(`Review finding ${batch}:`)).length, 1);
    assert.equal(texts.filter((text) => text.includes(`failed-check-${batch}`)).length, 1);
  }
  await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(h.calls.map(([message]) => message.customType), expected);
});

test("real SDK: unwatch during fetch cancels delivery even across unrelated agent start/end", { timeout: 10000 }, async (t) => {
  const h = await setup(t);
  const fetching = h.gate();
  const fetched = h.gate();
  h.state.beforeFeedback = async () => { fetching.resolve(); await fetched.promise; };
  const watching = h.session.prompt("/pr watch --babysit");
  await fetching.promise;
  await h.session.prompt("Unrelated work while GitHub is pending");
  assert.deepEqual(h.calls, [], "agent_start must not deliver before GitHub succeeds");
  await h.session.prompt("/pr unwatch");
  fetched.resolve();
  await watching;
  await h.session.prompt("Another unrelated turn after cancellation");
  await h.session.waitForIdle();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.userCalls, []);
  assert.equal(h.contexts.length, 2);
  assert.ok(h.contexts.every((context) => modelText(context).every((text) =>
    !text.includes(BABYSIT_PROMPT) && !text.includes("Review finding") && !text.includes("failed-check"))));
});

function watchEntries(h: Awaited<ReturnType<typeof setup>>) {
  return h.session.sessionManager.getBranch()
    .flatMap((entry) => entry.type === "custom" && entry.customType === WATCH_STATE_TYPE ? [entry.data] : []);
}

async function savedWatch(t: TestContext) {
  const h = await setup(t, "one-at-a-time", { persist: true });
  // The SDK only flushes a new session's header after an actual assistant turn.
  await h.session.prompt("Start reviewing this pull request");
  await h.session.prompt("/pr watch --babysit");
  await h.session.waitForIdle();
  assertCustomDelivery(h);
  const target = h.states.at(-1)!.pullRequest!.target;
  assert.deepEqual(watchEntries(h), [{ version: 1, target }]);
  const sessionFile = h.session.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  return { h, sessionFile, target };
}

for (const mode of ["one-at-a-time", "all"] as const) {
  test(`real SDK: reopening a watched session delivers only new offline findings and CI (${mode})`, { timeout: 10000 }, async (t) => {
    const { h, sessionFile, target } = await savedWatch(t);
    const persisted = h.session.sessionManager.getBranch()
      .filter((entry) => entry.type === "custom_message");
    assert.deepEqual(persisted.map((entry) => entry.customType), [
      BABYSIT_MESSAGE_TYPE, FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
    ]);
    assert.ok(persisted[1]!.details, "review IDs must come from actual persisted delivery details");
    assert.ok(persisted[2]!.details, "CI IDs must come from actual persisted delivery details");
    await h.close();
    assert.deepEqual(watchEntries(h), [{ version: 1, target }], "shutdown must preserve watch intent");

    const snapshot = {
      sessionFile, branch: "feature",
      // Keep the same head so failed-check-1 retains its execution identity.
      feedbackBatches: [1, 2, 3], resolvedBatches: [3], ciBatches: [1, 2],
    };
    const resumed = await setup(t, mode, { ...snapshot, holdInitialModel: true });
    assert.notEqual(resumed.session, h.session);
    assert.notEqual(resumed.session.sessionManager, h.session.sessionManager);
    assert.equal(resumed.session.sessionManager.getSessionFile(), sessionFile);
    assert.equal(resumed.states.at(-1)!.pullRequest!.watching, true);
    assert.deepEqual(resumed.calls.map(([message]) => message.customType), [
      FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
    ], "resume must not enqueue babysitting instructions");
    assert.deepEqual(resumed.userCalls, []);
    assert.deepEqual(resumed.babysitInputs, []);
    const feedback = resumed.calls[0]![0].content;
    const ci = resumed.calls[1]![0].content;
    assert.equal(typeof feedback, "string");
    assert.equal(typeof ci, "string");
    assert.match(feedback as string, /Review finding 2:/);
    assert.doesNotMatch(feedback as string, /Review finding [13]:/);
    assert.match(ci as string, /failed-check-2/);
    assert.doesNotMatch(ci as string, /failed-check-1/);
    await resumed.initialModel!.entered.promise;
    resumed.initialModel!.release.resolve();
    await resumed.session.waitForIdle();

    const texts = modelText(resumed.contexts.at(-1)!);
    assert.equal(texts.filter((text) => text.includes(BABYSIT_PROMPT)).length, 1);
    for (const batch of [1, 2]) {
      assert.equal(texts.filter((text) => text.includes(`Review finding ${batch}:`)).length, 1);
      assert.equal(texts.filter((text) => text.includes(`failed-check-${batch}`)).length, 1);
    }
    assert.ok(texts.every((text) => !text.includes("Review finding 3:")),
      "the first resumed snapshot must exclude already resolved offline feedback");
    const deliveries = resumed.session.sessionManager.getBranch()
      .filter((entry) => entry.type === "custom_message");
    // JSONL omits optional undefined properties such as babysitting details.
    assert.deepEqual(deliveries.slice(0, persisted.length), JSON.parse(JSON.stringify(persisted)));
    assert.deepEqual(deliveries.map((entry) => entry.customType), [
      BABYSIT_MESSAGE_TYPE, FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
      FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
    ]);
    assert.deepEqual(watchEntries(resumed), [{ version: 1, target }]);
    await resumed.close();

    // A second new extension/runtime proves the catch-up deliveries were saved,
    // rather than merely hidden by an in-memory poller deduplication set.
    const again = await setup(t, mode, snapshot);
    assert.equal(again.states.at(-1)!.pullRequest!.watching, true);
    assert.deepEqual(again.calls, []);
    assert.deepEqual(again.contexts, []);
    await again.session.prompt("Continue with unrelated work");
    await again.session.waitForIdle();
    assert.deepEqual(again.calls, []);
    assert.equal(modelText(again.contexts.at(-1)!).filter((text) => text.includes(BABYSIT_PROMPT)).length, 1);
    await again.close();
  });
}

test("real SDK: feedback queued but not persisted is recovered after reattachment", { timeout: 10000 }, async (t) => {
  const { h, sessionFile } = await savedWatch(t);
  const model = h.holdNextModel();
  const running = h.session.prompt("Work interrupted before follow-ups were consumed");
  await model.entered.promise;
  h.state.batch = 2;
  await h.session.prompt("/pr watch");
  assert.ok(h.calls.some(([message]) => String(message.content).includes("Review finding 2:")));
  assert.ok(h.session.sessionManager.getBranch().every((entry) =>
    entry.type !== "custom_message" || !String(entry.content).includes("Review finding 2:")));

  // Freeze the actual JSONL at the crash boundary, before cleanup can drain queues.
  const interruptedFile = `${sessionFile}.interrupted.jsonl`;
  await copyFile(sessionFile, interruptedFile);
  await h.close();
  await running;
  const resumed = await setup(t, "one-at-a-time", {
    sessionFile: interruptedFile, branch: "feature", batch: 2,
  });
  await resumed.session.waitForIdle();
  assert.deepEqual(resumed.calls.map(([message]) => message.customType), [
    FEEDBACK_MESSAGE_TYPE, CI_FAILURE_MESSAGE_TYPE,
  ]);
  const texts = modelText(resumed.contexts.at(-1)!);
  assert.equal(texts.filter((text) => text.includes(BABYSIT_PROMPT)).length, 1);
  assert.equal(texts.filter((text) => text.includes("Review finding 2:")).length, 1);
  assert.equal(texts.filter((text) => text.includes("failed-check-2")).length, 1);
  await resumed.close();
});

test("real SDK: unchanged saved watch resumes silently, but explicit babysitting still sends instructions", { timeout: 10000 }, async (t) => {
  const { h, sessionFile, target } = await savedWatch(t);
  await h.close();
  const resumed = await setup(t, "one-at-a-time", { sessionFile, branch: "feature" });
  assert.equal(resumed.states.at(-1)!.pullRequest!.watching, true);
  assert.deepEqual(resumed.calls, [], "persisted findings and CI must not be delivered twice");
  assert.deepEqual(resumed.contexts, [], "silent resume must not start a model turn");
  assert.deepEqual(watchEntries(resumed), [{ version: 1, target }]);

  resumed.state.batch = 2;
  await resumed.session.prompt("/pr watch --babysit");
  await resumed.session.waitForIdle();
  assertCustomDelivery(resumed);
  const texts = modelText(resumed.contexts.at(-1)!);
  assert.equal(texts.filter((text) => text.includes(BABYSIT_PROMPT)).length, 2,
    "an explicit request must still add new babysitting instructions");
  assert.equal(texts.filter((text) => text.includes("Review finding 1:")).length, 1);
  assert.equal(texts.filter((text) => text.includes("Review finding 2:")).length, 1);
  await resumed.close();
});

test("real SDK: explicit unwatch persists across reopening and suppresses offline delivery", { timeout: 10000 }, async (t) => {
  const { h, sessionFile, target } = await savedWatch(t);
  await h.session.prompt("/pr unwatch");
  const expected = [{ version: 1, target }, { version: 1, target: null }];
  assert.deepEqual(watchEntries(h), expected);
  await h.close();
  const resumed = await setup(t, "one-at-a-time", { sessionFile, branch: "feature", batch: 2 });
  assert.equal(resumed.states.at(-1)!.pullRequest!.watching, false);
  assert.deepEqual(watchEntries(resumed), expected);
  assert.deepEqual(resumed.calls, []);
  assert.deepEqual(resumed.contexts, []);
  await resumed.session.prompt("Unrelated work after unwatch");
  await resumed.session.waitForIdle();
  assert.deepEqual(resumed.calls, []);
  assert.ok(modelText(resumed.contexts.at(-1)!).every((text) =>
    !text.includes("Review finding 2:") && !text.includes("failed-check-2")));
  await resumed.close();
});

test("real SDK: saved intent never auto-watches a different pull request", { timeout: 10000 }, async (t) => {
  const { h, sessionFile } = await savedWatch(t);
  await h.close();
  const resumed = await setup(t, "one-at-a-time", {
    sessionFile, branch: "feature", number: 2, batch: 2,
  });
  const current = resumed.states.at(-1)!.pullRequest!;
  assert.equal(current.target.number, 2, "the fake discovery must really select the other PR");
  assert.equal(current.watching, false);
  assert.deepEqual(resumed.calls, []);
  assert.deepEqual(resumed.contexts, []);
  assert.deepEqual(watchEntries(resumed).at(-1), { version: 1, target: null });
  await resumed.close();
});

test("real SDK: a fresh session discovers the PR without inheriting watch intent", { timeout: 10000 }, async (t) => {
  const h = await setup(t, "one-at-a-time", { branch: "feature" });
  assert.equal(h.states.at(-1)!.pullRequest!.target.number, 1);
  assert.equal(h.states.at(-1)!.pullRequest!.watching, false);
  assert.deepEqual(watchEntries(h), []);
  assert.deepEqual(h.calls, []);
  await h.session.prompt("Ordinary work on this branch");
  await h.session.waitForIdle();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.userCalls, []);
  assert.ok(modelText(h.contexts.at(-1)!).every((text) =>
    !text.includes(BABYSIT_PROMPT) && !text.includes("Review finding") && !text.includes("failed-check")));
});
