---
title: Persistent pull request watching
type: feature
authors:
  - mavam
prs:
  - 13
created: 2026-10-10T09:32:41.648641Z
---

Pull request watching now resumes automatically when you reopen or reload a session attached to the same open PR. Babysitting instructions and previously delivered feedback aren't repeated; new unresolved review feedback and current CI failures still arrive. An explicit `/pr unwatch` remains stopped across session restarts, and switching to another PR doesn't transfer the watch.

For sessions created before this change, run `/pr watch` once to save their watch state without adding babysitting instructions.
