Pull request watching now resumes when you reopen or reload a session, without repeating babysitting instructions or previously delivered feedback. Babysitting instructions now reliably arrive before review feedback and check failures, even while Pi is busy.

## 🚀 Features

### Persistent pull request watching

Pull request watching now resumes automatically when you reopen or reload a session attached to the same open PR. Babysitting instructions and previously delivered feedback aren't repeated; new unresolved review feedback and current CI failures still arrive. An explicit `/pr unwatch` remains stopped across session restarts, and switching to another PR doesn't transfer the watch.

For sessions created before this change, run `/pr watch` once to save their watch state without adding babysitting instructions.

*By @mavam in #13.*

## 🐞 Bug fixes

### Reliable babysitting instruction order

`/pr watch --babysit` now delivers its instructions before the review feedback and CI failures loaded by the command, whether Pi is idle or busy. Previously, feedback could overtake the instructions while Pi was processing input or starting a turn. The instructions appear as a visible extension message, and watching still doesn't interrupt ongoing work.

*By @mavam in #12.*
