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
    icon: { glyphs: Record<string, string>; color: string };
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

test("colors draft, auto-merge, and merged pull requests", () => {
  const cases = [
    [{ ...openPullRequest, isDraft: true }, "dim"],
    [{ ...openPullRequest, autoMergeEnabled: true }, "warning"],
    [{ ...openPullRequest, lifecycle: "merged" as const }, "accent"],
    [{ ...openPullRequest, isDraft: true, autoMergeEnabled: true }, "dim"],
    [{ ...openPullRequest, lifecycle: "merged" as const, autoMergeEnabled: true }, "accent"],
    [openPullRequest, "success"],
  ] as const;

  for (const [pullRequest, color] of cases) {
    const { pi, messages } = fakePi();
    createFooterPublisher(pi).publish(state(pullRequest));
    assert.equal(messages[0]?.widget?.icon.color, color);
  }
});

test("swaps the review-thread glyph while watching", () => {
  const { pi, messages } = fakePi();
  const footer = createFooterPublisher(pi);

  footer.publish(state({ ...openPullRequest, unresolvedThreadCount: 3 }));
  const idle = messages.find((message) => message.widget?.id === "pi-prs.review-threads");
  assert.match(idle?.widget?.content.text ?? "", /3/);
  assert.equal(idle?.widget?.icon.color, "text");

  messages.length = 0;
  footer.publish(
    state({ ...openPullRequest, unresolvedThreadCount: 3, watching: true }),
  );
  const watching = messages.find(
    (message) => message.widget?.id === "pi-prs.review-threads",
  );
  assert.equal(watching?.widget?.icon.color, "text");
  assert.notEqual(
    watching?.widget?.icon.glyphs.nerd,
    idle?.widget?.icon.glyphs.nerd,
  );
});

test("keeps the review-thread widget visible while watching without findings", () => {
  const { pi, messages } = fakePi();
  createFooterPublisher(pi).publish(state({ ...openPullRequest, watching: true }));

  const widget = messages.find(
    (message) => message.widget?.id === "pi-prs.review-threads",
  )?.widget;
  assert.ok(widget);
  assert.equal(widget.content.text, "");
  assert.equal(widget.icon.color, "text");
});

test("publishes the CI widget only when a status exists", () => {
  const { pi, messages } = fakePi();
  const footer = createFooterPublisher(pi);

  footer.publish(state(openPullRequest));
  assert.equal(
    messages.some((message) => message.widget?.id === "pi-prs.ci"),
    false,
  );

  messages.length = 0;
  footer.publish(
    state({
      ...openPullRequest,
      ci: { state: "failed", url: "https://github.com/acme/repo/actions/runs/1" },
    }),
  );
  const ci = messages.find((message) => message.widget?.id === "pi-prs.ci");
  assert.equal(ci?.widget?.content.text, "");
  assert.equal(ci?.widget?.icon.color, "error");
  assert.equal(
    ci?.widget?.content.href,
    "https://github.com/acme/repo/actions/runs/1",
  );
});

test("omits invalid structured links without dropping widgets", () => {
  const { pi, messages } = fakePi();
  createFooterPublisher(pi).publish(
    state({
      ...openPullRequest,
      target: { ...openPullRequest.target, url: "javascript:alert(1)" },
      ci: { state: "running", url: "https://example.com/bad\nlink" },
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
      ci: { state: "failed" as const, url: "https://example.com/check" },
    }),
    health: "error" as const,
  };
  createFooterPublisher(pi).publish(degraded);

  assert.deepEqual(
    messages.map((message) => message.widget?.icon.color),
    ["dim", "dim", "dim"],
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
