import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CiFailureEvent, FeedbackEvent, PullRequestTarget } from "./api.ts";
import { BABYSIT_MESSAGE_TYPE, BABYSIT_PROMPT } from "./babysit.ts";
import { CI_FAILURE_MESSAGE_TYPE } from "./ci-message.ts";
import { FEEDBACK_MESSAGE_TYPE } from "./message.ts";
import { restoreWatch, WATCH_STATE_TYPE } from "./watch-state.ts";

const target: PullRequestTarget = {
  host: "github.com", owner: "acme", name: "repo", number: 1,
  url: "https://github.com/acme/repo/pull/1",
};
const otherTarget: PullRequestTarget = { ...target, number: 2, url: "https://github.com/acme/repo/pull/2" };

function feedback(session: SessionManager, pr = target, id = "review-1") {
  const details: FeedbackEvent = {
    protocol: 1, source: "pi-prs", target: pr,
    feedback: [{ id, kind: "inline", author: "reviewer", body: "A finding", url: `${pr.url}#discussion_r1`, createdAt: "2026-01-01T00:00:00Z" }],
  };
  session.appendCustomMessageEntry(FEEDBACK_MESSAGE_TYPE, "A finding", true, details);
}
function ci(session: SessionManager, pr = target, id = "check-1") {
  const details: CiFailureEvent = {
    protocol: 1, source: "pi-prs", target: pr, headRefOid: "sha-1",
    failures: [{ id, name: "test", workflow: "CI", conclusion: "FAILURE", url: "https://ci.example/test" }],
  };
  session.appendCustomMessageEntry(CI_FAILURE_MESSAGE_TYPE, "A failed check", true, details);
}
function watch(session: SessionManager, pr: PullRequestTarget | null = target) {
  return session.appendCustomEntry(WATCH_STATE_TYPE, { version: 1, target: pr });
}

test("watch intent restores delivered IDs only for the saved pull request", () => {
  const session = SessionManager.inMemory();
  watch(session);
  feedback(session);
  feedback(session);
  feedback(session, otherTarget, "other-review");
  ci(session);
  ci(session, otherTarget, "other-check");
  session.appendCustomMessageEntry(BABYSIT_MESSAGE_TYPE, BABYSIT_PROMPT, true);
  assert.deepEqual(restoreWatch(session.getBranch()), {
    target, feedbackIds: ["review-1"], ciFailureIds: ["check-1"],
  });
});

test("a saved watch without persisted deliveries does not mark queued feedback as seen", () => {
  const session = SessionManager.inMemory();
  watch(session);
  assert.deepEqual(restoreWatch(session.getBranch()), { target, feedbackIds: [], ciFailureIds: [] });
});

test("latest unwatch wins over prior watch intent and subsequent feedback", () => {
  const session = SessionManager.inMemory();
  watch(session);
  watch(session, null);
  feedback(session);
  assert.equal(restoreWatch(session.getBranch()), undefined);
  watch(session);
  assert.deepEqual(restoreWatch(session.getBranch())?.feedbackIds, ["review-1"]);
});

test("restoring a session branch ignores watch changes and deliveries on abandoned branches", () => {
  const session = SessionManager.inMemory();
  const root = watch(session);
  feedback(session);
  watch(session, null);
  session.branch(root);
  assert.deepEqual(restoreWatch(session.getBranch()), { target, feedbackIds: [], ciFailureIds: [] });
  session.resetLeaf();
  session.appendCustomEntry("unrelated", {});
  assert.equal(restoreWatch(session.getBranch()), undefined);
});

test("legacy sessions do not imply watch intent from feedback or babysitting alone", () => {
  const session = SessionManager.inMemory();
  feedback(session);
  ci(session);
  session.appendCustomMessageEntry(BABYSIT_MESSAGE_TYPE, BABYSIT_PROMPT, true);
  // Old releases never recorded /pr unwatch, so automatic restoration would
  // guess at consent. A plain /pr watch records intent without new instructions.
  assert.equal(restoreWatch(session.getBranch()), undefined);
});

for (const data of [
  undefined, null, {}, { version: 2, target }, { version: 1, target: "wrong" },
  { version: 1, target: { ...target, number: 2 } },
  { version: 1, target: { ...target, url: "not-a-url" } },
  { version: 1, target: { ...target, host: 42 } },
]) {
  test(`invalid latest watch state fails closed: ${JSON.stringify(data)}`, () => {
    const session = SessionManager.inMemory();
    watch(session);
    session.appendCustomEntry(WATCH_STATE_TYPE, data);
    assert.equal(restoreWatch(session.getBranch()), undefined);
  });
}

test("malformed feedback details do not break restoration", () => {
  const session = SessionManager.inMemory();
  watch(session);
  session.appendCustomMessageEntry(FEEDBACK_MESSAGE_TYPE, "invalid", true, { feedback: [null] });
  session.appendCustomMessageEntry(CI_FAILURE_MESSAGE_TYPE, "invalid", true, null);
  session.appendCustomMessageEntry(FEEDBACK_MESSAGE_TYPE, "invalid target", true, {
    protocol: 1, source: "pi-prs", target: {}, feedback: [],
  });
  session.appendCustomMessageEntry(FEEDBACK_MESSAGE_TYPE, "invalid findings", true, {
    protocol: 1, source: "pi-prs", target, feedback: [null, 42, {}, { id: 42 }],
  });
  assert.deepEqual(restoreWatch(session.getBranch()), { target, feedbackIds: [], ciFailureIds: [] });
});

test("pull request identity is case-insensitive but repository-specific", () => {
  const session = SessionManager.inMemory();
  watch(session);
  feedback(session, { ...target, host: "GITHUB.COM", owner: "ACME", name: "Repo" });
  ci(session, { ...target, name: "another-repo" });
  assert.deepEqual(restoreWatch(session.getBranch()), { target, feedbackIds: ["review-1"], ciFailureIds: [] });
});
