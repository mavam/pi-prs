import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PI_PR_CI_FAILURE_CHANNEL,
  PI_PR_FEEDBACK_CHANNEL,
  PI_PR_PROTOCOL,
  PI_PR_STATE_CHANNEL,
  type FeedbackEvent,
  isCiFailureEvent,
  isFeedbackEvent,
} from "./api.ts";
import { BABYSIT_PROMPT } from "./babysit.ts";
import {
  CI_FAILURE_MESSAGE_TYPE,
  formatCiFailureMessage,
  registerCiFailureRenderer,
} from "./ci-message.ts";
import { createFooterPublisher } from "./footer.ts";
import { formatModelMessage } from "./format.ts";
import { loadHtmlConverter } from "./markdown.ts";
import { FEEDBACK_MESSAGE_TYPE, registerFeedbackRenderer } from "./message.ts";
import { createPoller } from "./poller.ts";

const USAGE = "Usage: /pr watch [--babysit] | /pr unwatch";

export default async function (pi: ExtensionAPI) {
  await loadHtmlConverter();

  let sessionActive = false;

  const footer = createFooterPublisher(pi);

  const poller = createPoller({
    pi,
    onState: (state) => {
      pi.events.emit(PI_PR_STATE_CHANNEL, state);
      footer.publish(state);
    },
    onCiFailure: (event) => {
      // Outside a session the listener drops events; keep them unseen instead.
      if (!sessionActive) return false;
      pi.events.emit(PI_PR_CI_FAILURE_CHANNEL, event);
      return true;
    },
    onFeedback: (target, feedback) => {
      pi.events.emit(PI_PR_FEEDBACK_CHANNEL, {
        protocol: PI_PR_PROTOCOL,
        source: "pi-prs",
        target,
        feedback,
      } satisfies FeedbackEvent);
    },
  });

  registerFeedbackRenderer(pi);
  registerCiFailureRenderer(pi);

  // When babysitting from an idle session, the instructions must start the turn
  // before any feedback arrives. Otherwise feedback wins the race and the
  // instructions queue behind it. Hold deliveries until the turn has started.
  let holding = false;
  let held: Array<() => void> = [];
  const deliver = (send: () => void) => {
    if (holding) held.push(send);
    else send();
  };
  const release = () => {
    holding = false;
    const queued = held;
    held = [];
    for (const send of queued) send();
  };

  const stopCiListener = pi.events.on(PI_PR_CI_FAILURE_CHANNEL, (raw) => {
    if (!sessionActive || !isCiFailureEvent(raw) || raw.failures.length === 0)
      return;
    deliver(() =>
      pi.sendMessage(
        {
          customType: CI_FAILURE_MESSAGE_TYPE,
          content: formatCiFailureMessage(raw),
          display: true,
          details: raw,
        },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    );
  });

  // Any extension may publish review feedback on this channel; pi-prs turns it
  // into a follow-up message for the agent.
  const stopFeedbackListener = pi.events.on(PI_PR_FEEDBACK_CHANNEL, (raw) => {
    if (!sessionActive || !isFeedbackEvent(raw) || raw.feedback.length === 0) {
      return;
    }
    deliver(() =>
      pi.sendMessage(
        {
          customType: FEEDBACK_MESSAGE_TYPE,
          content: formatModelMessage(raw.target, raw.feedback),
          display: true,
          details: raw,
        },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    );
  });

  pi.registerCommand("pr", {
    description:
      "Watch pull request feedback and CI failures, optionally with babysitting instructions",
    getArgumentCompletions: (prefix) => {
      const options = [
        {
          value: "watch",
          label: "watch",
          description: "Load review feedback and CI failures, then watch",
        },
        {
          value: "watch --babysit",
          label: "watch --babysit",
          description: "Watch and assess feedback, fix valid findings, reply and resolve",
        },
        { value: "unwatch", label: "unwatch", description: "Stop watching" },
      ];
      const matches = options.filter((option) =>
        option.value.startsWith(prefix),
      );
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const action = words[0];

      if (action === "unwatch" && words.length === 1) {
        const stopped = poller.unwatch();
        ctx.ui.notify(
          stopped
            ? "Stopped watching the pull request"
            : "No pull request is being watched",
          "info",
        );
        return;
      }

      const babysit = words.length === 2 && words[1] === "--babysit";
      if (action !== "watch" || (words.length !== 1 && !babysit)) {
        ctx.ui.notify(USAGE, action ? "warning" : "info");
        return;
      }

      const idle = ctx.isIdle();
      const result = await poller.watch(
        ctx.cwd,
        babysit
          ? () => {
              // Queue as a follow-up ahead of feedback so nothing interrupts a running turn.
              holding = idle;
              pi.sendUserMessage(BABYSIT_PROMPT, { deliverAs: "followUp" });
            }
          : undefined,
      );
      // Don't leave feedback held if the turn never started.
      if (holding) setTimeout(release, 1000).unref?.();
      if (!result.ok) {
        ctx.ui.notify(`Cannot watch pull request: ${result.error}`, "error");
        return;
      }
      const target = result.target!;
      ctx.ui.notify(
        `Watching ${target.owner}/${target.name}#${target.number}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    sessionActive = true;
    poller.start(ctx.cwd);
  });

  pi.on("agent_start", release);

  pi.on("session_shutdown", () => {
    sessionActive = false;
    holding = false;
    held = [];
    poller.stop();
    footer.clear();
    footer.dispose();
    stopFeedbackListener();
    stopCiListener();
  });
}
