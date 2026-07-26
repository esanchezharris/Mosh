// Pre-flight for per-track stem export (G7).
//
// export_stems renders one file per track SYNCHRONOUSLY on the message thread — N full
// renders back to back, with no progress event and no cancel once started. So the one
// thing the UI owes the producer is an honest answer to "what is about to happen" BEFORE
// the click, and that means knowing the file count client-side. It is derivable from the
// snapshot alone, so it costs no round trip.
//
// This mirrors the native selection rule in cmdExportStems (MoshOps.cpp ~:10035) rather
// than inventing a friendlier one — a count that disagrees with what lands on disk is
// worse than no count:
//   • the hidden Phase-2 beneath-render track is skipped natively, and is already absent
//     from the snapshot entirely, so nothing to do here;
//   • group/folder tracks are not AudioTracks and never yield a stem;
//   • return/bus tracks are NOT filtered natively — they simply never hold clips, so they
//     drop out of the default pass on their own. Deliberately not special-cased, because
//     under includeEmpty they genuinely do get a (silent) stem, and the count must say so;
//   • empty tracks are skipped unless includeEmpty.

import type { Track } from "./types";

type StemTrack = Pick<Track, "isGroup" | "clips">;

/** Tracks that will produce a stem file, in native order. */
export function stemTracks<T extends StemTrack>(tracks: readonly T[], includeEmpty: boolean): T[] {
  return tracks.filter((t) => !t.isGroup && (includeEmpty || (t.clips?.length ?? 0) > 0));
}

export function stemCount(tracks: readonly StemTrack[], includeEmpty: boolean): number {
  return stemTracks(tracks, includeEmpty).length;
}

/** Zero-padded index + sanitized name, e.g. "03-Lead Vocal" — the mirror of
 *  stemFileBaseName in src/moshops/StemExport.h.
 *
 *  NOTE the index is the position among ALL non-hidden audio tracks, assigned BEFORE the
 *  empty-track skip (`const int myIndex = index++;` precedes the `continue`), so a default
 *  export over a project with an empty track in the middle produces GAPS: 00, 02, 03. That
 *  is native behaviour, not a bug to smooth over — the index is what guarantees uniqueness
 *  when two tracks share a display name, so it must stay tied to track position. */
export function stemBaseName(index: number, trackName: string): string {
  // createLegalFileName's rule: strip the characters a filesystem can't take.
  const legal = trackName.replace(/[?*:"<>|/\\]/g, "").trim() || "unnamed";
  return `${String(index).padStart(2, "0")}-${legal}`;
}
