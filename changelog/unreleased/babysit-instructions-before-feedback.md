---
title: Babysit instructions arrive before feedback
type: bugfix
authors:
  - mavam
---

`/pr watch --babysit` now steers its instructions into the agent ahead of existing pull request feedback and CI failures, instead of queueing them as a follow-up behind those messages.
