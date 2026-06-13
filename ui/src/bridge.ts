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

// Native file pickers (wave: settings). These are async message-thread dialogs, so
// they are dedicated native functions (not commands) returning a Promise. The actual
// import/open/save still happens via import_clip / open_project / save_as commands —
// the mutation seam is preserved; the dialog only resolves paths.
export async function pickFiles(opts?: {
  multiple?: boolean;
  filters?: string;
  title?: string;
}): Promise<{ ok: boolean; files: string[] }> {
  if (!isNative()) return { ok: false, files: [] };
  return (await native("pick_files")(opts ?? {})) as { ok: boolean; files: string[] };
}

export async function pickSaveFile(opts?: {
  filters?: string;
  title?: string;
  defaultName?: string;
}): Promise<{ ok: boolean; file: string }> {
  if (!isNative()) return { ok: false, file: "" };
  return (await native("pick_save_file")(opts ?? {})) as { ok: boolean; file: string };
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
