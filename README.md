# 🐙 pi-prs

A [Pi](https://pi.dev) extension that owns GitHub pull request state for your
session: footer widgets, review feedback, CI failures, and watching.

## 🚀 Installation

```sh
pi install npm:pi-prs
```

Install [GitHub CLI](https://cli.github.com/) and authenticate it before using
the extension.

## ✨ Usage

pi-prs resolves the pull request for the current branch on its own and keeps it
fresh in the background. Fork and upstream remotes both work, and switching
branches re-resolves immediately.

Start watching that pull request for review feedback and CI failures:

```text
/pr watch
```

The extension sends unresolved review feedback and current CI failures to pi,
then checks GitHub every 30 seconds for new comments, reviews, and failed checks.
New feedback starts an agent turn when pi is idle or steers its next turn when
it's busy.

CI messages include the commit, failed check names, and links. GitHub Actions
failures also include short diagnostic excerpts when logs are available; expand
the message to see them. Other CI providers and unavailable logs fall back to
check names and links. Diagnostics cover at most three jobs per batch, with up
to 80 lines or 4,000 characters per excerpt.

Each failed execution is delivered once while you stay on the same pull request
in the session, including across `/pr unwatch` and `/pr watch`. Failed reruns and
failures on new commits are delivered again. Canceled, skipped, and passing
checks don't start agent turns. Large sets of failures arrive in batches of up
to 20 checks, and failures from superseded commits are discarded.

Stop watching:

```text
/pr unwatch
```

This stops both review and CI feedback; footer updates continue. Watching also
stops automatically when the pull request closes or merges.

## 🧩 Footer widgets

When [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) is installed,
pi-prs publishes the pull request number, unresolved review threads, and CI
status. You can change their placement, visibility, and colors with
`/fancy-footer`.

## 🔌 Extension API

pi-prs is the only extension that should poll GitHub in a session. Other
extensions consume its state from the event bus instead of shelling out to
`gh`:

```ts
import { createPiPrClient } from "pi-prs/api";

export default function (pi) {
  const client = createPiPrClient(pi);
  client.onState((state) => {
    // state.pullRequest?.ci, .unresolvedThreadCount, .isDraft, …
  });
  client.onFeedback((event) => {
    // event.feedback: new review findings
  });
  client.onCiFailure((event) => {
    // event.headRefOid, event.failures: new failed CI executions
  });
}
```

Publishing a `pi-prs:feedback` or `pi-prs:ci-failure` event yourself sends that
feedback to pi as a steering message.

## 🧰 Requirements

- [GitHub CLI](https://cli.github.com/), authenticated with `gh auth login`

## 📄 License

[MIT](LICENSE)
