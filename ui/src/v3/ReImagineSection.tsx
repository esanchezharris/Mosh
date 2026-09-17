import { useState } from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { GenDrawer } from "../ui/GenDrawer";

function audioTarget(snapshot: Snapshot, clipId: string | undefined) {
  for (const track of snapshot.tracks) {
    const clip = track.clips.find((item) => item.id === clipId && item.type === "wave" && !item.hidden);
    if (clip) return { track, clip };
  }
  return null;
}

export function ReImagineSection({ snapshot }: { readonly snapshot: Snapshot }) {
  const selection = useStore((state) => state.selection);
  const epoch = useStore((state) => state.projectEpoch);
  const [opened, setOpened] = useState<{ readonly clipId: string; readonly epoch: number } | null>(null);
  const selected = audioTarget(snapshot, selection.size === 1 ? selection.values().next().value : undefined);
  const target = opened?.epoch === epoch ? audioTarget(snapshot, opened.clipId) : null;

  return <section className="grp v3-reimagine" aria-label="Re-Imagine">
    <div className="grphd v3-reimagine-heading">
      <span className="sec">Re-Imagine</span>
      <button className={`btn ${opened ? "sm" : "pri"}`} data-testid={opened ? "v3-reimagine-close" : "v3-reimagine-open"}
        disabled={!opened && !selected} onClick={() => {
          if (opened) setOpened(null);
          else if (selected) setOpened({ clipId: selected.clip.id, epoch });
        }}>{opened ? "Close" : "Open Re-Imagine"}</button>
    </div>
    <div className="grp-body v3-gen">
      {!opened ? <p className="set-hint">{selected ? `${selected.clip.name} · ${selected.track.name}` : "Select one audio clip to Re-Imagine."}</p> : target ? <GenDrawer key={`${opened.epoch}:${target.clip.id}`} track={target.track} selectedClipId={target.clip.id} direct />
        : <p role="status">This source is no longer available. Close the tool, select one audio clip, then reopen Re-Imagine.</p>}
    </div>
  </section>;
}
