// The swappable seam, UI side (00 §0). The React app couples to the C++ backend
// ONLY through this module: execute_command(...), get_snapshot(), and the
// snapshot+events feed. No Tracktion/audio concepts cross this line.
//
// Uses JUCE's own vendored frontend JS (ui/src/juce/, copied from the pinned JUCE
// source) so the native-function invoke protocol is guaranteed to match the
// backend. check_native_interop.js defines a placeholder window.__JUCE__ in a
// plain browser, so the UI still renders during pure-web (Vite dev) work.

import { getNativeFunction } from "./juce/index.js";
import { MOCK_ENABLED, mockExecute, mockSnapshot, mockOnEvent } from "./bridge.mock";

type InitData = {
  __juce__functions?: string[];
  __juce__platform?: string[];
};

const initData = (): InitData =>
  (window as unknown as { __JUCE__?: { initialisationData?: InitData } }).__JUCE__
    ?.initialisationData ?? {};

/** True ONLY inside the real JUCE WebView with native functions bound. Gates the
 *  actual native dispatch (and the dev-mock fallback) below. */
const realNative = (): boolean =>
  (initData().__juce__functions?.length ?? 0) > 0;

/** True when a backend (real native OR the browser dev-mock) is available. The
 *  store keys its data-loading guards off this, so the UI drives identically in
 *  the JUCE WebView and in Vite dev — the dev-mock satisfies the same contract.
 *  In a production `vite build` MOCK_ENABLED is false, so this is real-native only. */
export const isNative = (): boolean => realNative() || MOCK_ENABLED;

/** True ONLY in the packaged app, where a real macOS menu bar owns its accelerators.
 *  The keyboard layer yields native-menu-owned shortcuts here (so they fire once, via
 *  the menu) but keeps handling everything in Vite dev (no native menu). */
export const nativeMenuPresent = (): boolean => realNative();

/** True ONLY inside the real JUCE WebView — i.e. "this is the packaged app, opening a
 *  real project on disk", as distinct from `isNative()`, which is also true for the dev
 *  mock. The session picker gates on this so it is structurally absent from every vitest
 *  and Playwright run rather than relying on a settings flag each spec would have to
 *  remember to seed. */
export const isRealNative = (): boolean => realNative();

/** Deterministic brain substitutes are limited to Vite development and explicit browser e2e. */
export const demoBrainAvailable = (): boolean => MOCK_ENABLED && !realNative();

export const EDITOR_CURSOR_KINDS = [
  "default",
  "crosshair",
  "open-hand",
  "closed-hand",
  "resize-left-right",
] as const;
export type EditorCursorKind = (typeof EDITOR_CURSOR_KINDS)[number];

// Lazily-bound native functions (created once the backend has registered them).
const nativeCache = new Map<string, (...a: unknown[]) => Promise<unknown>>();
function native(name: string) {
  let f = nativeCache.get(name);
  if (!f) {
    f = getNativeFunction(name);
    nativeCache.set(name, f);
  }
  return f;
}

export async function setEditorCursor(kind: EditorCursorKind): Promise<void> {
  if (!realNative()) return;
  await native("set_editor_cursor")({ kind });
}

// ── The public seam ─────────────────────────────────────────────────────────

export type AppInfo = {
  ok: boolean;
  app: string;
  version: string;
  stage: number;
  backend: string;
};

export type RemotePairingInfo = {
  host: string;
  port: number;
  token: string;
  expiresAtMs: number;
  pairingUrl: string;
  webUrl: string;
};

export type RemoteStatus = {
  running: boolean;
  port: number;
  pairing?: RemotePairingInfo;
};

export type RemoteResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export async function ping(): Promise<AppInfo> {
  if (realNative()) return (await native("ping")()) as AppInfo;
  return { ok: MOCK_ENABLED, app: "Mosh", version: "dev", stage: 0, backend: MOCK_ENABLED ? "mock" : "web" };
}

export async function notifyUiReady(): Promise<void> {
  if (!realNative()) return; // mock needs no ready handshake
  await native("ui_ready")();
}

