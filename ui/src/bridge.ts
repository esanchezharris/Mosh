// The swappable seam, UI side (00 §0). The React app couples to the C++ backend
// ONLY through this module: execute_command(...), get_snapshot(), and the
// snapshot+events feed. No Tracktion/audio concepts cross this line.
//
// Uses JUCE's own vendored frontend JS (ui/src/juce/, copied from the pinned JUCE
// source) so the native-function invoke protocol is guaranteed to match the
// backend. check_native_interop.js defines a placeholder window.__JUCE__ in a
// plain browser, so the UI still renders during pure-web (Vite dev) work.

import { getNativeFunction } from "./juce/index.js";

type InitData = {
  __juce__functions?: string[];
  __juce__platform?: string[];
};

const initData = (): InitData =>
  (window as unknown as { __JUCE__?: { initialisationData?: InitData } }).__JUCE__
    ?.initialisationData ?? {};

/** True when running inside the JUCE WebView with real native functions bound
 *  (distinguishes the real backend from check_native_interop's placeholder). */
export const isNative = (): boolean =>
  (initData().__juce__functions?.length ?? 0) > 0;

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
  if (!isNative())
    return { ok: false, app: "Mosh", version: "dev", stage: 0, backend: "web" };
  return (await native("ping")()) as AppInfo;
}

export async function notifyUiReady(): Promise<void> {
  if (!isNative()) return;
  await native("ui_ready")();
}

/** The single mutation entry point (MoshOps, 02). Returns a result envelope. */
export async function executeCommand<T = unknown>(command: unknown): Promise<T> {
  if (!isNative()) throw new Error("execute_command: not running in JUCE WebView");
  return (await native("execute_command")(command)) as T;
}

/** Full session snapshot on load/resync. */
export async function getSnapshot<T = unknown>(): Promise<T> {
  if (!isNative()) throw new Error("get_snapshot: not running in JUCE WebView");
  return (await native("get_snapshot")()) as T;
}

export async function startRemotePairing(): Promise<RemoteResult<RemoteStatus>> {
  if (!isNative()) throw new Error("remote_start_pairing: not running in JUCE WebView");
  return (await native("remote_start_pairing")({})) as RemoteResult<RemoteStatus>;
}

export async function stopRemoteCompanion(): Promise<RemoteResult> {
  if (!isNative()) throw new Error("remote_stop: not running in JUCE WebView");
  return (await native("remote_stop")({})) as RemoteResult;
}

export async function getRemoteStatus(): Promise<RemoteResult<RemoteStatus>> {
  if (!isNative()) throw new Error("remote_status: not running in JUCE WebView");
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
