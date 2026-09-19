import { barSchema, leadQnSchema, partIdSchema } from "./contract";
import type { Action } from "./contract";
import type { PadController, Snapshot } from "./controller";
import { available, contributionLabel, targetLabel } from "./policy";

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new TypeError(`Missing UI element ${id}`);
  return found;
}
function button(id: string): HTMLButtonElement {
  const found = element(id);
  if (!(found instanceof HTMLButtonElement)) throw new TypeError(`Expected button ${id}`);
  return found;
}
const actionButtons = [
  ["keep", "keep"], ["again", "again"], ["play_all", "play-all"], ["hear", "hear"],
  ["record", "record"], ["stop", "stop"], ["home", "home"],
] as const satisfies readonly (readonly [Action, string])[];
const takes = element("takes");
const bar = element("bar");
const lead = element("lead");
if (!(takes instanceof HTMLSelectElement) || !(bar instanceof HTMLInputElement) || !(lead instanceof HTMLInputElement)) throw new TypeError("Invalid form markup");
const takeSelect = takes;
const barInput = bar;
const leadInput = lead;
let takeSignature = "";

export function bind(controller: () => PadController): void {
  for (const [action, id] of actionButtons) button(id).addEventListener("click", () => { void controller().act(action); });
  takeSelect.addEventListener("change", () => {
    const parsed = partIdSchema.safeParse(takeSelect.value);
    controller().choose(parsed.success ? parsed.data : null);
  });
  element("navigation").addEventListener("submit", (event) => {
    event.preventDefault();
    const parsed = barSchema.safeParse(barInput.value);
    if (parsed.success) void controller().act("navigate", parsed.data);
    else barInput.reportValidity();
  });
  element("lead-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const parsed = leadQnSchema.safeParse(leadInput.value);
    if (parsed.success) void controller().act("lead_in", parsed.data);
    else leadInput.reportValidity();
  });
}

export function render(snapshot: Snapshot): void {
  const state = snapshot.state;
  const connected = snapshot.connected && state?.hostAlive === true;
  const phase = !snapshot.paired ? "PAIR PHONE" : !snapshot.visible ? "PAUSED" : !connected ? "DISCONNECTED" : !state?.engaged ? "SETUP NEEDED" : state.phase.toUpperCase().replaceAll("_", " ");
  element("state").textContent = phase;
  document.body.dataset["state"] = state?.recording && connected ? "REC" : state?.playing && connected ? "PLAY" : "PAUSED";
  element("bar-readout").textContent = `bar ${state?.listening.bar.toFixed(1) ?? "—"}`;
  element("target").textContent = `Target · ${targetLabel(snapshot)}`;
  element("entry").textContent = `Entry ${state?.listening.entryQn === null || !state ? "—" : `${state.listening.entryQn} qn`} · Lead ${state?.listening.leadQn ?? "—"} qn`;
  const redo = `Redo ${targetLabel(snapshot)}`;
  element("again-sub").textContent = redo;
  button("again").setAttribute("aria-label", redo);
  element("keep-sub").textContent = state?.reviewId ? "accept · resume" : "accept · roll again";
  button("hear").textContent = state?.recording ? "Review Current Recording" : "Review Selected Take";
  for (const [action, id] of actionButtons) button(id).disabled = !available(action, snapshot);
  takeSelect.disabled = !connected || !state?.engaged || state.recording || snapshot.pending;
  const signature = JSON.stringify(state?.contributions ?? []);
  if (takeSignature !== signature) {
    takeSignature = signature;
    const automatic = new Option("Select a take", "");
    takeSelect.replaceChildren(automatic, ...(state?.contributions ?? []).map((part) => new Option(contributionLabel(part), part.id)));
  }
  takeSelect.value = snapshot.selected ?? "";
  const navigable = available("navigate", snapshot);
  barInput.disabled = !navigable;
  button("go").disabled = !navigable;
  leadInput.disabled = !navigable;
  button("set-lead").disabled = !navigable;
  element("connection").textContent = connected ? state?.busy || snapshot.pending ? "Working…\nStop available" : "Connected\nlocal control" : "Local control\nsame Wi-Fi";
  element("status").textContent = !snapshot.paired ? "Scan the pairing QR from Mosh on the same Wi-Fi. Reloading requires pairing again."
    : !snapshot.visible ? "Backgrounded · controls paused. Returning will refresh the desktop state."
    : !connected ? state?.error || snapshot.message
    : !state?.engaged ? "Arm a track in Mosh and open the Booth to start."
    : state.error || snapshot.message;
}
