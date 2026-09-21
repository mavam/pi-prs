import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_PR_CI_FAILURE_CHANNEL, type CiFailureEvent } from "./api.ts";
import { CI_FAILURE_MESSAGE_TYPE } from "./ci-message.ts";
import extension from "./index.ts";

const event: CiFailureEvent = {
  protocol: 1,
  source: "pi-prs",
  headRefOid: "abcdef123456",
  target: {
    host: "github.com",
    owner: "acme",
    name: "repo",
    number: 1,
    url: "https://github.com/acme/repo/pull/1",
  },
  failures: [
    {
      id: "job-1",
      name: "test",
      workflow: "CI",
      conclusion: "FAILURE",
      url: "https://github.com/acme/repo/actions/runs/1/job/1",
      log: "expected true, got false",
    },
  ],
};

test("CI events use steering delivery, compact rendering, and session cleanup", async () => {
  const listeners = new Map<string, (raw: unknown) => void>();
  const lifecycle = new Map<string, (...args: any[]) => void>();
  const renderers = new Map<string, (...args: any[]) => any>();
  const messages: Array<{ message: any; options: any }> = [];
  const pi = {
    events: {
      on: (name: string, callback: (raw: unknown) => void) => {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
      emit: (name: string, raw: unknown) => listeners.get(name)?.(raw),
    },
    on: (name: string, callback: (...args: any[]) => void) =>
      lifecycle.set(name, callback),
    registerMessageRenderer: (
      name: string,
      callback: (...args: any[]) => any,
    ) => renderers.set(name, callback),
    registerCommand: () => {},
    sendMessage: (message: any, options: any) =>
      messages.push({ message, options }),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI;
  await extension(pi);
  pi.events.emit(PI_PR_CI_FAILURE_CHANNEL, event);
  assert.equal(messages.length, 0, "no injection before session startup");
  lifecycle.get("session_start")!({}, { cwd: "/repo" });
  pi.events.emit(PI_PR_CI_FAILURE_CHANNEL, { ...event, failures: [] });
  pi.events.emit(PI_PR_CI_FAILURE_CHANNEL, { ...event, failures: [null] });
  pi.events.emit(PI_PR_CI_FAILURE_CHANNEL, event);
  assert.equal(messages.length, 1);
  const { message, options } = messages[0]!;
  assert.equal(message.customType, CI_FAILURE_MESSAGE_TYPE);
  assert.equal(message.display, true);
  assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
  assert.match(message.content, /expected true, got false/);

  const theme = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
  };
  const renderer = renderers.get(CI_FAILURE_MESSAGE_TYPE)!;
  const compact = renderer(message, { expanded: false, outputPad: 1 }, theme)
    .render(80)
    .join("\n");
  const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme)
    .render(80)
    .join("\n");
  assert.match(compact, /CI \/ test/);
  assert.doesNotMatch(compact, /expected true/);
  assert.match(expanded, /expected true/);
  lifecycle.get("session_shutdown")!({});
  assert.equal(listeners.has(PI_PR_CI_FAILURE_CHANNEL), false);
  pi.events.emit(PI_PR_CI_FAILURE_CHANNEL, event);
  assert.equal(messages.length, 1);
});
