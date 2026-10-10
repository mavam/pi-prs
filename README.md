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
New feedback starts an agent turn when pi is idle or queues a follow-up when
it's busy, without interrupting its current work.

Watching is saved with the session. Resuming or reloading automatically
reattaches to the same open pull request without repeating babysitting
instructions or feedback already recorded on the active session branch. New
unresolved review feedback and current CI failures can still start a turn. The
initial catch-up covers unresolved review threads, just like `/pr watch`; it
doesn't replay historical conversation comments or review summaries.

An explicit `/pr unwatch` stays stopped after resuming. Watching also stops if
the checkout resolves to a different pull request, or the saved pull request
closes or merges. Sessions from older versions need one plain `/pr watch` to
save their watch state; this doesn't add babysitting instructions.

CI messages include the commit, failed check names, and links. GitHub Actions
failures also include short diagnostic excerpts as soon as the failed job
finishes, even while the rest of the run continues; expand the message to see
them. Other CI providers and unavailable logs fall back to check names and
links. Diagnostics cover at most three jobs per batch, with up to 80 lines or
4,000 characters per excerpt.

Each failed execution is delivered once while you stay on the same pull request
in the session, including across `/pr unwatch` and `/pr watch`. Failed reruns and
failures on new commits are delivered again. Only the latest execution of each
named check within a workflow contributes to CI status and feedback. Successful
reruns clear superseded failures from the footer. Canceled checks and checks
awaiting approval show as failed in the footer but don't start agent turns;
neither do skipped or passing checks. Large sets of failures arrive in batches of up to 20
checks, and failures from superseded commits are discarded. Checks with
incomplete or unfamiliar statuses stay pending without hiding other failures.
GitHub read errors retain the last known CI status and slow polling until reads
succeed again, whether or not you're watching.

Stop watching:

```text
/pr unwatch
```

This stops both review and CI feedback; footer updates continue. Watching also
stops automatically when the pull request closes or merges.

### Babysit review feedback

Start watching with a prompt that asks pi to assess and handle review feedback:

```text
/pr watch --babysit
```

Once watching starts, `--babysit` sends a visible instruction message ahead of
the initial review feedback and CI failures. The instructions and feedback use
the same ordered delivery path: they start an agent turn when idle or queue as
follow-ups when busy, without interrupting current work. Plain `/pr watch`
delivers feedback without adding the prompt; the extension doesn't perform
GitHub actions itself.

The prompt instructs the agent to:

- Critically verify each finding against the current code and intended behavior.
- Fix valid findings, run relevant checks, and commit and push according to the
  repository's workflow.
- Reply on GitHub with the addressing commit SHA or an evidence-based rejection
  reason, then resolve the review thread after the reply succeeds.
- Report blockers and leave unfinished threads unresolved. Comments without
  review threads receive replies but cannot be resolved.

These are instructions for the agent, not an enforced automation policy. They
apply to feedback already in context and future feedback in this session until
you tell the agent to stop. `/pr unwatch` stops new deliveries; it doesn't retract
the prompt or cancel work already underway. Automatic session reattachment
reuses those instructions; explicitly running `/pr watch --babysit` again still
adds a fresh prompt.

## 🧩 Footer widgets

When [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) is installed,
pi-prs publishes the pull request number, unresolved review threads, failed CI
checks, and a watching indicator. You can change their placement, visibility, and colors
with `/fancy-footer`.

The pull request icon tells you whether the PR can merge:

| Color     | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| `success` | Mergeable                                                        |
| `warning` | Checks are pending                                               |
| `error`   | Blocked by merge conflicts, failed checks, or unmet requirements |
| `accent`  | Merged                                                           |
| `dim`     | Draft                                                            |

Auto-merge doesn't change the color. Unmet requirements include missing
approvals, unresolved conversations that branch protection requires you to
resolve, and an outdated branch. All icons dim when GitHub state is degraded.

The other icons each have their own shape:

- The ✕ and its count show failed CI checks and link to the first failure. It
  appears only while checks fail, since the pull request icon already shows
  pending checks. It uses the footer's default icon color, because the red
  pull request icon already signals the failure.
- The comment icon and its count show unresolved review threads.
- The eye appears alone while `/pr watch` is active. Like the comment icon, it
  uses the footer's default icon color, which you can change in `/fancy-footer`.

## 🔌 Extension API

pi-prs is the only extension that should poll GitHub in a session. Other
extensions consume its state from the event bus instead of shelling out to
`gh`:

```ts
import { createPiPrClient } from "pi-prs/api";

export default function (pi) {
  const client = createPiPrClient(pi);
  client.onState((state) => {
    // state.pullRequest?.ci, .mergeState, .unresolvedThreadCount, .isDraft, …
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
feedback to pi as a follow-up when it's busy or starts a turn when it's idle.

## 🧰 Requirements

- [GitHub CLI](https://cli.github.com/), authenticated with `gh auth login`

## 📄 License

[MIT](LICENSE)
