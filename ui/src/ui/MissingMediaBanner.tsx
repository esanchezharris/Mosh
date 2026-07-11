import { useStore } from "../store";
import { pickFiles } from "../bridge";
import type { Snapshot } from "../types";

export type MissingMediaClip = {
  trackId: string;
  trackName: string;
  clipId: string;
  clipName: string;
};

/** Pure scan (testable without a DOM): every user-managed clip whose source file is absent on
 *  disk (gap 3). Hidden beneath-render clips are skipped — they aren't clips the producer manages,
 *  and relinking them makes no sense. Returns them in track/clip order so the banner is stable. */
export function missingMediaClips(snapshot: Snapshot | null): MissingMediaClip[] {
  if (!snapshot) return [];
  const out: MissingMediaClip[] = [];
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      if (clip.sourceMissing && !clip.hidden) {
        out.push({ trackId: track.id, trackName: track.name, clipId: clip.id, clipName: clip.name });
      }
    }
  }
  return out;
}

/** G13 — a clear, on-load banner surfacing missing clip sources. The per-clip `⚠ relink` chip in
 *  the arrangement can be scrolled off-screen (and the v2 shell never drew it at all), so this
 *  fixed banner guarantees a missing source is seen the moment the project loads and offers a
 *  relink affordance per clip. It self-heals: `relink_clip` clears `sourceMissing`, so the banner
 *  disappears once every source is re-pointed — no dismiss needed. */
export function MissingMediaBanner() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);

  const missing = missingMediaClips(snapshot);
  if (missing.length === 0) return null;

  const relink = async (m: MissingMediaClip) => {
    const r = await pickFiles({ title: `Relink audio for ${m.clipName}` });
    if (r.ok && r.files[0]) {
      await exec("relink_clip", { clipId: m.clipId, file: r.files[0] });
      await refresh();
    }
  };

  return (
    <div className="error-bar missing-media" role="alert" aria-live="polite" data-testid="missing-media-banner"
      data-missing-count={missing.length}>
      ⚠ {missing.length} clip{missing.length === 1 ? "" : "s"} {missing.length === 1 ? "is" : "are"} missing {missing.length === 1 ? "its" : "their"} source audio.
      <span className="missing-media-list">
        {missing.map((m) => (
          <button key={m.clipId} type="button" className="missing-media-relink" data-testid="missing-media-relink"
            data-clip-id={m.clipId} onClick={() => void relink(m)}
            title={`Relink “${m.clipName}” on ${m.trackName}`}>
            relink {m.clipName}
          </button>
        ))}
      </span>
    </div>
  );
}
