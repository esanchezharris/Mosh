import { useCallback, useRef, useState } from "react";
import { MoshTip } from "../chrome/Tooltip";
import { useStore } from "../store";
import type { Track } from "../types";
import { ProToolsInsertDialog } from "./ProToolsInsertDialog";

export function ProToolsDeviceRack({ track, embedded = false }: {
  readonly track: Track;
  readonly embedded?: boolean;
}) {
  const exec = useStore((state) => state.exec);
  const plugins = track.plugins ?? [];
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const closeInsert = useCallback(() => setInsertOpen(false), []);

  return (
    <div className={`pt-device-rack${embedded ? " is-embedded" : ""}`} data-testid="pt-device-rack" role="group"
      aria-label={`Inserts on ${track.name}`}>
      {!embedded && <header className="pt-detail-head">
        <span className="pt-detail-title">Track — {track.name}</span>
        <span className="pt-device-rack-label">Inserts A–E</span>
      </header>}
      <div className="pt-device-rack-body">
        {track.frozen && <span className="pt-device-frozen" role="status">Track frozen</span>}
        <button ref={addButtonRef} type="button" className="pt-device-add" data-testid="pt-add-insert"
          disabled={track.frozen} onClick={() => setInsertOpen(true)}>
          <strong>+</strong><span>Add Insert</span>
        </button>
        {plugins.length === 0 && <p className="pt-device-empty" role="status">No inserts on {track.name}</p>}
        {plugins.map((plugin) => (
            <div key={plugin.index} className={`pt-device${plugin.enabled ? "" : " is-bypassed"}`}
              data-testid="pt-device">
              <button type="button" className="pt-device-open" data-testid={`pt-device-open-${plugin.index}`}
                onClick={() => void exec("open_plugin_editor", { trackId: track.id, index: plugin.index })}>
                <span>{plugin.name}</span>
                <small>{plugin.type}</small>
              </button>
              <div className="pt-device-actions">
                <MoshTip side="top" label={plugin.enabled ? `Bypass ${plugin.name}` : `Enable ${plugin.name}`}>
                  <button type="button" className="pt-device-bypass" data-testid={`pt-device-bypass-${plugin.index}`}
                    aria-label={`${plugin.enabled ? "Bypass" : "Enable"} ${plugin.name}`}
                    aria-pressed={!plugin.enabled}
                    disabled={track.frozen}
                    onClick={() => void exec("bypass_plugin", {
                      trackId: track.id,
                      index: plugin.index,
                      bypassed: plugin.enabled,
                    })}>Power</button>
                </MoshTip>
                <button type="button" className="pt-device-remove" data-testid={`pt-device-remove-${plugin.index}`}
                  aria-label={`Remove ${plugin.name}`} disabled={track.frozen}
                  onClick={() => void exec("remove_plugin", { trackId: track.id, index: plugin.index })}>Remove</button>
              </div>
            </div>
          ))}
      </div>
      {insertOpen && <ProToolsInsertDialog onClose={closeInsert} returnFocusRef={addButtonRef} />}
    </div>
  );
}
