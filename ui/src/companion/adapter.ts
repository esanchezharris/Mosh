import {
  AbletonActionRequestSchema,
  AbletonEnvelopeSchema,
  AbletonSnapshotSchema,
  RequestIdSchema,
  type AbletonSnapshot,
} from "./abletonSchema";
import type { Plan } from "./commandMap";
import { planFor, seekPlan } from "./commandMap";
import type { Snap } from "./types";
import type { Button } from "./types";
import { abletonView, moshView } from "./viewState";

export type ControllerMode = "mosh" | "ableton";
export type ControllerStatus = "disconnected" | "busy" | "blocked" | "recording" | "pending" | "playing" | "paused";
export type TimelineUnit = "seconds" | "beats";
export type TimelineRegion = { readonly start: number; readonly end: number };
export type ControllerView = {
  readonly mode: ControllerMode;
  readonly unit: TimelineUnit;
  readonly revision: number;
  readonly position: number;
  readonly length: number;
  readonly regions: readonly TimelineRegion[];
  readonly statuses: readonly ControllerStatus[];
  readonly seekEnabled: boolean;
  readonly blockedReason?: string;
  readonly tempo?: number;
  readonly timeSigNumerator?: number;
};
export type AdapterResult =
  | { readonly kind: "ok" }
  | { readonly kind: "busy" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string };

export interface ControllerAdapter {
  readonly mode: ControllerMode;
  readonly buttons: readonly Button[];
  poll(): Promise<ControllerView>;
  press(button: Button): Promise<AdapterResult>;
  seek(position: number): Promise<AdapterResult>;
  isBusy(): boolean;
}

export interface AbletonBoundary {
  snapshot(): Promise<unknown>;
  action(request: unknown): Promise<unknown>;
}

export interface MoshBoundary {
  snapshot(): Promise<Snap>;
  runPlan(plan: Plan): Promise<{ readonly ok: boolean; readonly note?: string }>;
}

export class MoshAdapter {
  readonly mode: "mosh" = "mosh";
  readonly buttons: readonly Button[] = ["keep", "again", "hear", "marker", "record", "stop"];
  readonly #client: MoshBoundary;
  #snapshot: Snap | null = null;

  constructor(client: MoshBoundary) {
    this.#client = client;
  }
  async poll(): Promise<ControllerView> {
    this.#snapshot = await this.#client.snapshot();
    return moshView(this.#snapshot);
  }
  async press(button: Button): Promise<AdapterResult> {
    const plan = planFor(button, this.#snapshot);
    if (plan.blockedReason !== undefined) return { kind: "blocked", reason: plan.blockedReason };
    const result = await this.#client.runPlan(plan);
    return result.ok ? { kind: "ok" } : { kind: "error", reason: result.note ?? "Mosh command failed" };
  }
  async seek(position: number): Promise<AdapterResult> {
    const result = await this.#client.runPlan(seekPlan(position));
    return result.ok ? { kind: "ok" } : { kind: "error", reason: result.note ?? "Mosh seek failed" };
  }
  isBusy(): boolean {
    return false;
  }
}

export class AbletonAdapter {
  readonly mode: "ableton" = "ableton";
  readonly buttons: readonly Button[] = ["keep", "again", "hear", "record", "stop"];
  readonly #client: AbletonBoundary;
  readonly #requestId: () => string;
  #busy = false;
  #snapshot: AbletonSnapshot | null = null;
  #lastError: string | null = null;

  constructor(client: AbletonBoundary, requestId: () => string = createRequestId) {
    this.#client = client;
    this.#requestId = requestId;
  }
  async poll(): Promise<ControllerView> {
    const envelope = AbletonEnvelopeSchema.parse(await this.#client.snapshot());
    if (!envelope.ok) return Promise.reject(new BridgeResponseError(envelope.error));
    this.#snapshot = envelope.state;
    return this.view(envelope.state);
  }
  view(snapshot: AbletonSnapshot): ControllerView {
    const base = abletonView(snapshot, this.#busy);
    if (this.#lastError === null) return base;
    const disconnected = this.#lastError === "script_disconnected";
    const status = disconnected ? "disconnected" : "blocked";
    return {
      ...base,
      statuses: [status, ...base.statuses.filter((value) => value !== status)],
      seekEnabled: false,
      blockedReason: this.#lastError,
    };
  }
  async press(button: Button, snapshot: AbletonSnapshot | null = this.#snapshot): Promise<AdapterResult> {
    if (snapshot === null) return { kind: "blocked", reason: "waiting for Ableton state" };
    const action = actionForButton(button);
    if (action === null) return { kind: "blocked", reason: "MARKER is unavailable in Ableton mode" };
    return this.#perform({ requestId: this.#requestId(), expectedRevision: snapshot.revision, action });
  }
  async seek(position: number, snapshot: AbletonSnapshot | null = this.#snapshot): Promise<AdapterResult> {
    if (snapshot === null) return { kind: "blocked", reason: "waiting for Ableton state" };
    if (snapshot.transport === "recording") return { kind: "blocked", reason: "seek is disabled while recording" };
    const positionBeats = Number.isFinite(position) && position > 0 ? position : 0;
    return this.#perform({
      requestId: this.#requestId(),
      expectedRevision: snapshot.revision,
      action: "seek",
      positionBeats,
    });
  }
  isBusy(): boolean {
    return this.#busy;
  }
  async #perform(external: unknown): Promise<AdapterResult> {
    if (this.#busy) return { kind: "busy" };
    this.#busy = true;
    try {
      const request = AbletonActionRequestSchema.parse(external);
      const envelope = AbletonEnvelopeSchema.parse(await this.#client.action(request));
      if (envelope.requestId !== request.requestId) {
        this.#lastError = "mismatched_action_response";
        return { kind: "error", reason: "mismatched action response" };
      }
      if (!envelope.ok) {
        this.#lastError = envelope.error;
        const parsedState = AbletonSnapshotSchema.safeParse(envelope.state);
        if (parsedState.success) this.#snapshot = parsedState.data;
        return { kind: "error", reason: envelope.error };
      }
      this.#lastError = null;
      this.#snapshot = envelope.state;
      return { kind: "ok" };
    } finally {
      this.#busy = false;
    }
  }
}

export function createRequestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return RequestIdSchema.parse(`dawn-${hex}`);
}

type AbletonButtonAction = "put" | "keep" | "again" | "hear" | "stop";

function actionForButton(button: Button): AbletonButtonAction | null {
  switch (button) {
    case "record":
      return "put";
    case "keep":
      return "keep";
    case "again":
      return "again";
    case "hear":
      return "hear";
    case "stop":
      return "stop";
    case "marker":
      return null;
  }
}

export class BridgeResponseError extends Error {
  readonly name = "BridgeResponseError";
  constructor(readonly code: string) {
    super(code);
  }
}