/** The single mutation entry point (MoshOps, 02). Returns a result envelope.
 *  Real native in the WebView; the in-memory dev-mock in Vite dev. */
export async function executeCommand<T = unknown>(command: unknown): Promise<T> {
  if (realNative()) return (await native("execute_command")(command)) as T;
  if (MOCK_ENABLED) return mockExecute<T>(command);
  throw new Error("execute_command: not running in JUCE WebView");
}

/** Full session snapshot on load/resync. */
export async function getSnapshot<T = unknown>(): Promise<T> {
  if (realNative()) return (await native("get_snapshot")()) as T;
  if (MOCK_ENABLED) return mockSnapshot<T>();
  throw new Error("get_snapshot: not running in JUCE WebView");
}

// Moshi's brain talks to an LLM through a SERVER-SIDE proxy (keys never reach the
// client): a native `brain_chat` function in the packaged app, the Vite /api/brain
// proxy in dev. Throws on failure (no proxy / no key); packaged callers fail visibly,
// while the explicit dev/e2e surface may substitute a deterministic demo brain.
// NOT the executeCommand seam — this is a chat round-trip.
export type BrainMessage = { role: string; content: string };
// Per-call overrides layered on the DOSAGE defaults (native BrainProxy::ChatOptions /
// the dev proxy's own 800/0.6 fallback). Every field optional; omitting `options`
// entirely keeps brainChat's wire payload byte-identical to before this existed —
// the produce lane (runTask.ts's PRODUCE_CHAT_OPTIONS) is the first caller to pass one.
export type BrainChatOptions = { maxTokens?: number; timeoutMs?: number; temperature?: number };
// `provider` in the RESULT is which provider actually served (the native side
// resolves a requested-but-incomplete provider by falling back, so callers that
// MUST have a specific class of brain — the produce lane's cloud-only rule —
// verify this field rather than trusting the request).
export async function brainChat(
  messages: BrainMessage[],
  provider?: string,
  options?: BrainChatOptions,
): Promise<{ content: string; provider?: string }> {
  if (realNative()) {
    // Native proxy returns { ok, content } or { ok:false, error }. Throw on the error
    // shape so the caller can apply its packaged/dev posture — same contract as the dev fetch.
    const r = (await native("brain_chat")({ messages, provider, ...(options ? { options } : {}) })) as {
      ok?: boolean;
      content?: string;
      error?: string;
      provider?: string;
    };
    if (r && r.ok === false) throw new Error(r.error ? String(r.error) : "brain unavailable");
    return { content: String(r?.content ?? ""), provider: r?.provider ? String(r.provider) : undefined };
  }
  const r = await fetch("/api/brain/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, provider, ...(options ? { options } : {}) }),
  });
  let j: { content?: string; error?: unknown } = {};
  try { j = await r.json(); } catch { /* non-JSON error body */ }
  if (!r.ok) throw new Error(j?.error ? String(j.error) : `brain proxy ${r.status}`);
  return { content: String(j.content ?? "") };
}

export type BrainRuntimeStatus = {
  state: "starting" | "ready" | "prewarming" | "unavailable";
  model?: string;
  endpoint?: string;
  port?: number;
  error?: string;
  ms?: number;
  preferredShell?: "live" | "protools" | "v2" | "classic";
};
export async function brainRuntimeStatus(): Promise<BrainRuntimeStatus> {
  if (!realNative()) return { state: "unavailable", error: "owner runtime is native-only" };
  return (await native("brain_runtime_status")()) as BrainRuntimeStatus;
}

// WP-11 best-of-n relays (native-only — the WebView reaches the generative service
// through the app, never directly; same layering as brain_chat). In dev/mock there
// is no service to escalate to: escalateCandidates throws (the hook degrades to the
// single-shot reply) and archivePair no-ops.
export async function escalateCandidates(payload: unknown): Promise<unknown> {
  if (realNative()) {
    const r = (await native("escalate_candidates")(payload)) as { ok?: boolean; error?: string };
    if (r && r.ok === false) throw new Error(r.error ? String(r.error) : "escalation unavailable");
    return r;
  }
  throw new Error("escalate_candidates: native only");
}
export async function archivePair(row: unknown): Promise<void> {
  if (realNative()) await native("archive_pair")(row);
}

