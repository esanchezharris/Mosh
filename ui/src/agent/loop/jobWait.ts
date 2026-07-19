// Async-job settling for agent steps. A render (render_layer / compile_render
// with autoRender) returns ok when the JOB SUBMITS — the audio lands later via
// events. The loop's observation must see the SETTLED state, so after a step
// that started renders we poll the env's own snapshot (env-agnostic: works on
// the app store, the dev mock — instant there — and the bench's replay env)
// until no started clip is still queued/rendering. Abort cancels the job;
// timeout returns honestly rather than hanging a task.
//
// NEVER wait:true on the native seam — that blocks the message thread. The
// polling here rides getSnapshot, which is a read.

import type { AgentEnv } from "../loopSeam";
import type { Snapshot } from "../../types";

type SnapshotSource = Pick<AgentEnv, "getSnapshot">;

/** Commands whose ok = "job submitted", not "audio landed". */
export const RENDER_JOB_COMMANDS = new Set(["render_layer", "compile_render"]);

/** Service-spawning / slow commands — the drawer narrates these while running
 *  (the first call can freeze ~1-2s while the service warms; say so). */
export const SERVICE_SPAWNING = new Set([
  "render_layer", "compile_render", "get_rhymes", "complete_lyrics", "fill_lyric_gap",
  "suggest_next_line", "regenerate_lyric", "analyze_lyrics", "transcribe_clip",
  "build_skeleton_from_clip", "sketch_beatbox", "export_audio", "export_stems",
]);

const PENDING = new Set(["queued", "rendering"]);

function pendingClips(snap: Snapshot, clipIds: readonly string[]): string[] {
  const all = (snap.tracks ?? []).flatMap((t) => t.clips ?? []);
  return clipIds.filter((id) => {
    const clip = all.find((c) => c.id === id);
    const status = (clip as { renderLayer?: { status?: string } } | undefined)?.renderLayer?.status;
    return status !== undefined && PENDING.has(status);
  });
}

export type SettleOpts = {
  signal?: { aborted: boolean };
  timeoutMs?: number;
  pollMs?: number;
  /** Called for each still-pending clip when the wait aborts (cancel_render). */
  onAbort?: (clipId: string) => Promise<void>;
  now?: () => number;
};

export type SettleResult = { snapshot: Snapshot; outcome: "settled" | "timeout" | "aborted" };

export async function awaitRendersSettled(
  env: SnapshotSource,
  clipIds: readonly string[],
  opts: SettleOpts = {},
): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 300;
  const now = opts.now ?? (() => Date.now());
  const t0 = now();

  let snapshot = await env.getSnapshot();
  for (;;) {
    const pending = pendingClips(snapshot, clipIds);
    if (pending.length === 0) return { snapshot, outcome: "settled" };
    if (opts.signal?.aborted) {
      for (const id of pending) await opts.onAbort?.(id);
      return { snapshot, outcome: "aborted" };
    }
    if (now() - t0 > timeoutMs) return { snapshot, outcome: "timeout" };
    await new Promise((r) => setTimeout(r, pollMs));
    snapshot = await env.getSnapshot();
  }
}
