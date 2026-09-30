---
title: Color pull requests by merge readiness
type: change
authors:
  - mavam
created: 2026-09-30T12:21:56.912091Z
---

The pull request icon in the footer now tells you whether the PR can merge: `success` when mergeable, `warning` while checks are pending, `error` when merge conflicts, failed checks, or unmet requirements such as missing approvals block it, `accent` when merged, and `dim` for drafts. Auto-merge no longer changes the color.

The CI icon now appears only while checks fail. It shows a red ✕ with the number of failed checks and links to the first failure. Pending and passing checks show up on the pull request icon instead, so the two icons no longer repeat each other. The widget id is now `pi-prs.ci-failures`, so any `/fancy-footer` placement for the old CI widget needs to be set again.

The watching eye is now its own icon instead of replacing the review-thread comment icon, so it no longer reads as a review or check status. The comment icon and its count only appear while review threads are unresolved.

The `pi-prs:state` event exposes the new `mergeState` and `ci.failedCount` fields on the pull request.
