import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_PR_PROTOCOL, type PullRequestStateEvent } from "./api.ts";
import { createFooterPublisher } from "./footer.ts";

interface WidgetMessage {
  type: "upsert" | "remove";
  id?: string;
  widget?: {
    id: string;
    content: { text: string; href?: string };
    icon: { glyphs: Record<string, string>; color?: string };
    layout: { row: number; position: number };
  };
}

function fakePi(): { pi: ExtensionAPI; messages: WidgetMessage[] } {
  const messages: WidgetMessage[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const pi = {
    events: {
      emit: (channel: string, payload: unknown) => {
        if (channel === "pi-fancy-footer:widget") {
          messages.push(payload as WidgetMessage);
        }
        for (const listener of listeners.get(channel) ?? []) listener(payload);
      },
      on: (channel: string, listener: (payload: unknown) => void) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(listener);
        listeners.set(channel, channelListeners);
        return () => channelListeners.delete(listener);
      },
    },
  } as unknown as ExtensionAPI;
  return { pi, messages };
}

function state(
  pullRequest: PullRequestStateEvent["pullRequest"],
): PullRequestStateEvent {
  return {
    protocol: PI_PR_PROTOCOL,
    source: "pi-prs",
    repository: "acme/repo",
    branch: "feature",
    health: "ok",
    ...(pullRequest ? { pullRequest } : {}),
    updatedAt: 0,
  };
}

const openPullRequest = {
  target: {
    host: "github.com",
    owner: "acme",
    name: "repo",
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
  },
  lifecycle: "open" as const,
  isDraft: false,
  autoMergeEnabled: false,
  mergeState: "mergeable" as const,
  headRefOid: "abc",
  unresolvedThreadCount: 0,
  watching: false,
};

test("publishes the number widget with a structured link", () => {
  const { pi, messages } = fakePi();
  createFooterPublisher(pi).publish(state(openPullRequest));

  assert.equal(messages.length, 1);
  const widget = messages[0]?.widget;
  assert.equal(widget?.id, "pi-prs.number");
  assert.equal(widget?.content.text, "7");
  assert.equal(widget?.content.href, openPullRequest.target.url);
  assert.deepEqual(widget?.layout, { row: 1, position: 3, align: "left" });
});

test("colors pull requests by whether they can merge", () => {
  const ci = (state: "running" | "failed" | "okay") => ({
    state,
    url: "https://github.com/acme/repo/actions/runs/1",
    failedCount: state === "failed" ? 1 : 0,
  });
  const cases = [
    ["mergeable", openPullRequest, "success"],
    ["mergeable with passing checks", { ...openPullRequest, ci: ci("okay") }, "success"],
    ["unknown merge state", { ...openPullRequest, mergeState: "unknown" as const }, "success"],
    ["pending checks", { ...openPullRequest, ci: ci("running") }, "warning"],
    [
      "pending required checks",
      { ...openPullRequest, mergeState: "blocked" as const, ci: ci("running") },
      "warning",
    ],
    ["blocked", { ...openPullRequest, mergeState: "blocked" as const }, "error"],
    ["conflicts", { ...openPullRequest, mergeState: "conflicting" as const }, "error"],
    [
      "conflicts with pending checks",
      { ...openPullRequest, mergeState: "conflicting" as const, ci: ci("running") },
      "error",
    ],
    ["failed checks", { ...openPullRequest, ci: ci("failed") }, "error"],
    [
      "failed checks on a mergeable PR",
      { ...openPullRequest, mergeState: "mergeable" as const, ci: ci("failed") },
      "error",
    ],
    ["auto-merge", { ...openPullRequest, autoMergeEnabled: true }, "success"],
    [
      "auto-merge with pending checks",
      { ...openPullRequest, autoMergeEnabled: true, ci: ci("running") },
      "warning",
    ],
    ["draft", { ...openPullRequest, isDraft: true }, "dim"],
    [
      "blocked draft",
      { ...openPullRequest, isDraft: true, mergeState: "blocked" as const },
      "dim",
    ],
    ["merged", { ...openPullRequest, lifecycle: "merged" as const }, "accent"],
    [
      "merged with stale checks",
      {
        ...openPullRequest,
        lifecycle: "merged" as const,
        mergeState: "blocked" as const,
        ci: ci("failed"),
      },
      "accent",
    ],
  ] as const;

  for (const [name, pullRequest, color] of cases) {
    const { pi, messages } = fakePi();
    createFooterPublisher(pi).publish(state(pullRequest));
    assert.equal(messages[0]?.widget?.id, "pi-prs.number", name);
    assert.equal(messages[0]?.widget?.icon.color, color, name);
  }
});

