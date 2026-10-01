You can now use `/pr watch --babysit` to ask pi to assess review feedback, fix valid findings, and reply before resolving threads. CI footers also recover after successful reruns.

## 🚀 Features

### Prompt-backed PR babysitting

You can now ask pi to critically assess pull request feedback when you start watching:

```text
/pr watch --babysit
```

The prompt asks the agent to fix valid findings, reply on GitHub with the addressing commit SHA or an evidence-based rejection reason, and then resolve each review thread. Blocked work remains unresolved. The instructions arrive before the initial feedback; plain `/pr watch` continues to deliver feedback without adding them.

*By @mavam in #7.*

## 🐞 Bug fixes

### CI footer recovery after successful reruns

Pull request footers now clear old CI failures after a successful rerun, so the PR icon can return to green and the failure count disappears. While a replacement check runs, the footer shows checks as pending instead of retaining the superseded failure. Watching also ignores failures that newer executions have replaced.

*By @mavam in #8.*
