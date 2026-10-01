import assert from "node:assert/strict";
import test from "node:test";
import { parseCiSnapshot } from "./ci.ts";

const PR_URL = "https://github.com/org/repo/pull/42";

function snapshot(checks: unknown[]) {
  return parseCiSnapshot(
    JSON.stringify({
      headRefOid: "sha",
      state: "OPEN",
      statusCheckRollup: checks,
    }),
    PR_URL,
  )!;
}

function status(checks: unknown[]) {
  return snapshot(checks).status;
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
    workflowName: "CI",
    status: runStatus,
    conclusion,
    detailsUrl: url,
    startedAt,
    completedAt,
  };
}

function execution(
  conclusion: string,
  hour: string,
  overrides: Partial<ReturnType<typeof run>> = {},
) {
  return {
    ...run(
      conclusion,
      `https://ci.example.com/check/${hour}`,
      `2026-01-01T${hour}:00:00Z`,
      `2026-01-01T${hour}:01:00Z`,
    ),
    ...overrides,
  };
}

test("footer status keeps a failed PR check when a different check passes", () => {
  assert.deepEqual(
    status([
      run(
        "FAILURE",
        "https://github.com/org/repo/actions/runs/1/job/1",
        "2026-01-01T09:00:00Z",
        "2026-01-01T09:30:00Z",
      ),
      {
        ...run(
          "SUCCESS",
          "https://github.com/org/repo/actions/runs/2/job/2",
          "2026-01-01T10:00:00Z",
          "2026-01-01T10:30:00Z",
        ),
        name: "lint",
      },
    ]),
    {
      state: "failed",
      url: "https://github.com/org/repo/actions/runs/1/job/1",
      failedCount: 1,
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
      failedCount: 0,
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
    { state: "okay", url: "https://ci.example.com/check/6", failedCount: 0 },
  );
});

test("footer status treats cancelled checks as failed", () => {
  assert.deepEqual(
    status([run("CANCELLED", "", "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z")]),
    { state: "failed", url: PR_URL, failedCount: 1 },
  );
});

test("footer status counts every failed and canceled check", () => {
  const started = "2026-01-01T09:00:00Z";
  const done = "2026-01-01T09:30:00Z";
  const job = (id: number) => `https://github.com/org/repo/actions/runs/${id}/job/${id}`;
  const check = (id: number, conclusion: string, pending = false) => ({
    ...run(
      conclusion,
      job(id),
      started,
      pending ? "" : done,
      pending ? "IN_PROGRESS" : "COMPLETED",
    ),
    name: `job-${id}`,
  });
  assert.deepEqual(
    status([
      check(1, "FAILURE"),
      check(2, "TIMED_OUT"),
      check(3, "CANCELLED"),
      check(4, "SUCCESS"),
      check(5, "", true),
    ]),
    { state: "failed", url: job(1), failedCount: 3 },
  );
});

test("successful reruns replace failures and cancellations in either rollup order", () => {
  const passed = execution("SUCCESS", "10");
  for (const conclusion of ["FAILURE", "CANCELLED"]) {
    const old = execution(conclusion, "09");
    for (const checks of [[old, passed], [passed, old]]) {
      const value = snapshot(checks);
      assert.deepEqual(value.status, {
        state: "okay",
        url: passed.detailsUrl,
        failedCount: 0,
      });
      assert.deepEqual(value.failures, []);
    }
  }
});

test("running reruns replace old failures before they complete", () => {
  const old = execution("FAILURE", "09");
  const pending = execution("", "10", {
    status: "IN_PROGRESS",
    completedAt: "",
  });
  const value = snapshot([old, pending]);
  assert.deepEqual(value.status, {
    state: "running",
    url: pending.detailsUrl,
    failedCount: 0,
  });
  assert.deepEqual(value.failures, []);
});

test("rerun ordering uses start time, not an old run's later completion", () => {
  const old = execution("FAILURE", "09", {
    completedAt: "2026-01-01T11:00:00Z",
  });
  const passed = execution("SUCCESS", "10");
  assert.equal(snapshot([old, passed]).status?.state, "okay");
  assert.deepEqual(snapshot([old, passed]).failures, []);
});

test("completed checks without start times use their completion times", () => {
  const value = snapshot([
    execution("FAILURE", "09", { startedAt: "" }),
    execution("SUCCESS", "10", { startedAt: "" }),
  ]);
  assert.equal(value.status?.state, "okay");
  assert.deepEqual(value.failures, []);
});

test("same-named checks in different workflows and types remain independent", () => {
  const failed = execution("FAILURE", "09");
  const value = snapshot([
    failed,
    execution("SUCCESS", "10", { workflowName: "Other CI" }),
    {
      __typename: "StatusContext",
      context: "test",
      state: "SUCCESS",
      startedAt: "2026-01-01T11:00:00Z",
    },
  ]);
  assert.equal(value.status?.failedCount, 1);
  assert.equal(value.failures[0]?.url, failed.detailsUrl);
});

test("latest failed reruns supply the count, link, and feedback identity", () => {
  const old = execution("FAILURE", "09");
  const failed = execution("FAILURE", "10");
  const value = snapshot([failed, old]);
  assert.deepEqual(value.status, {
    state: "failed",
    url: failed.detailsUrl,
    failedCount: 1,
  });
  assert.deepEqual(value.failures, snapshot([failed]).failures);
});

test("legacy statuses accept gh's startedAt alias and raw createdAt", () => {
  for (const field of ["startedAt", "createdAt"]) {
    const value = snapshot([
      {
        __typename: "StatusContext",
        context: "external",
        state: "ERROR",
        [field]: "2026-01-01T09:00:00Z",
      },
      {
        __typename: "StatusContext",
        context: "external",
        state: "SUCCESS",
        [field]: "2026-01-01T10:00:00Z",
      },
    ]);
    assert.equal(value.status?.state, "okay");
    assert.deepEqual(value.failures, []);
  }
});

test("ambiguous or unnamed checks cannot suppress known failures", () => {
  const failed = execution("FAILURE", "09");
  for (const replacement of [
    execution("SUCCESS", "09", { detailsUrl: "https://ci.example.com/pass" }),
    execution("SUCCESS", "10", { startedAt: "", completedAt: "invalid" }),
    execution("SUCCESS", "10", { name: "" }),
    { ...execution("SUCCESS", "10"), __typename: "FutureCheck" },
  ]) {
    assert.equal(snapshot([failed, replacement]).status?.failedCount, 1);
    assert.equal(snapshot([failed, replacement]).failures.length, 1);
  }
});

test("footer status is absent without checks", () => {
  assert.equal(status([]), undefined);
});