test("shows unresolved review threads with a comment icon", () => {
  const { pi, messages } = fakePi();
  createFooterPublisher(pi).publish(
    state({ ...openPullRequest, unresolvedThreadCount: 3 }),
  );

  const threads = messages.find(
    (message) => message.widget?.id === "pi-prs.review-threads",
  )?.widget;
  assert.equal(threads?.content.text, "3");
  // Neutral icons leave the color to the footer's default icon color.
  assert.equal(threads?.icon.color, undefined);
  assert.equal(
    messages.some((message) => message.widget?.id === "pi-prs.watching"),
    false,
  );
});

test("shows watching as its own icon, distinct from threads and failures", () => {
  const { pi, messages } = fakePi();
  createFooterPublisher(pi).publish(
    state({
      ...openPullRequest,
      unresolvedThreadCount: 3,
      watching: true,
      ci: {
        state: "failed",
        url: "https://github.com/acme/repo/actions/runs/1",
        failedCount: 2,
      },
    }),
  );

  const widgets = new Map(
    messages.map((message) => [message.widget?.id, message.widget]),
  );
  assert.deepEqual([...widgets.keys()], [
    "pi-prs.number",
    "pi-prs.review-threads",
    "pi-prs.ci-failures",
    "pi-prs.watching",
  ]);

  const watching = widgets.get("pi-prs.watching");
  assert.equal(watching?.content.text, "");
  assert.equal(watching?.icon.color, undefined);
  assert.equal(watching?.layout.position, 6);

  // The eye shares no glyph with the other icons, and unlike the failure
  // icon it doesn't claim a state color.
  const others = ["pi-prs.review-threads", "pi-prs.ci-failures"].map((id) => widgets.get(id));
  for (const other of others) {
    assert.notEqual(other?.icon.glyphs.nerd, watching?.icon.glyphs.nerd);
    assert.notEqual(other?.icon.glyphs.unicode, watching?.icon.glyphs.unicode);
  }
  assert.notEqual(widgets.get("pi-prs.ci-failures")?.icon.color, watching?.icon.color);
});

test("keeps the review-thread count when watching stops", () => {
  const { pi, messages } = fakePi();
  const footer = createFooterPublisher(pi);
  footer.publish(
    state({ ...openPullRequest, unresolvedThreadCount: 3, watching: true }),
  );
  messages.length = 0;

  footer.publish(state({ ...openPullRequest, unresolvedThreadCount: 3 }));
  assert.deepEqual(
    messages.filter((message) => message.type === "remove").map((m) => m.id),
    ["pi-prs.watching"],
  );
  assert.equal(
    messages.some((message) => message.widget?.id === "pi-prs.review-threads"),
    true,
  );
});

test("omits the review-thread widget while watching without findings", () => {
  const { pi, messages } = fakePi();
  createFooterPublisher(pi).publish(state({ ...openPullRequest, watching: true }));

  assert.deepEqual(
    messages.map((message) => message.widget?.id),
    ["pi-prs.number", "pi-prs.watching"],
  );
});

test("publishes the CI failures widget only for failed checks", () => {
  const url = "https://github.com/acme/repo/actions/runs/1";
  const { pi, messages } = fakePi();
  const footer = createFooterPublisher(pi);
  const isCiWidget = (message: WidgetMessage) =>
    message.widget?.id === "pi-prs.ci-failures";

  for (const ci of [
    undefined,
    { state: "running" as const, url, failedCount: 0 },
    { state: "okay" as const, url, failedCount: 0 },
  ]) {
    messages.length = 0;
    footer.publish(state({ ...openPullRequest, ...(ci ? { ci } : {}) }));
    assert.equal(messages.some(isCiWidget), false);
  }

  messages.length = 0;
  footer.publish(
    state({ ...openPullRequest, ci: { state: "failed", url, failedCount: 3 } }),
  );
  const ci = messages.find(isCiWidget);
  assert.equal(ci?.widget?.content.text, "3");
  assert.equal(ci?.widget?.icon.color, "error");
  assert.equal(ci?.widget?.content.href, url);
  assert.deepEqual(ci?.widget?.layout, { row: 1, position: 5, align: "left" });
});

