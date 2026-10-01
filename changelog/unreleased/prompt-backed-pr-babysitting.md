---
title: Prompt-backed PR babysitting
type: feature
authors:
  - mavam
prs:
  - 7
created: 2026-10-01T16:05:31.126672Z
---

You can now ask pi to critically assess pull request feedback with `/pr babysit`:

```text
/pr babysit
/pr watch
```

The prompt asks the agent to fix valid findings, reply on GitHub with the addressing commit SHA or an evidence-based rejection reason, and then resolve each review thread. Blocked work remains unresolved. Babysitting adds instructions to the conversation; `/pr watch` still controls feedback delivery.
