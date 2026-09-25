import assert from "node:assert/strict";
import test from "node:test";
import { parseCiSnapshot } from "./ci.ts";

const PR_URL = "https://github.com/org/repo/pull/42";

function status(checks: unknown[]) {
  return parseCiSnapshot(
    JSON.stringify({
      headRefOid: "sha",
      state: "OPEN",
      statusCheckRollup: checks,
    }),
    PR_URL,
  )?.status;
}

function run(
  conclusion: string,
  url: string,
  startedAt: string,
  completedAt: string,
  runStatus = "COMPLETED",
) {
  return {
    __typename: "CheckRun",
    name: "test",
    status: runStatus,
    conclusion,
    detailsUrl: url,
    startedAt,
    completedAt,
  };
}

test("footer status keeps a failed PR check when a later check passes", () => {
  assert.deepEqual(
    status([
      run(
        "FAILURE",
        "https://github.com/org/repo/actions/runs/1/job/1",
        "2026-01-01T09:00:00Z",
        "2026-01-01T09:30:00Z",
      ),
      run(
        "SUCCESS",
        "https://github.com/org/repo/actions/runs/2/job/2",
        "2026-01-01T10:00:00Z",
        "2026-01-01T10:30:00Z",
      ),
    ]),
    {
      state: "failed",
      url: "https://github.com/org/repo/actions/runs/1/job/1",
    },
  );
});

test("footer status reports running when no PR check failed", () => {
  assert.deepEqual(
    status([
      run(
        "SUCCESS",
        "https://github.com/org/repo/actions/runs/3/job/3",
        "2026-01-01T09:00:00Z",
        "2026-01-01T09:30:00Z",
      ),
      run(
        "",
        "https://github.com/org/repo/actions/runs/4/job/4",
        "2026-01-01T10:00:00Z",
        "",
        "IN_PROGRESS",
      ),
    ]),
    {
      state: "running",
      url: "https://github.com/org/repo/actions/runs/4/job/4",
    },
  );
});

test("footer status reports okay for passing and skipped checks", () => {
  assert.deepEqual(
    status([
      run(
        "SKIPPED",
        "https://github.com/org/repo/actions/runs/5/job/5",
        "2026-01-01T09:00:00Z",
        "2026-01-01T09:01:00Z",
      ),
      {
        __typename: "StatusContext",
        context: "external",
        state: "SUCCESS",
        targetUrl: "https://ci.example.com/check/6",
        createdAt: "2026-01-01T10:30:00Z",
      },
    ]),
    { state: "okay", url: "https://ci.example.com/check/6" },
  );
});

test("footer status treats cancelled checks as failed", () => {
  assert.deepEqual(
    status([run("CANCELLED", "", "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z")]),
    { state: "failed", url: PR_URL },
  );
});

test("footer status is absent without checks", () => {
  assert.equal(status([]), undefined);
});