// Native speech-to-text (packaged app). The browser Web Speech API covers the Vite
// dev path; WKWebView lacks it, so there we drive macOS Speech via these wrappers.
// Transcripts arrive on the "voice_event" channel (subscribe with onEvent). All are
// no-ops outside the real WebView, so voiceInput.ts can branch on nativeVoiceAvailable().
export function nativeVoiceAvailable(): boolean { return realNative(); }
export async function voiceSupported(): Promise<boolean> {
  if (!realNative()) return false;
  try { const r = (await native("voice_supported")()) as { supported?: boolean }; return !!r?.supported; }
  catch { return false; }
}
export async function voiceStart(): Promise<void> { if (realNative()) await native("voice_start")(); }
export async function voiceStop(): Promise<void> { if (realNative()) await native("voice_stop")(); }
// Always-on (hands-free) variants — a continuous session emits MANY `final`s on the same
// voice_event channel and only ends on voice_listen_stop / a fatal error.
export async function voiceListenStart(): Promise<void> { if (realNative()) await native("voice_listen_start")(); }
export async function voiceListenStop(): Promise<void> { if (realNative()) await native("voice_listen_stop")(); }

export async function startRemotePairing(): Promise<RemoteResult<RemoteStatus>> {
  if (!realNative()) return { ok: false, error: "remote companion unavailable in dev" };
  return (await native("remote_start_pairing")({})) as RemoteResult<RemoteStatus>;
}

export async function stopRemoteCompanion(): Promise<RemoteResult> {
  if (!realNative()) return { ok: false, error: "remote companion unavailable in dev" };
  return (await native("remote_stop")({})) as RemoteResult;
}

export async function getRemoteStatus(): Promise<RemoteResult<RemoteStatus>> {
  if (!realNative()) return { ok: false, error: "remote companion unavailable in dev" };
  return (await native("remote_status")()) as RemoteResult<RemoteStatus>;
}

// Telemetry opt-in sync (privacy-first, default OFF — see docs/telemetry/PRIVACY.md
// and settings/schema.ts's telemetryOptIn descriptor). Fire-and-forget notification
// to the native crash/telemetry module, which persists the bit to a small flag file
// (~/Library/Mosh/telemetry.optin) it reads directly — deliberately NOT a MoshOps
// command. No-op outside the real WebView (dev/mock/tests never touch the
// filesystem or a native function that isn't registered there), mirroring
// archivePair()'s real-native-only posture above.
export async function setTelemetryOptIn(optIn: boolean): Promise<void> {
  if (realNative()) await native("set_telemetry_optin")({ optIn });
}

// Native file pickers (wave: settings). These are async message-thread dialogs, so
// they are dedicated native functions (not commands) returning a Promise. The actual
// import/open/save still happens via import_clip / open_project / save_as commands —
// the mutation seam is preserved; the dialog only resolves paths.
export async function pickFiles(opts?: {
  multiple?: boolean;
  filters?: string;
  title?: string;
}): Promise<{ ok: boolean; files: string[] }> {
  if (!realNative()) {
    if (MOCK_ENABLED && opts?.title === "Open project") {
      return { ok: true, files: ["/mock/sessions/protools-tonight.mosh"] };
    }
    return { ok: false, files: [] };
  }
  return (await native("pick_files")(opts ?? {})) as { ok: boolean; files: string[] };
}

export async function pickSaveFile(opts?: {
  filters?: string;
  title?: string;
  defaultName?: string;
}): Promise<{ ok: boolean; file: string }> {
  if (!realNative()) {
    if (!MOCK_ENABLED) return { ok: false, file: "" };
    if (opts?.title === "Save project as") {
      return { ok: true, file: "/mock/sessions/protools-tonight.mosh" };
    }
    if (opts?.title === "Export audio") {
      return { ok: true, file: "/mock/exports/mix.wav" };
    }
    return { ok: false, file: "" };
  }
  return (await native("pick_save_file")(opts ?? {})) as { ok: boolean; file: string };
}

