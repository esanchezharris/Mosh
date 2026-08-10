import { useRef, useState } from "react";
import { useStore } from "../store";
import type { Track } from "../types";
import { ProToolsInsertDialog } from "./ProToolsInsertDialog";

const INSERT_SLOT_LABELS = ["A", "B", "C", "D", "E"] as const;

export function ProToolsMixInserts({ track, onSelectTrack, targetTrackIds }: {
  readonly track: Track;
  readonly onSelectTrack: () => void;
  readonly targetTrackIds: readonly string[];
}) {
  const exec = useStore((state) => state.exec);
  const addRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTrackIds, setDialogTrackIds] = useState<readonly string[]>([]);
  const plugins = track.plugins ?? [];

  return (
    <section className="pt-mix-inserts" data-testid="pt-mix-inserts" aria-label={`Inserts on ${track.name}`}>
      <header>Inserts A–E</header>
      {INSERT_SLOT_LABELS.map((slot, slotIndex) => {
        const plugin = plugins[slotIndex];
        return plugin ? (
          <div className="pt-mix-insert-slot" key={slot} data-filled="true">
            <span className="pt-mix-slot-letter">{slot}</span>
            <button type="button" className="pt-mix-insert-name"
              data-testid={`pt-mix-insert-open-${plugin.index}`}
              title={`Open ${plugin.name}`}
              onClick={() => void exec("open_plugin_editor", { trackId: track.id, index: plugin.index })}>
              {plugin.name}
            </button>
            <button type="button" data-testid={`pt-mix-insert-bypass-${plugin.index}`}
              aria-label={`${plugin.enabled ? "Bypass" : "Enable"} ${plugin.name}`}
              aria-pressed={!plugin.enabled} disabled={track.frozen}
              onClick={() => void exec("bypass_plugin", {
                trackId: track.id,
                index: plugin.index,
                bypassed: plugin.enabled,
              })}>P</button>
            <button type="button" data-testid={`pt-mix-insert-remove-${plugin.index}`}
              aria-label={`Remove ${plugin.name}`} disabled={track.frozen}
              onClick={() => void exec("remove_plugin", { trackId: track.id, index: plugin.index })}>×</button>
          </div>
        ) : (
          <div className="pt-mix-insert-slot" key={slot} data-filled="false">
            <span className="pt-mix-slot-letter">{slot}</span><span>—</span>
          </div>
        );
      })}
      <button ref={addRef} type="button" className="pt-mix-add-insert" data-testid="pt-mix-add-insert"
        disabled={track.frozen || track.isGroup} onClick={() => {
          onSelectTrack();
          setDialogTrackIds(targetTrackIds);
          setDialogOpen(true);
        }}>+ Insert</button>
      {dialogOpen && (
        <ProToolsInsertDialog onClose={() => setDialogOpen(false)} returnFocusRef={addRef}
          trackIds={dialogTrackIds} />
      )}
    </section>
  );
}
