---
title: Concise babysitting prompt
type: bugfix
authors:
  - mavam
prs:
  - 9
created: 2026-10-02T10:29:21.793557Z
---

The `/pr watch --babysit` instructions are now shorter and no longer repeat themselves, so the agent gets a clearer, more focused prompt. Behavior is unchanged: the agent still verifies each finding, fixes valid ones, replies on GitHub with the commit SHA or an evidence-based rejection reason, and resolves the review thread. Blocked work stays unresolved.
