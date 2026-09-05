// Thin HTTP client for the native RemoteCompanionServer (src/remote/
// RemoteCompanionServer.cpp), the same surface the phone controller and the
// design-lab feed use — port 47873 by default (RemoteCompanionProtocol.h:27).
// Used by the headless overnight driver (produceLiveRun.mts, produceReplay.mts)
// to run a produce-lane task against a REAL running app instance instead of a
// bench replay: POST /command runs moshOps->execute on the message thread,
// POST /snapshot returns the same snapshot the WebView sees, GET /health
// reports whether the engine started.
//
// Response shape (verified from RemoteCompanionServer.cpp's ok()/err() +
// handleRequest's /command branch): the HTTP envelope is ALWAYS
// `{ok:true, data:<inner>}` on a 200 (auth/parse failures 400/401 the outer
// envelope itself) — `<inner>` is the actual MoshOps::execute() result, e.g.
// `{ok:true, data:{...}}` or `{ok:false, error:"..."}`. This client unwraps
// one level and returns the INNER envelope to callers.
//
// Companion command timeout (W3.1, native, not yet landed at the time this
// client was written): RemoteCompanionServer.cpp's callOnMessageThread returns
// `err("message-thread call timed out")` after 5000ms while the command keeps
// running server-side — a real hazard for export_audio/save_as/Vital
// load_plugin/load_preset, all of which can run past that. We always SEND
// `timeoutMs` in the POST body (harmless no-op against a server that doesn't
// read it yet; honoured once W3.1 lands — RemoteCompanionServer.cpp:284 reads
// `propInt(body,"timeoutMs",5000)`). When the response comes back as that exact
// timeout error, we do NOT treat it as a failure — the command is very likely
// still finishing message-thread-side. Instead we tail
// ~/Library/Mosh/session/mosh-log.jsonl (every executed command, ok/error, one
// JSON object per line — MoshOps' own audit log) for a NEW line naming this
// command, and trust its `ok`/`error` fields. This mirrors how a human
// watching the log would resolve the same ambiguity.

import {
  closeSync, existsSync, fstatSync, openSync, readSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "../../src/types";

export const DEFAULT_COMPANION_URL = "http://127.0.0.1:47873";
export const DEFAULT_LOG_PATH = join(homedir(), "Library", "Mosh", "session", "mosh-log.jsonl");
const TIMED_OUT_ERROR = /message-thread call timed out/i;

export type CommandResult = { ok: boolean; error?: string; data?: unknown; timedOutFallback?: boolean };

export type CompanionClientConfig = {
  url: string;
  token: string;
  /** mosh-log.jsonl path used for the timeout fallback. */
  logPath?: string;
  /** Default per-command timeoutMs when a call doesn't override it. */
  defaultTimeoutMs?: number;
  /** How long to keep polling the log after a companion-side timeout before
   *  giving up (defaults to max(commandTimeoutMs, 60_000) — export/render/
   *  Vital-preset calls can legitimately run for minutes). */
  fallbackTimeoutMs?: number;
};

export type CompanionClient = {
  health(): Promise<boolean>;
  snapshot(): Promise<Snapshot>;
  command(name: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number; fallbackTimeoutMs?: number }): Promise<CommandResult>;
  eventsSince(since: number): Promise<{ events: unknown[]; now?: number } | unknown>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok && !(parsed && typeof parsed === "object" && "ok" in (parsed as Record<string, unknown>)))
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** Byte offset at the current end of the log file (0 if it doesn't exist yet). */
function currentLogSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

/** Read whatever COMPLETE lines have been appended to `logPath` since
 *  `fromOffset`, without re-reading the whole (tens-of-MB) file each poll. A
 *  trailing partial line (the writer mid-flush) is left for the next call. */
function readNewLines(logPath: string, fromOffset: number): { lines: string[]; nextOffset: number } {
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return { lines: [], nextOffset: fromOffset };
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= fromOffset) return { lines: [], nextOffset: fromOffset };
    const len = size - fromOffset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromOffset);
    const text = buf.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return { lines: [], nextOffset: fromOffset }; // no complete line yet
    const complete = text.slice(0, lastNewline);
    const nextOffset = fromOffset + lastNewline + 1;
    const lines = complete.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    return { lines, nextOffset };
  } finally {
    closeSync(fd);
  }
}

