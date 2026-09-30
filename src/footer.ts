import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PullRequestSnapshot, PullRequestStateEvent } from "./api.ts";

/**
 * pi-fancy-footer's widget protocol, mirrored here so that pi-prs stays
 * dependency-free. Keep in sync with `pi-fancy-footer/src/api.ts`.
 */
const FANCY_FOOTER_PROTOCOL = 1;
const WIDGET_CHANNEL = "pi-fancy-footer:widget";
const READY_CHANNEL = "pi-fancy-footer:ready";

const NUMBER_WIDGET_ID = "pi-prs.number";
const THREADS_WIDGET_ID = "pi-prs.review-threads";
const CI_FAILURES_WIDGET_ID = "pi-prs.ci-failures";
const WATCHING_WIDGET_ID = "pi-prs.watching";

type Glyphs = Record<"nerd" | "emoji" | "unicode" | "ascii", string>;

const GLYPHS = {
  pullRequest: {
    nerd: "\u{f408}",
    emoji: "\u{1f500}",
    unicode: "\u{21c4}",
    ascii: "@",
  },
  reviewThreads: {
    nerd: "\u{f017a}",
    emoji: "\u{1f4ac}",
    unicode: "\u{270e}",
    ascii: "!",
  },
  watching: {
    nerd: "\u{f06e}",
    emoji: "\u{1f441}\u{fe0f}",
    unicode: "\u{25c9}",
    ascii: "o",
  },
  ciFailed: {
    nerd: "\u{f057}",
    emoji: "\u{274c}",
    unicode: "\u{2715}",
    ascii: "x",
  },
} satisfies Record<string, Glyphs>;

type IconColor =
  | "text"
  | "accent"
  | "muted"
  | "dim"
  | "success"
  | "warning"
  | "error";

interface WidgetSpec {
  id: string;
  label: string;
  description: string;
  text: string;
  href?: string;
  glyphs: Glyphs;
  /** Omit to use the footer's default icon color, so neutral icons follow the theme. */
  iconColor: IconColor | undefined;
  position: number;
}

export interface FooterPublisher {
  publish(state: PullRequestStateEvent | undefined): void;
  clear(): void;
  dispose(): void;
}

function safeHref(value: string): string | undefined {
  return /^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/u.test(value)
    ? value
    : undefined;
}

/**
 * The pull request icon summarizes whether the PR can merge: purple once
 * merged, green when mergeable, yellow while checks run, red when blocked by
 * conflicts, failed checks, or missing requirements, and dim for drafts.
 */
function pullRequestColor(pullRequest: PullRequestSnapshot): IconColor {
  if (pullRequest.isDraft) return "dim";
  if (pullRequest.lifecycle === "merged") return "accent";
  if (
    pullRequest.mergeState === "conflicting" ||
    pullRequest.ci?.state === "failed"
  ) {
    return "error";
  }
  // Required checks that are still running also report as blocked.
  if (pullRequest.ci?.state === "running") return "warning";
  return pullRequest.mergeState === "blocked" ? "error" : "success";
}

function widgetsFor(state: PullRequestStateEvent): WidgetSpec[] {
  const pullRequest = state.pullRequest;
  if (!pullRequest || pullRequest.lifecycle === "closed") return [];

  const degraded = state.health !== "ok";
  const url = safeHref(pullRequest.target.url);
  const widgets: WidgetSpec[] = [
    {
      id: NUMBER_WIDGET_ID,
      label: "Pull request",
      description: "Shows the pull request for the current branch",
      text: `${pullRequest.target.number}`,
      href: url,
      glyphs: GLYPHS.pullRequest,
      iconColor: degraded ? "dim" : pullRequestColor(pullRequest),
      position: 3,
    },
  ];

  if (pullRequest.unresolvedThreadCount > 0) {
    widgets.push({
      id: THREADS_WIDGET_ID,
      label: "PR review threads",
      description: "Shows unresolved review threads on the pull request",
      text: `${pullRequest.unresolvedThreadCount}`,
      href: url,
      glyphs: GLYPHS.reviewThreads,
      iconColor: degraded ? "dim" : undefined,
      position: 4,
    });
  }

  // Only failures get a widget; the pull request icon already shows whether
  // checks are running or passing and carries the error color, so this icon
  // keeps the footer's default color. The count and link go to the failed checks.
  if (pullRequest.ci?.state === "failed") {
    widgets.push({
      id: CI_FAILURES_WIDGET_ID,
      label: "PR CI failures",
      description: "Shows the number of failed CI checks on the pull request",
      text: `${Math.max(1, pullRequest.ci.failedCount)}`,
      href: safeHref(pullRequest.ci.url),
      glyphs: GLYPHS.ciFailed,
      iconColor: degraded ? "dim" : undefined,
      position: 5,
    });
  }

  // Watching is a session mode, so it gets its own neutral icon instead of
  // borrowing the review-thread or CI slots.
  if (pullRequest.watching) {
    widgets.push({
      id: WATCHING_WIDGET_ID,
      label: "PR watching",
      description:
        "Shows that pi is watching the pull request for reviews and CI failures",
      text: "",
      href: url,
      glyphs: GLYPHS.watching,
      iconColor: degraded ? "dim" : undefined,
      position: 6,
    });
  }

  return widgets;
}

export function createFooterPublisher(pi: ExtensionAPI): FooterPublisher {
  let lastState: PullRequestStateEvent | undefined;
  const published = new Set<string>();

  const remove = (id: string): void => {
    pi.events.emit(WIDGET_CHANNEL, {
      protocol: FANCY_FOOTER_PROTOCOL,
      type: "remove",
      id,
    });
    published.delete(id);
  };

  const render = (): void => {
    const widgets = lastState ? widgetsFor(lastState) : [];
    const live = new Set(widgets.map((widget) => widget.id));

    for (const id of [...published]) {
      if (!live.has(id)) remove(id);
    }

    for (const widget of widgets) {
      pi.events.emit(WIDGET_CHANNEL, {
        protocol: FANCY_FOOTER_PROTOCOL,
        type: "upsert",
        widget: {
          id: widget.id,
          label: widget.label,
          description: widget.description,
          content: {
            type: "text",
            text: widget.text,
            ...(widget.href ? { href: widget.href } : {}),
          },
          icon: {
            glyphs: widget.glyphs,
            ...(widget.iconColor ? { color: widget.iconColor } : {}),
          },
          layout: { row: 1, position: widget.position, align: "left" },
        },
      });
      published.add(widget.id);
    }
  };

  // Republish after the footer restarts and forgets external widgets.
  const stopReadyListener = pi.events.on(READY_CHANNEL, (raw) => {
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { protocol?: unknown }).protocol === FANCY_FOOTER_PROTOCOL
    ) {
      render();
    }
  });

  return {
    publish: (state) => {
      lastState = state;
      render();
    },
    clear: () => {
      lastState = undefined;
      for (const id of [...published]) remove(id);
    },
    dispose: () => {
      stopReadyListener();
    },
  };
}
