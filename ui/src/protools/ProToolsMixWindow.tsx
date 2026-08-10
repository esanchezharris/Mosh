import { useEffect } from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { ProToolsMixChannelStrip } from "./ProToolsMixChannelStrip";
import { ProToolsMixMasterStrip } from "./ProToolsMixMasterStrip";
import { useProTools } from "./proToolsState";

export function ProToolsMixWindow({ snapshot }: { readonly snapshot: Snapshot }) {
  const loadRouting = useStore((state) => state.loadRouting);
  const loadMidiInputs = useStore((state) => state.loadMidiInputs);
  const trackVisibility = useProTools((state) => state.trackVisibility);
  const tracks = snapshot.tracks.filter((track) => trackVisibility[track.id] !== false);

  useEffect(() => {
    void loadRouting();
    void loadMidiInputs();
  }, [loadMidiInputs, loadRouting]);

  return (
    <section className="pt-mix-window" data-testid="pt-mix-window" aria-label="Mix Window">
      <div className="pt-mix-bank">
        {tracks.map((track) => <ProToolsMixChannelStrip key={track.id} snapshot={snapshot} track={track} />)}
        {tracks.length === 0 && <p className="pt-mix-empty" role="status">No shown tracks</p>}
        <ProToolsMixMasterStrip snapshot={snapshot} />
      </div>
    </section>
  );
}
