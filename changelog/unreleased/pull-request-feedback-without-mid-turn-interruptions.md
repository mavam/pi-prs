---
title: Pull request feedback without mid-turn interruptions
type: bugfix
authors:
  - mavam
prs:
  - 10
created: 2026-10-03T10:14:20.158487Z
---

Pull request review feedback, CI failures, and `/pr watch --babysit` instructions now wait until the agent finishes its current work instead of steering it mid-turn. When the agent is idle, they still start a turn immediately.
