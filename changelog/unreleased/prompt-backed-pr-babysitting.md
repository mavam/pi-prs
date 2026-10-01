---
title: Prompt-backed PR babysitting
type: feature
authors:
  - mavam
prs:
  - 7
created: 2026-10-01T18:05:07.679822Z
---

You can now ask pi to critically assess pull request feedback when you start watching:

```text
/pr watch --babysit
```

The prompt asks the agent to fix valid findings, reply on GitHub with the addressing commit SHA or an evidence-based rejection reason, and then resolve each review thread. Blocked work remains unresolved. The instructions arrive before the initial feedback; plain `/pr watch` continues to deliver feedback without adding them.
