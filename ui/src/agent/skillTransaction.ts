// FS-B2a — the PURE planner for a skill's engine transaction.
//
// The contract is docs/archive/first-stranger-program-2026-08-23/lanes/fs-b2.md. This module turns a skill +
// filled slots into the exact bridge traffic the 6-step harness protocol sends: a
// transaction id, a manifest, and one envelope per manifested command. It performs no
// I/O, so the same plan drives the browser mock, the vitest suite, AND the committed
// run-script goldens that verify.py replays against a real engine — one expansion, three
// consumers, nothing hand-maintained in parallel.

import type { AgentCommandCall } from "./executor";
import {
  SKILL_CATALOG,
  type SkillDefinition,
  type SkillPrimitive,
  type SkillSlotValues,
  type SkillTemplateNode,
  type SkillValue,
} from "./skills";

const owns = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function resolveValue(value: SkillValue, slots: SkillSlotValues): SkillPrimitive {
  if (typeof value !== "object") return value;
  if (!owns(slots, value.slot)) throw new Error(`template references unfilled slot "${value.slot}"`);
  return slots[value.slot];
}

/** Expand the bounded declarative template without executing it. Lives here rather than in
 *  the harness because it is pure planning — and because the harness imports this module,
 *  so the other direction would be a cycle. */
export function expandSkillTemplate(
  template: readonly SkillTemplateNode[],
  slots: SkillSlotValues,
): AgentCommandCall[] {
  const calls: AgentCommandCall[] = [];
  const walk = (nodes: readonly SkillTemplateNode[]) => {
    for (const node of nodes) {
      if (node.kind === "if_present") {
        if (owns(slots, node.slot)) walk(node.then);
        continue;
      }

      const args: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(node.args)) args[name] = resolveValue(value, slots);
      calls.push({ command: node.command, args });
    }
  };
  walk(template);
  return calls;
}

/** Transaction metadata. Rides BESIDE the handler's args, never mixed into them — the
 *  engine reads it off the command envelope's own `transaction` property. */
export type TxnMeta = {
  readonly transactionId: string;
  readonly requestId: string;
  readonly index: number;
};

export type TxnManifestEntry = {
  readonly index: number;
  readonly requestId: string;
  readonly command: string;
};

export type TxnStep = {
  readonly call: AgentCommandCall;
  readonly meta: TxnMeta;
};

export type SkillTransactionPlan = {
  readonly transactionId: string;
  readonly name: string;
  readonly manifest: readonly TxnManifestEntry[];
  readonly steps: readonly TxnStep[];
};

/** Id source. Injected so a golden fixture can be deterministic; production passes
 *  crypto.randomUUID. */
export type IdFactory = () => string;

export function newTransactionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `txn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Expand a skill into its transaction plan. Step 1 of the harness protocol: no mutation,
 * no snapshot, no bridge call.
 *
 * Engine `transactionSafe` eligibility is deliberately NOT re-checked here. The registry
 * lives in the engine (src/moshops/TransactionSafe.h) precisely because "the TypeScript
 * command catalog is not authoritative for engine rollback safety" — and batch_begin
 * validates the whole manifest BEFORE opening the Tracktion transaction, so a rejection
 * costs a legible refusal and mutates nothing. Mirroring the list here would create the
 * second source of truth the contract exists to avoid.
 */
export function planSkillTransaction(
  skill: SkillDefinition,
  slots: SkillSlotValues,
  newId: IdFactory = newTransactionId,
): SkillTransactionPlan {
  const transactionId = newId();
  const calls = expandSkillTemplate(skill.template, slots);
  const manifest: TxnManifestEntry[] = [];
  const steps: TxnStep[] = [];

  calls.forEach((call, index) => {
    const requestId = newId();
    manifest.push({ index, requestId, command: call.command });
    steps.push({ call, meta: { transactionId, requestId, index } });
  });

  return { transactionId, name: skill.name, manifest, steps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Which catalogued skills can be transactional at all
// ─────────────────────────────────────────────────────────────────────────────
//
// This is a FINDING, not a policy: 4 of the 8 catalogued skills contain a command that
// cannot sit inside an atomic edit transaction, and that is a property of the command, not
// of this contract. Recorded in code rather than prose so it cannot drift — and so FS-B2
// has to confront it when it picks its ~10 skills, because §7 B2's "never partial
// mutations" gate is not achievable as written for a skill containing an async render.
//
// Each `false` reason names the exact blocking command and why the ENGINE rejects it
// (verified against MoshOps.cpp: no beginTxn, or undoable=false, or a jobManager/callAsync
// body). txnSafeRegistry.test.ts re-derives all of it from the C++ at test time.
export const SKILL_TRANSACTABILITY: Readonly<Record<string, string | true>> = {
  set_track_level: true,
  build_drum_pattern: true,
  host_plugin: true,
  automate_parameter: true,
  add_vocal_with_lyrics: true,

  arrange_beat:
    "set_metronome calls no beginTxn and logs undoable=false — it is an engine/device " +
    "preference, so rolling the rest back would leave the metronome changed",
  warp_loop_to_grid:
    "detect_clip_bpm is a read/analysis with no transaction at all (and spawns the " +
    "service), so it can neither be undone nor be guaranteed synchronous",
  reimagine_clip:
    "render_layer is asynchronous (jobManager/callAsync) and logs undoable=false — its " +
    "audio can land after the transaction closes, which no rollback could recall",

  // FS-B2 (re-landed 2026-08-04). Three expand entirely into admitted commands; the two
  // RECORDING skills do not, and for a reason the engine states outright rather than an
  // oversight — TransactionSafe.h classes transport/recording commands as Lifecycle:
  // "replaces, persists or transports the project; it is outside any single edit
  // transaction". A take is captured by moving the transport, and no rollback can un-play
  // time. Both reasons below name a Lifecycle blocker, not the incidental ones.
  prepare_drum_track: true,
  send_to_bus: true,
  add_builtin_effect: true,

  record_take:
    "set_transport is Lifecycle in src/moshops/TransactionSafe.h — it transports the " +
    "project, which is outside any single edit transaction. arm_track and " +
    "set_input_monitor are also unadmitted, but the transport move is the one that " +
    "cannot be rolled back: the recording it starts is wall-clock, not an edit.",
  keep_last_take:
    "stop_recording is Lifecycle in src/moshops/TransactionSafe.h — it ends a capture and " +
    "persists the take, which is outside any single edit transaction. keep_take itself is " +
    "unadmitted too (it appears to meet the header's four criteria, but the registry guard " +
    "is one-directional and would never flag an omission — worth its own look, and " +
    "deliberately not widened here as a side effect of re-landing skills).",
};

/** Skills whose whole manifest the engine registry will admit. */
export function transactableSkills(): readonly SkillDefinition[] {
  return SKILL_CATALOG.filter((skill) => SKILL_TRANSACTABILITY[skill.name] === true);
}

/** Why a skill cannot be transactional, or null if it can. */
export function untransactableReason(skillName: string): string | null {
  const verdict = SKILL_TRANSACTABILITY[skillName];
  if (verdict === true) return null;
  return verdict ?? `${skillName} has no recorded transactability verdict`;
}