/** Poll `logPath` for the next line naming `command`, appended after
 *  `fromOffset`. Returns its ok/error, or null on timeout. */
async function waitForLogLine(
  logPath: string,
  fromOffset: number,
  command: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  let offset = fromOffset;
  for (;;) {
    const { lines, nextOffset } = readNewLines(logPath, offset);
    offset = nextOffset;
    for (const line of lines) {
      let rec: Record<string, unknown> | undefined;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // tolerate a torn line at the poll boundary
      }
      if (rec && rec.command === command) {
        const ok = rec.ok === true;
        return { ok, error: ok ? undefined : (typeof rec.error === "string" ? rec.error : "command failed (observed via mosh-log.jsonl)") };
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

export function makeCompanionClient(cfg: CompanionClientConfig): CompanionClient {
  const url = cfg.url.replace(/\/$/, "");
  const logPath = cfg.logPath ?? DEFAULT_LOG_PATH;
  const defaultTimeoutMs = cfg.defaultTimeoutMs ?? 20_000;

  return {
    async health() {
      try {
        const res = await fetch(`${url}/health`, { method: "GET" });
        if (!res.ok) return false;
        const body = (await res.json()) as Record<string, unknown>;
        const data = body.data as Record<string, unknown> | undefined;
        return body.running === true || data?.running === true;
      } catch {
        return false;
      }
    },

    async snapshot() {
      const resp = (await postJson(`${url}/snapshot`, { token: cfg.token }, defaultTimeoutMs)) as
        | { ok?: boolean; error?: string; data?: unknown }
        | undefined;
      if (!resp || resp.ok !== true) throw new Error(`companion /snapshot failed: ${resp?.error ?? "unknown error"}`);
      return resp.data as Snapshot;
    },

    async command(name, args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      const baseline = currentLogSize(logPath);
      const body = { token: cfg.token, command: { command: name, args }, timeoutMs };
      let resp: { ok?: boolean; error?: string; data?: unknown } | undefined;
      try {
        resp = (await postJson(`${url}/command`, body, timeoutMs + 5_000)) as typeof resp;
      } catch (e) {
        return { ok: false, error: `companion /command ${name} network error: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
      }
      if (!resp || resp.ok !== true)
        return { ok: false, error: `companion /command ${name} envelope error: ${resp?.error ?? "unknown error"}` };

      const inner = (resp.data ?? {}) as { ok?: boolean; error?: string; data?: unknown };
      const timedOut = inner.ok === false && typeof inner.error === "string" && TIMED_OUT_ERROR.test(inner.error);
      if (!timedOut) return { ok: inner.ok === true, error: inner.ok === true ? undefined : inner.error, data: inner.data };

      const fallbackTimeoutMs = opts.fallbackTimeoutMs ?? cfg.fallbackTimeoutMs ?? Math.max(timeoutMs, 60_000);
      const fromLog = await waitForLogLine(logPath, baseline, name, fallbackTimeoutMs);
      if (fromLog) return { ok: fromLog.ok, error: fromLog.error, timedOutFallback: true };
      return {
        ok: false,
        error: `companion timed out waiting for ${name}, and no matching line appeared in ${logPath} within ${fallbackTimeoutMs}ms`,
        timedOutFallback: true,
      };
    },

    async eventsSince(since) {
      const resp = (await postJson(`${url}/events`, { token: cfg.token, since }, defaultTimeoutMs)) as
        | { ok?: boolean; error?: string; data?: unknown }
        | undefined;
      if (!resp || resp.ok !== true) throw new Error(`companion /events failed: ${resp?.error ?? "unknown error"}`);
      return resp.data;
    },
  };
}

// ── whole-mix silence check ────────────────────────────────────────────────
// A minimal PCM WAV reader — just enough to compute RMS in dBFS for the
// overnight package's `silentRender` flag (< -60 dBFS ⇒ probably an empty
// render, e.g. a track with no notes or a broken plugin chain). Handles the
// common `fmt ` layouts MOSH's own exporter and Tracktion's renderer produce:
// 16/24/32-bit signed PCM (format 1) and 32-bit float (format 3). Anything
// else (unexpected format, truncated/corrupt file) throws — callers should
// treat a throw the same as "couldn't prove this isn't silent."
export function wavRmsDbfs(path: string): number {
  if (!existsSync(path)) throw new Error(`wavRmsDbfs: no such file: ${path}`);
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 44) throw new Error(`wavRmsDbfs: file too small to be a WAV: ${path}`);
    const header = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, header, 0, header.length, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE")
      throw new Error(`wavRmsDbfs: not a RIFF/WAVE file: ${path}`);

    let audioFormat = 1;
    let channels = 1;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let dataLength = 0;
    let cursor = 12;
    // Walk RIFF sub-chunks in the header buffer; if `data` lands past our
    // 4096-byte peek (an unusually large `fmt `/extra chunk), re-scan with a
    // wider read rather than fail outright.
    let scanBuf = header;
    let scanLen = header.length;
    for (;;) {
      while (cursor + 8 <= scanLen) {
        const id = scanBuf.toString("ascii", cursor, cursor + 4);
        const chunkSize = scanBuf.readUInt32LE(cursor + 4);
        const bodyOffset = cursor + 8;
        if (id === "fmt ") {
          audioFormat = scanBuf.readUInt16LE(bodyOffset);
          channels = scanBuf.readUInt16LE(bodyOffset + 2);
          bitsPerSample = scanBuf.readUInt16LE(bodyOffset + 14);
        } else if (id === "data") {
          dataOffset = bodyOffset;
          dataLength = Math.min(chunkSize, size - bodyOffset);
          break;
        }
        cursor = bodyOffset + chunkSize + (chunkSize % 2); // chunks are word-aligned
      }
      if (dataOffset >= 0 || scanLen >= size) break;
      scanLen = size;
      scanBuf = Buffer.alloc(size);
      readSync(fd, scanBuf, 0, size, 0);
    }
    if (dataOffset < 0 || dataLength <= 0) throw new Error(`wavRmsDbfs: no data chunk found: ${path}`);
    if (audioFormat !== 1 && audioFormat !== 3)
      throw new Error(`wavRmsDbfs: unsupported WAV format code ${audioFormat}: ${path}`);
    if (![8, 16, 24, 32].includes(bitsPerSample))
      throw new Error(`wavRmsDbfs: unsupported bit depth ${bitsPerSample}: ${path}`);

    // `channels` only matters if a future caller wants per-channel RMS; whole-
    // mix silence detection treats the interleaved stream as one sample series.
    void channels;
    const bytesPerSample = bitsPerSample / 8;
    const sampleCount = Math.floor(dataLength / bytesPerSample);
    if (sampleCount === 0) return -Infinity;

    // Stream the data chunk in chunks of ~1M frames to bound memory on a long
    // 8-bar loop render.
    const CHUNK_BYTES = 1 << 20;
    let sumSquares = 0;
    let counted = 0;
    let readOffset = dataOffset;
    const dataEnd = dataOffset + dataLength;
    const buf = Buffer.alloc(Math.min(CHUNK_BYTES, dataLength));
    while (readOffset < dataEnd) {
      const want = Math.min(buf.length, dataEnd - readOffset);
      const got = readSync(fd, buf, 0, want, readOffset);
      if (got <= 0) break;
      const usable = got - (got % bytesPerSample);
      for (let i = 0; i + bytesPerSample <= usable; i += bytesPerSample) {
        let normalized: number;
        if (audioFormat === 3 && bitsPerSample === 32) {
          normalized = buf.readFloatLE(i);
        } else if (bitsPerSample === 8) {
          normalized = (buf.readUInt8(i) - 128) / 128;
        } else if (bitsPerSample === 16) {
          normalized = buf.readInt16LE(i) / 32768;
        } else if (bitsPerSample === 24) {
          const b0 = buf[i]!, b1 = buf[i + 1]!, b2 = buf[i + 2]!;
          let v = b0 | (b1 << 8) | (b2 << 16);
          if (v & 0x800000) v -= 0x1000000;
          normalized = v / 8388608;
        } else {
          normalized = buf.readInt32LE(i) / 2147483648;
        }
        sumSquares += normalized * normalized;
        counted += 1;
      }
      readOffset += got;
    }
    if (counted === 0) return -Infinity;
    const rms = Math.sqrt(sumSquares / counted);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  } finally {
    closeSync(fd);
  }
}
