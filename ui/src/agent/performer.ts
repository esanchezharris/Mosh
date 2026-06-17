// Turns a FastAction (from the deterministic matcher) into real effects. Pure router
// over INJECTED dependency callbacks, so it unit-tests without the store/bridge. The
// store wires the real implementations (arm/record/stop/keep/nav via `exec`).
import type { FastAction } from "./fastPath";

export type FastDeps = {
  runBatch: (label: string, cmds: { command: string; args?: Record<string, unknown> }[]) => Promise<void>;
  enterRecord: (bar?: number) => Promise<void>;
  stopRecord: () => Promise<void>;
  keepTake: () => Promise<void>;
  navTake: (delta: number) => Promise<void>;
  utter: (intent: string, say?: string) => void;
};

export async function handleFast(a: FastAction, d: FastDeps): Promise<void> {
  d.utter(a.intent, a.say);
  switch (a.kind) {
    case "commands": await d.runBatch(a.say ?? "voice", a.commands); break;
    case "enterRecord": await d.enterRecord(a.bar); break;
    case "stopRecord": await d.stopRecord(); break;
    case "keepTake": await d.keepTake(); break;
    case "navTake": await d.navTake(a.delta); break;
  }
}
