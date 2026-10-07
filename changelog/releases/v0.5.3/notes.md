This release fixes the delivery order of `/pr watch --babysit`. The agent now receives its babysitting instructions before existing review feedback and CI failures, and everything still arrives as a follow-up.

## 🐞 Bug fixes

### Babysit instructions arrive before feedback

`/pr watch --babysit` now delivers its instructions before existing pull request feedback and CI failures. Everything still arrives as a follow-up, so nothing interrupts a running turn.

*By @mavam.*
