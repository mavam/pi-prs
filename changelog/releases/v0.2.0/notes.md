pi-prs now sends CI failures to pi while you watch a pull request, including diagnostic excerpts from failed GitHub Actions jobs. This release also renames the extension's identifiers to pi-prs, so integrations that use the old pi-pr names must update.

## 💥 Breaking changes

### Rename extension identifiers to pi-prs

The extension now uses `pi-prs` consistently for its event channels, feedback message type, widget IDs, source markers, and public documentation. Integrations consuming the previous `pi-pr` identifiers must update to the corresponding `pi-prs` names.

*By @mavam.*

## 🚀 Features

### CI failure feedback while watching pull requests

`/pr watch` now sends CI failures to pi alongside review feedback:

```text
/pr watch
```

Failure messages include the commit, check names, links, and short GitHub Actions diagnostic excerpts as soon as the failed job finishes. Repeated polls stay quiet, while failed reruns and failures on new commits trigger fresh feedback. Incomplete check results stay pending without hiding other failures. Canceled checks, checks awaiting approval, and skipped checks don't start agent turns. `/pr unwatch` stops both kinds of feedback without stopping footer updates.

*By @mavam and @codex in #3.*
