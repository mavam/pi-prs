---
title: More selective regression testing during babysitting
type: change
authors:
  - mavam
prs:
  - 14
created: 2026-11-10T07:22:00.405216Z
---

The `/pr watch --babysit` prompt now asks for a focused regression test only when it fills a meaningful coverage gap, rather than requiring regression coverage for every valid finding. This reduces unnecessary test writing while keeping relevant checks in place.
