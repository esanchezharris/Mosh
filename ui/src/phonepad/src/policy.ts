import type { Action, PartId, Receipt, State } from "./contract";

export type PadContext = {
  readonly state: State | null; readonly connected: boolean;
  readonly pending: boolean; readonly selected: PartId | null;
};

export function target(context: PadContext): PartId | null {
  const state = context.state;
  if (state === null) return null;
  if (state.recording) return state.currentId;
  const selection = state.contributions.find((part) => part.id === context.selected);
  return selection?.id ?? state.auditionedId ?? state.lastId;
}

export function targetLabel(context: PadContext): string {
  if (context.state?.recording) return "current recording";
  const id = target(context);
  return context.state?.contributions.find((part) => part.id === id)?.label ?? "no part selected";
}

export function contributionLabel(part: State["contributions"][number]): string {
  return `${part.label} · ${part.rejected ? "preserved redo" : part.keeper ? "kept" : "preserved"}`;
}

export function available(action: Action, context: PadContext): boolean {
  const state = context.state;
  if (!context.connected || state === null || !state.engaged || !state.hostAlive) return false;
  if (action === "stop") return true;
  if (context.pending || state.busy) return false;
  switch (action) {
    case "record": return !state.recording;
    case "play_all": return true;
    case "navigate": case "home": case "lead_in": return !state.recording && !state.playing;
    case "hear": return state.recording ? state.currentId !== null : context.selected !== null;
    case "again": case "keep": return target(context) !== null;
    default: return assertNever(action);
  }
}

export function actionTarget(action: Action, context: PadContext): PartId | null {
  if (action === "hear" && !context.state?.recording) return context.selected;
  if (action === "keep" || action === "again" || action === "hear") return target(context);
  return null;
}

export function terminal(receipt: Receipt): boolean {
  switch (receipt.status) {
    case "accepted": case "running": return false;
    case "completed": case "rejected": case "cancelled": return true;
    default: return assertNever(receipt.status);
  }
}

export function assertNever(value: never): never {
  throw new TypeError(`Unhandled variant: ${String(value)}`);
}