// Skill Foundry Task 4 — three DEDICATED, non-MoshOps native reads for the certified
// skill loader (src/agent/CertifiedSkillLoader.{h,cpp}). Each is its OWN top-level
// `.withNativeFunction` on WebBridge (src/webview/WebBridge.cpp), threaded exactly like
// brain_chat/escalate_candidates/archive_pair above — never dispatched through
// commandHandler, never a MoshOps command, never reachable via executeCommand's
// execute_command seam. See ui/src/agent/skillFoundry/nativeBridgeBoundary.test.ts for the
// durable guard proving that boundary from both the TS and the native-source side.
//
// Outside the real WebView (Vite dev/test) there is no filesystem admission to run, and —
// unlike escalateCandidates()/archivePair() above — a missing owner skill directory is the
// ORDINARY case in dev, not an error, so the mock/test path returns an explicit, empty,
// well-typed envelope (ok:true, zero packages) rather than throwing. It never touches disk.
const EMPTY_CERTIFIED_SKILL_LOAD = Object.freeze({
  schemaVersion: 1 as const,
  ok: true as const,
  activeIndex: null,
  sourceStatusIndex: null,
  packages: [] as const,
  diagnostics: [] as const,
  totalBytes: 0,
});

const EMPTY_SOURCE_STATUS_READ = Object.freeze({
  schemaVersion: 1 as const,
  ok: true as const,
  statusIndex: null,
  diagnostics: [] as const,
});

const DEV_BUILD_IDENTITY = Object.freeze({
  appVersion: "0.0.0-dev",
  gitCommit: "0".repeat(40),
  gitState: "unknown" as const,
  moshBuildIdentity: `git=${"0".repeat(40)}|version=0.0.0-dev|target=Mosh|configuration=Debug|architecture=dev`,
});

const EMPTY_CERTIFIED_NATIVE_SKILL_LOAD = Object.freeze({
  schemaVersion: 1 as const,
  ok: true as const,
  build: DEV_BUILD_IDENTITY,
  resourceIndex: null,
  packages: [] as const,
  diagnostics: [] as const,
  totalBytes: 0,
});

/** Raw native/mock envelope for the owner-local certified-skill package tree. Callers use
 *  the typed V1 wrapper in ui/src/agent/skillFoundry/nativeReads.ts, not this directly. */
export async function readCertifiedSkillPackages(): Promise<unknown> {
  if (realNative()) return await native("read_certified_skill_packages")();
  return EMPTY_CERTIFIED_SKILL_LOAD;
}

/** Raw native/mock envelope for the source-status index alone (a cheap, per-invocation
 *  staleness re-check — see nativeReads.ts / CertifiedSkillLoader.h for why this is a
 *  separate call from readCertifiedSkillPackages() rather than reusing its result). */
export async function readSkillSourceStatus(): Promise<unknown> {
  if (realNative()) return await native("read_skill_source_status")();
  return EMPTY_SOURCE_STATUS_READ;
}

/** Raw native/mock envelope for the bundled native-skill package tree (app resources —
 *  never $MOSH_AGENT_DIR). */
export async function readCertifiedNativeSkills(): Promise<unknown> {
  if (realNative()) return await native("read_certified_native_skills")();
  return EMPTY_CERTIFIED_NATIVE_SKILL_LOAD;
}

/** Subscribe to a typed backend event (snapshot+events feed, 02 §4).
 *  Returns an unsubscribe fn. No-op in pure-web dev. */
export function onEvent(eventId: string, fn: (payload: unknown) => void): () => void {
  if (!realNative()) return MOCK_ENABLED ? mockOnEvent(eventId, fn) : () => {};
  const backend = (
    window as unknown as {
      __JUCE__?: {
        backend?: {
          addEventListener: (id: string, fn: (p: unknown) => void) => [string, number];
          removeEventListener: (h: [string, number]) => void;
        };
      };
    }
  ).__JUCE__?.backend;
  if (!backend) return () => {};
  const handle = backend.addEventListener(eventId, fn);
  return () => backend.removeEventListener(handle);
}
