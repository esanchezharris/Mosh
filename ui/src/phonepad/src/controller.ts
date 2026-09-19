import { requestIdSchema } from "./contract";
import type { Action, Command, PartId, RequestId, State } from "./contract";
import { actionTarget, available, terminal } from "./policy";
import type { PadContext } from "./policy";
import { PadTransport, TransportError } from "./transport";

export type Snapshot = PadContext & { readonly message: string; readonly paired: boolean; readonly visible: boolean };

export class PadController {
  private state: State | null = null;
  private connected = false;
  private selected: PartId | null = null;
  private visible = true;
  private message = "Connecting to Mosh…";
  private connectionIssue = true;
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readAbort: AbortController | undefined;
  private readEpoch = 0;
  private readonly pending = new Map<RequestId, Action>();

  constructor(private transport: PadTransport | null, private readonly render: (snapshot: Snapshot) => void) {}

  dispose(): void { this.setVisible(false); }
  choose(id: PartId | null): void { this.selected = id; this.publish(); }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.connected = false;
    this.cancelRead();
    this.publish();
    if (visible) void this.poll();
  }

  private snapshot(): Snapshot {
    return { state: this.state, connected: this.connected, selected: this.selected,
      pending: this.pending.size > 0,
      message: this.message, paired: this.transport !== null, visible: this.visible };
  }
  private publish(): void { this.render(this.snapshot()); }
  private cancelRead(): void {
    this.readEpoch += 1;
    this.readAbort?.abort();
    clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    if (!this.visible || this.transport === null) return;
    this.cancelRead();
    const epoch = this.readEpoch;
    const abort = new AbortController();
    this.readAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 1500);
    try {
      const state = await this.transport.read(abort.signal);
      if (epoch !== this.readEpoch || !this.visible) return;
      if (this.state !== null && (state.sessionId !== this.state.sessionId || state.projectId !== this.state.projectId)) {
        this.pending.clear(); this.selected = null;
        this.message = "Mosh session changed. Actions now use the current session.";
      }
      this.state = state;
      this.connected = true;
      if (this.connectionIssue && this.pending.size === 0) this.message = "Ready. Phone and Mac stay on the same Wi-Fi.";
      this.connectionIssue = false;
      for (const receipt of state.receipts) {
        if (this.pending.has(receipt.requestId) && terminal(receipt)) {
          this.pending.delete(receipt.requestId);
          this.message = receipt.detail || `${receipt.action}: ${receipt.status}`;
        }
      }
    } catch (error) {
      if (epoch !== this.readEpoch) return;
      if (!(error instanceof TransportError)) throw error;
      this.connected = false;
      this.connectionIssue = true;
      this.message = error.message;
      if (error.kind === "auth") this.transport = null;
    } finally {
      clearTimeout(timeout);
      if (epoch === this.readEpoch) {
        this.publish();
        if (this.visible && this.transport !== null) this.timer = setTimeout(() => { void this.poll(); }, 200);
      }
    }
  }

  async act(action: Action, value?: number): Promise<void> {
    const snapshot = this.snapshot();
    const state = snapshot.state;
    const transport = this.transport;
    if (state === null || transport === null || !available(action, snapshot)) return;
    if (action === "stop" && this.stopping) return;
    const id = actionTarget(action, snapshot);
    const command: Command = {
      version: 1, requestId: requestIdSchema.parse(Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")),
      sessionId: state.sessionId, projectId: state.projectId, authority: state.authority, action,
      ...(id !== null ? { targetId: id } : {}),
      ...(action === "navigate" && value !== undefined ? { bar: value } : {}),
      ...(action === "lead_in" && value !== undefined ? { leadQn: value } : {}),
    };
    this.pending.set(command.requestId, action);
    if (action === "stop") this.stopping = true;
    this.message = `${action === "again" ? "Redo" : action === "play_all" ? "Play All" : action} requested…`;
    this.cancelRead();
    this.publish();
    try {
      const response = await transport.submit(command);
      if (response.receipt.requestId !== command.requestId || response.receipt.action !== action) throw new TransportError("protocol");
      if (terminal(response.receipt)) this.pending.delete(command.requestId);
      this.message = response.receipt.detail || `${action}: ${response.receipt.status}`;
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      this.message = "Response lost. Checking the receipt; this action will not be sent again.";
      if (error.kind === "auth") { this.transport = null; this.connected = false; this.message = error.message; }
      if (error.kind === "http" && error.status >= 400 && error.status < 500) {
        this.pending.delete(command.requestId); this.message = `Action rejected (${error.status}).`;
      }
      if (error.kind === "rejected") { this.pending.delete(command.requestId); this.message = error.message; }
    } finally {
      if (action === "stop") this.stopping = false;
      this.publish();
      if (this.visible) void this.poll();
    }
  }
}
