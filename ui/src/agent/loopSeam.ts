// The AgentRunner seam — the contract between "something that runs an agent
// task" (today: the single-shot brain; Phase B: the multi-step agentic loop)
// and "somewhere tasks can execute" (the dev mock in vitest/e2e, the real
// headless engine in scripts/agentBench.mts). MoshAgentBench measures any
// runner through this one interface, so the loop lane lands as a drop-in
// `--runner loop` with zero bench changes.
//
// Contract notes:
// - env.runBatch MUST apply production semantics: per-command catalog
//   validation and the destructive screen, with the whole batch bracketed as
//   ONE undo unit (batch_begin/batch_end). Invalid/blocked calls come back as
//   failed results with their error strings — they are never silently dropped,
//   because a runner (and the model behind it) learns from the envelope.
// - results are ordered like the submitted calls; snapshot is the post-batch
//   observation the next step reasons over.

import type { Snapshot } from "../types";
import type { AgentCommandCall } from "./executor";

export type StepCommandResult = {
  readonly command: string;
  readonly ok: boolean;
  readonly error?: string;
};

/** One model step: what it said, what it tried, what actually happened. */
export type StepRecord = {
  readonly say?: string;
  readonly intent?: string;
  /** Commands as emitted by the model (pre-validation, pre-screen). */
  readonly commands: readonly AgentCommandCall[];
  /** Post-execution envelopes (invalid + blocked calls included, marked !ok). */
  readonly results: readonly StepCommandResult[];
  /** Catalog-rejected count for this step (subset of the !ok results). */
  readonly invalidCount: number;
  /** Model latency for this step, ms. */
  readonly ms: number;
};

export type AgentTaskRun = {
  readonly finalSnapshot: Snapshot;
  readonly transcript: readonly StepRecord[];
  readonly stepCount: number;
  /** True when the whole task emitted zero commands (a deferral). */
  readonly deferred: boolean;
  /** Harness/brain failure (network, parse-nothing, runner crash). */
  readonly error?: string;
};

export type AgentEnv = {
  getSnapshot(): Promise<Snapshot>;
  runBatch(
    label: string,
    calls: readonly AgentCommandCall[],
  ): Promise<{ results: StepCommandResult[]; snapshot: Snapshot }>;
};

export type AgentRunner = (
  task: { readonly ask: string },
  env: AgentEnv,
  opts: { readonly maxSteps: number },
) => Promise<AgentTaskRun>;
