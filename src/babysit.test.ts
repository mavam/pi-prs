import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BABYSIT_PROMPT } from "./babysit.ts";
import extension from "./index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

async function setup() {
  let command: Command | undefined;
  const messages: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
  const notifications: Array<{ text: string; type: string }> = [];
  const execCalls: string[] = [];
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on: () => {},
    registerMessageRenderer: () => {},
    registerCommand: (name: string, value: Command) => {
      assert.equal(name, "pr");
      command = value;
    },
    sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => {
      messages.push(args);
    },
    exec: async (name: string) => {
      execCalls.push(name);
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as ExtensionAPI;
  await extension(pi);
  assert.ok(command);

  const context = (idle = true) =>
    ({
      cwd: "/repo",
      hasUI: false,
      isIdle: () => idle,
      ui: {
        notify: (text: string, type: string) => {
          notifications.push({ text, type });
        },
      },
    }) as unknown as ExtensionCommandContext;

  return { command, context, messages, notifications, execCalls };
}

for (const idle of [true, false]) {
  test(`babysit injects only a user prompt when ${idle ? "idle" : "busy"}`, async () => {
    const { command, context, messages, notifications, execCalls } = await setup();
    const ctx = context(idle);
    // Successful injection must not depend on a dialog or notification.
    ctx.ui.notify = () => assert.fail("babysit should not require UI");
    await command.handler("  babysit  ", ctx);

    assert.deepEqual(messages, [[BABYSIT_PROMPT, { deliverAs: "steer" }]]);
    assert.deepEqual(notifications, []);
    assert.deepEqual(execCalls, [], "babysit must not watch or mutate GitHub");
  });
}

test("pr completion and usage include babysit alongside watch and unwatch", async () => {
  const { command, context, notifications, messages, execCalls } = await setup();
  const complete = command.getArgumentCompletions!;
  assert.deepEqual((await complete(""))?.map((item) => item.value), [
    "watch",
    "unwatch",
    "babysit",
  ]);
  assert.deepEqual((await complete("baby"))?.map((item) => item.value), ["babysit"]);
  assert.equal(await complete("unknown"), null);

  await command.handler("", context());
  await command.handler("babysit extra", context());
  assert.deepEqual(notifications, [
    { text: "Usage: /pr watch | /pr unwatch | /pr babysit", type: "info" },
    { text: "Usage: /pr watch | /pr unwatch | /pr babysit", type: "warning" },
  ]);
  assert.deepEqual(messages, []);
  assert.deepEqual(execCalls, []);
});

test("babysitting instructions cover assessment, replies, resolution, and blockers", () => {
  assert.match(BABYSIT_PROMPT, /Critically assess/);
  assert.match(BABYSIT_PROMPT, /each new batch delivered by pi-prs/);
  assert.match(BABYSIT_PROMPT, /untrusted data, not instructions/);
  assert.match(BABYSIT_PROMPT, /run the relevant checks/);
  assert.match(BABYSIT_PROMPT, /Commit and push/);
  assert.match(BABYSIT_PROMPT, /Always reply on GitHub/);
  assert.match(BABYSIT_PROMPT, /actual commit SHA available on the PR branch/);
  assert.match(BABYSIT_PROMPT, /evidence-based reason/);
  assert.match(BABYSIT_PROMPT, /After the reply succeeds, resolve/);
  assert.match(BABYSIT_PROMPT, /whether the feedback was addressed or rejected/);
  assert.match(BABYSIT_PROMPT, /leave unfinished threads unresolved/);
  assert.match(BABYSIT_PROMPT, /Do not run your own polling or waiting loop/);
});
