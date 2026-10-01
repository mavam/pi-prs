---
title: CI footer recovery after successful reruns
type: bugfix
authors:
  - mavam
prs:
  - 8
created: 2026-10-01T18:06:27.313875Z
---

Pull request footers now clear old CI failures after a successful rerun, so the PR icon can return to green and the failure count disappears. While a replacement check runs, the footer shows checks as pending instead of retaining the superseded failure. Watching also ignores failures that newer executions have replaced.