test("removes the CI failures widget once checks stop failing", () => {
  const url = "https://github.com/acme/repo/actions/runs/1";
  const { pi, messages } = fakePi();
  const footer = createFooterPublisher(pi);

  footer.publish(
    state({ ...openPullRequest, ci: { state: "failed", url, failedCount: 1 } }),
  );
  messages.length = 0;

  footer.publish(
    state({ ...openPullRequest, ci: { state: "running", url, failedCount: 0 } }),
  );
  assert.deepEqual(
    messages.filter((message) => message.type === "remove").map((m) => m.id),
    ["pi-prs.ci-failures"],
  );
});

test("omits invalid structured links without dropping widgets", () => {
  const { pi, messages } = fakePi();
  createFooterPublisher(pi).publish(
    state({
      ...openPullRequest,
      target: { ...openPullRequest.target, url: "javascript:alert(1)" },
      ci: { state: "failed", url: "https://example.com/bad\nlink", failedCount: 1 },
    }),
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.widget?.content.href, undefined);
  assert.equal(messages[1]?.widget?.content.href, undefined);
});

test("dims widgets while GitHub state is degraded", () => {
  const { pi, messages } = fakePi();
  const degraded = {
    ...state({
      ...openPullRequest,
      unresolvedThreadCount: 2,
      watching: true,
      ci: {
        state: "failed" as const,
        url: "https://example.com/check",
        failedCount: 1,
      },
    }),
    health: "error" as const,
  };
  createFooterPublisher(pi).publish(degraded);

  assert.deepEqual(
    messages.map((message) => message.widget?.icon.color),
    ["dim", "dim", "dim", "dim"],
  );
});

test("re-publishes state when the footer becomes ready", () => {
  const { pi, messages } = fakePi();
  const footer = createFooterPublisher(pi);
  footer.publish(state(openPullRequest));
  messages.length = 0;

  pi.events.emit("pi-fancy-footer:ready", { protocol: 2 });
  assert.equal(messages.length, 0);

  pi.events.emit("pi-fancy-footer:ready", { protocol: 1 });
  assert.equal(messages[0]?.widget?.id, "pi-prs.number");
});

test("clear and dispose stop ready re-publication", () => {
  const cleared = fakePi();
  const clearedFooter = createFooterPublisher(cleared.pi);
  clearedFooter.publish(state(openPullRequest));
  cleared.messages.length = 0;
  clearedFooter.clear();
  assert.equal(cleared.messages[0]?.type, "remove");
  cleared.messages.length = 0;
  cleared.pi.events.emit("pi-fancy-footer:ready", { protocol: 1 });
  assert.equal(cleared.messages.length, 0);

  const disposed = fakePi();
  const disposedFooter = createFooterPublisher(disposed.pi);
  disposedFooter.publish(state(openPullRequest));
  disposed.messages.length = 0;
  disposedFooter.dispose();
  disposed.pi.events.emit("pi-fancy-footer:ready", { protocol: 1 });
  assert.equal(disposed.messages.length, 0);
});

test("removes widgets that no longer apply", () => {
  const { pi, messages } = fakePi();
  const footer = createFooterPublisher(pi);

  footer.publish(state({ ...openPullRequest, unresolvedThreadCount: 2 }));
  messages.length = 0;

  footer.publish(state(undefined));
  assert.deepEqual(
    messages.filter((message) => message.type === "remove").map((m) => m.id),
    ["pi-prs.number", "pi-prs.review-threads"],
  );
});

test("hides widgets for a closed pull request", () => {
  const { pi, messages } = fakePi();
  createFooterPublisher(pi).publish(
    state({ ...openPullRequest, lifecycle: "closed" }),
  );

  assert.equal(messages.length, 0);
});
