// One tool-call chip in the agent drawer: what Moshi did, in producer words
// (describeCommand), with an honest state — running spinner, ok, or the error
// verbatim in the title so a failed step is inspectable without a log dive.

import { describeCommand } from "../../agent/commands";
import { SERVICE_SPAWNING } from "../../agent/loop/jobWait";
import type { StepView } from "../../agent/loop/taskStore";

export function StepChip({ step, index }: { step: StepView; index: number }) {
  const failed = step.results.filter((r) => !r.ok);
  const state = step.running ? "running" : failed.length ? "error" : "ok";
  const slow = step.running && step.commands.some((c) => SERVICE_SPAWNING.has(c.command));
  const summary = step.commands
    .map((c) => describeCommand(c.command, (c.args ?? {}) as Record<string, unknown>))
    .join(" · ") + (slow ? " — warming the sound engine, a moment…" : "");
  const title = failed.length
    ? failed.map((f) => `${f.command}: ${f.error ?? "failed"}`).join("\n")
    : step.goal ?? summary;

  return (
    <div className={`v2-agent-chip ${state}`} title={title} data-testid={`agent-step-${index}`}>
      <span className="v2-agent-chip-state" aria-hidden="true">
        {state === "running" ? <span className="v2-agent-spin" /> : state === "error" ? "⚠" : "✦"}
      </span>
      <span className="v2-agent-chip-text">{summary || step.goal || "…"}</span>
    </div>
  );
}
