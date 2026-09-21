---
title: CI failure feedback while watching pull requests
type: feature
authors:
  - mavam
  - codex
created: 2026-09-21T15:03:49.345523Z
---

`/pr watch` now sends CI failures to pi alongside review feedback:

```text
/pr watch
```

Failure messages include the commit, check names, links, and short GitHub Actions diagnostic excerpts when available. Repeated polls stay quiet, while failed reruns and failures on new commits trigger fresh feedback. Canceled and skipped checks don't start agent turns. `/pr unwatch` stops both kinds of feedback without stopping footer updates.
