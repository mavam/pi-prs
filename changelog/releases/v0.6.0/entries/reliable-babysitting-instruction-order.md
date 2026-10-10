---
title: Reliable babysitting instruction order
type: bugfix
authors:
  - mavam
prs:
  - 12
created: 2026-10-10T09:18:47.994511Z
---

`/pr watch --babysit` now delivers its instructions before the review feedback and CI failures loaded by the command, whether Pi is idle or busy. Previously, feedback could overtake the instructions while Pi was processing input or starting a turn. The instructions appear as a visible extension message, and watching still doesn't interrupt ongoing work.
