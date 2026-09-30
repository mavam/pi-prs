import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryContext,
  parseMergeState,
  parsePullRequestUrl,
  parsePullRequestView,
  selectPullRequestFromGraphQL,
} from "./discovery.ts";

test("createRepositoryContext derives repository and lookup plan from remotes", () => {
  const context = createRepositoryContext(
    [
      "remote.origin.url https://github.com/me/repo.git",
      "remote.upstream.url https://github.com/org/repo.git",
    ].join("\n"),
    "origin/fix-ci",
  );

  assert.equal(context.repository, "me/repo");
  assert.deepEqual(context.plan, {
    baseRepositories: [
      { host: "github.com", owner: "org", name: "repo", repository: "org/repo" },
      { host: "github.com", owner: "me", name: "repo", repository: "me/repo" },
    ],
    headOwners: ["me", "org"],
  });
});

test("createRepositoryContext supports GitHub Enterprise hosts and SSH ports", () => {
  assert.deepEqual(
    createRepositoryContext(
      "remote.origin.url git@github.example.com:org/repo.git",
      "origin/main",
    ).plan?.baseRepositories,
    [
      {
        host: "github.example.com",
        owner: "org",
        name: "repo",
        repository: "org/repo",
      },
    ],
  );
  assert.deepEqual(
    createRepositoryContext(
      "remote.origin.url ssh://git@github.example.com:2222/org/repo.git",
      "origin/main",
    ).plan?.baseRepositories,
    [
      {
        host: "github.example.com",
        owner: "org",
        name: "repo",
        repository: "org/repo",
      },
    ],
  );
});

test("createRepositoryContext excludes non-GitHub hosts", () => {
  const context = createRepositoryContext(
    [
      "remote.origin.url git@notgithub.com:org/repo.git",
      "remote.fork.url https://gitlab.com/org/repo.git",
    ].join("\n"),
    "origin/main",
  );

  assert.equal(context.repository, "");
  assert.equal(context.plan, undefined);
});

test("parsePullRequestUrl extracts owner, repository, and number", () => {
  assert.deepEqual(parsePullRequestUrl("https://github.com/org/repo/pull/42"), {
    host: "github.com",
    owner: "org",
    name: "repo",
    number: 42,
  });
  assert.deepEqual(
    parsePullRequestUrl("https://github.com/org/repo/pull/42#discussion_r1"),
    { host: "github.com", owner: "org", name: "repo", number: 42 },
  );
  assert.equal(
    parsePullRequestUrl("https://example.com/org/repo/pull/42"),
    undefined,
  );
});

test("parsePullRequestView reads state, draft, and auto-merge status", () => {
  assert.deepEqual(
    parsePullRequestView(
      JSON.stringify({
        number: 43,
        url: "https://github.com/org/repo/pull/43",
        state: "OPEN",
        isDraft: true,
        autoMergeRequest: { enabledAt: "2026-07-26T08:00:00Z" },
        mergeStateStatus: "BLOCKED",
        headRefOid: "abc123",
      }),
    ),
    {
      target: {
        host: "github.com",
        owner: "org",
        name: "repo",
        number: 43,
        url: "https://github.com/org/repo/pull/43",
      },
      lifecycle: "open",
      isDraft: true,
      autoMergeEnabled: true,
      mergeState: "blocked",
      headRefOid: "abc123",
      headOwner: "",
    },
  );
});

test("parseMergeState maps GitHub merge states", () => {
  const cases = [
    ["CLEAN", "mergeable"],
    ["HAS_HOOKS", "mergeable"],
    ["UNSTABLE", "mergeable"],
    ["clean", "mergeable"],
    ["DIRTY", "conflicting"],
    ["BLOCKED", "blocked"],
    ["BEHIND", "blocked"],
    ["DRAFT", "blocked"],
    ["UNKNOWN", "unknown"],
    ["SOMETHING_NEW", "unknown"],
    [undefined, "unknown"],
    [null, "unknown"],
  ] as const;
  for (const [value, expected] of cases) {
    assert.equal(parseMergeState(value), expected, String(value));
  }
});

test("parsePullRequestView keeps closed pull requests", () => {
  assert.equal(
    parsePullRequestView(
      JSON.stringify({
        number: 42,
        url: "https://github.com/org/repo/pull/42",
        state: "CLOSED",
      }),
    )?.lifecycle,
    "closed",
  );
});

test("selectPullRequestFromGraphQL accepts only known head owners", () => {
  const output = JSON.stringify({
    data: {
      repository: {
        open: {
          nodes: [
            {
              number: 42,
              url: "https://github.com/org/repo/pull/42",
              state: "OPEN",
              headRepositoryOwner: { login: "someone-else" },
            },
            {
              number: 7,
              url: "https://github.com/org/repo/pull/7",
              state: "OPEN",
              isDraft: true,
              autoMergeRequest: { enabledAt: "2026-07-26T08:00:00Z" },
              mergeStateStatus: "CLEAN",
              headRepositoryOwner: { login: "me" },
            },
          ],
        },
        merged: {
          nodes: [
            {
              number: 8,
              url: "https://github.com/org/repo/pull/8",
              state: "MERGED",
              headRepositoryOwner: { login: "me" },
            },
          ],
        },
      },
    },
  });

  assert.deepEqual(
    selectPullRequestFromGraphQL(output, ["me", "org"], "github.com"),
    {
      target: {
        host: "github.com",
        owner: "org",
        name: "repo",
        number: 7,
        url: "https://github.com/org/repo/pull/7",
      },
      lifecycle: "open",
      isDraft: true,
      autoMergeEnabled: true,
      mergeState: "mergeable",
      headRefOid: "",
    },
  );
  assert.equal(
    selectPullRequestFromGraphQL(output, ["unknown"], "github.com"),
    undefined,
  );
});

test("selectPullRequestFromGraphQL prefers the tracked owner before state", () => {
  const output = JSON.stringify({
    data: {
      repository: {
        open: {
          nodes: [
            {
              number: 9,
              url: "https://github.com/org/repo/pull/9",
              state: "OPEN",
              headRepositoryOwner: { login: "org" },
            },
          ],
        },
        merged: {
          nodes: [
            {
              number: 8,
              url: "https://github.com/org/repo/pull/8",
              state: "MERGED",
              headRepositoryOwner: { login: "me" },
            },
          ],
        },
      },
    },
  });

  assert.equal(
    selectPullRequestFromGraphQL(output, ["me", "org"], "github.com")?.target
      .number,
    8,
  );
});
