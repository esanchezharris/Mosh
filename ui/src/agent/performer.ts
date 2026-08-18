// Turns a FastAction (from the deterministic matcher) into real effects. Pure router
// over INJECTED dependency callbacks, so it unit-tests without the store/bridge. The
// store wires the real implementations (arm/record/stop/keep/nav via `exec`).
import type { FastAction } from "./fastPath";

export type FastDeps = {
  runBatch: (label: string, cmds: { command: string; args?: Record<string, unknown> }[]) => Promise<void>;
  // Skill Foundry Slice B, Task 2 — the store's own recording-lifecycle methods now
  // resolve to a RecordingStoreOutcomeV1 (see recordingLifecycle.ts), which this router
  // never inspects (it only awaits and discards, per handleFast below) — `Promise<unknown>`
  // keeps this dependency shape decoupled from that result type on purpose.
  enterRecord: (bar?: number) => Promise<unknown>;
  stopRecord: () => Promise<unknown>;
  keepTake: () => Promise<unknown>;
  navTake: (delta: number) => Promise<unknown>;
  utter: (intent: string, say?: string) => void;
  // AGT-MEM (M3) — its own dep (not routed through runBatch) because
  // agent_memory_write is deliberately outside AGENT_COMMANDS/validateCommand — see
  // fastPath.ts's "remember" FastAction comment.
  remember?: (text: string, scope: "global" | "project") => Promise<void>;
};

export async function handleFast(a: FastAction, d: FastDeps): Promise<void> {
  d.utter(a.intent, a.say);
  switch (a.kind) {
    case "commands": await d.runBatch(a.say ?? "voice", a.commands); break;
    case "enterRecord": await d.enterRecord(a.bar); break;
    case "stopRecord": await d.stopRecord(); break;
    case "keepTake": await d.keepTake(); break;
    case "navTake": await d.navTake(a.delta); break;
    case "remember": await d.remember?.(a.text, a.scope); break;
  }
}
