// "Select similar" — a pure predicate over the snapshot. Issue #554.
//
// UI-LOCAL BY CONSTRUCTION. Selection never crosses the seam (ARCHITECTURE.md §3,
// contract 2), so this is not and cannot be a command: it computes a set of clip ids the
// store then selects, exactly like the marquee does.
//
// WHAT "SIMILAR" MEANS, and why. The 2-of-4 rule the capability matrix uses for inclusion
// is applied here to BEHAVIOUR: Reaper ("Select all items with the same source") and Pro
// Tools (Select > Similar) both key on the underlying SOURCE, not the display name, so a
// renamed copy of a loop is still similar. That is the agreed behaviour, so it is what
// Mosh implements — sourceFile when a clip has one, falling back to name for MIDI clips,
// which have no source file to key on.
//
// Deliberately project-wide, not track-scoped: the reason a producer reaches for this is
// "every copy of that loop", and copies of a loop are spread across tracks. A track-scoped
// variant would need its own menu item to be discoverable, and nobody asked for one.

import type { Snapshot } from "../../types";

/** The key two clips must share to count as similar. */
export function similarityKey(clip: { sourceFile?: string; name?: string; type?: string }): string | null {
  const src = clip.sourceFile?.trim();
  if (src) return `src:${src}`;
  const name = clip.name?.trim();
  return name ? `name:${name}` : null;   // an unnamed, sourceless clip matches nothing
}

/**
 * Every clip in the project similar to `clipId`, including it.
 * Returns [] when the clip is unknown, or [clipId] when nothing else matches — never a
 * set that silently drops the clip the producer right-clicked.
 */
export function selectSimilarIds(snapshot: Snapshot | null | undefined, clipId: string): string[] {
  if (!snapshot) return [];
  const all = snapshot.tracks.flatMap((t) => t.clips);
  const target = all.find((c) => c.id === clipId);
  if (!target) return [];
  const key = similarityKey(target);
  if (key == null) return [clipId];
  return all.filter((c) => similarityKey(c) === key).map((c) => c.id);
}
