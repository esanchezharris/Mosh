import { useEffect, useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { IconClose, IconPlus } from "../ui/icons";
import { useStore } from "../store";
import type { Bus, CommandResult, Track } from "../types";
import { ReconciledRange } from "../v2/ReconciledRange";

type BusDraft = { readonly bus: number; readonly name: string };
type CreateBusData = { readonly trackId?: string };

function commandData(result: CommandResult): CreateBusData | null {
  return result.ok && typeof result.data === "object" && result.data !== null
    ? result.data as CreateBusData
    : null;
}

export function ProToolsSends({ track }: { readonly track: Track }) {
  const snapshot = useStore((state) => state.snapshot);
  const exec = useStore((state) => state.exec);
  const refresh = useStore((state) => state.refresh);
  const setLastError = useStore((state) => state.setLastError);
  const setSelectedTrack = useStore((state) => state.setSelectedTrack);
  const clearSelection = useStore((state) => state.clearSelection);
  const closePianoRoll = useStore((state) => state.closePianoRoll);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const buses = (snapshot?.buses ?? []).filter((bus) => bus.trackId !== track.id);
  const sends = track.sends ?? [];
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createInvalid, setCreateInvalid] = useState(false);
  const [renaming, setRenaming] = useState<BusDraft | null>(null);
  const [renameInvalid, setRenameInvalid] = useState(false);
  const [confirmBus, setConfirmBus] = useState<Bus | null>(null);

  useEffect(() => {
    setCreating(false);
    setCreateName("");
    setCreateInvalid(false);
    setRenaming(null);
    setRenameInvalid(false);
    setConfirmBus(null);
  }, [projectEpoch, track.id]);

  const report = (result: CommandResult, fallback: string): boolean => {
    if (result.ok) return true;
    setLastError(result.error ?? fallback);
    return false;
  };
  const isCurrentProject = (epoch: number) => useStore.getState().projectEpoch === epoch;

  const openReturn = (trackId: string) => {
    clearSelection();
    closePianoRoll();
    setSelectedTrack(trackId);
  };

  const createBus = async () => {
    const name = createName.trim();
    if (!name) {
      setCreateInvalid(true);
      return;
    }
    const epoch = useStore.getState().projectEpoch;
    const result = await exec("create_bus", { name });
    if (!isCurrentProject(epoch) || !report(result, "The Aux bus could not be created.")) return;
    setCreating(false);
    setCreateName("");
    const trackId = commandData(result)?.trackId;
    if (trackId) openReturn(trackId);
  };

  const renameBus = async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) {
      setRenameInvalid(true);
      return;
    }
    const epoch = useStore.getState().projectEpoch;
    const result = await exec("rename_bus", { bus: renaming.bus, name });
    if (!isCurrentProject(epoch)) return;
    if (report(result, "The bus could not be renamed.")) setRenaming(null);
  };

  const run = async (command: string, args: Record<string, unknown>, fallback: string) => {
    const epoch = useStore.getState().projectEpoch;
    const result = await exec(command, args);
    if (isCurrentProject(epoch)) report(result, fallback);
    return result;
  };

  return (
    <section className="pt-sends" data-testid="pt-sends" aria-label={`Sends on ${track.name}`}>
      <div className="pt-sends-head">
        <span>Sends</span>
        <span className="pt-sends-post">Post-fader</span>
        <button type="button" data-testid="pt-add-bus" onClick={() => {
          setCreating(true);
          setCreateName("");
          setCreateInvalid(false);
        }}>
          <IconPlus size={11} /> New Aux
        </button>
      </div>
      {creating && (
        <div className="pt-bus-create">
          <input autoFocus data-testid="pt-new-bus-name" aria-label="New Aux bus name"
            aria-invalid={createInvalid} placeholder="Reverb, Delay, Drum Bus…" value={createName}
            onChange={(event) => { setCreateName(event.target.value); setCreateInvalid(false); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void createBus(); }
              if (event.key === "Escape") { event.preventDefault(); setCreating(false); }
            }} />
          <button type="button" onClick={() => void createBus()}>Create</button>
          <button type="button" aria-label="Cancel new Aux bus" onClick={() => setCreating(false)}>
            <IconClose size={11} />
          </button>
        </div>
      )}
      {buses.length === 0 && !creating && (
        <p className="pt-sends-empty" role="status">No Aux returns. Create one for shared reverb or delay.</p>
      )}
      <div className="pt-send-rows">
        {buses.map((bus) => {
          const send = sends.find((candidate) => candidate.bus === bus.bus);
          const isRenaming = renaming?.bus === bus.bus;
          return (
            <div key={bus.bus} className="pt-send-row" data-testid={`pt-send-${bus.bus}`}
              data-assigned={Boolean(send)}>
              <div className="pt-send-destination">
                {isRenaming ? (
                  <input autoFocus data-testid={`pt-bus-name-${bus.bus}`}
                    aria-label={`Rename ${bus.name} bus`} aria-invalid={renameInvalid}
                    value={renaming.name}
                    onChange={(event) => {
                      setRenaming({ bus: bus.bus, name: event.target.value });
                      setRenameInvalid(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); void renameBus(); }
                      if (event.key === "Escape") { event.preventDefault(); setRenaming(null); }
                    }} />
                ) : (
                  <button type="button" className="pt-bus-name" data-testid={`pt-open-return-${bus.bus}`}
                    title={`Open ${bus.name} Aux return`} onClick={() => openReturn(bus.trackId)}>
                    {bus.name}
                  </button>
                )}
                <span data-testid={`pt-send-post-${bus.bus}`}>Post</span>
              </div>
              <div className="pt-send-bus-actions">
                {isRenaming ? (
                  <button type="button" onClick={() => void renameBus()}>Save</button>
                ) : (
                  <button type="button" data-testid={`pt-rename-bus-${bus.bus}`}
                    aria-label={`Rename ${bus.name} bus`}
                    onClick={() => { setRenaming({ bus: bus.bus, name: bus.name }); setRenameInvalid(false); }}>
                    Rename
                  </button>
                )}
                <button type="button" data-testid={`pt-remove-bus-${bus.bus}`}
                  aria-label={`Delete ${bus.name} bus`} onClick={() => setConfirmBus(bus)}>Delete</button>
              </div>
              {send ? (
                <div className="pt-send-level">
                  <ReconciledRange key={`${projectEpoch}:${track.id}:${bus.bus}`} min={-60} max={6} step={0.5}
                    value={send.db} data-testid={`pt-send-level-${bus.bus}`}
                    aria-label={`${bus.name} send level`}
                    onCommit={(db) => run("set_send_level", { trackId: track.id, bus: bus.bus, db },
                      `The ${bus.name} send level could not be changed.`)}
                    reconcile={async () => {
                      if (!isCurrentProject(projectEpoch)) return useStore.getState().snapshot?.tracks
                        .find((candidate) => candidate.id === track.id)?.sends
                        ?.find((candidate) => candidate.bus === bus.bus)?.db ?? send.db;
                      await refresh();
                      return useStore.getState().snapshot?.tracks.find((candidate) => candidate.id === track.id)
                        ?.sends?.find((candidate) => candidate.bus === bus.bus)?.db ?? send.db;
                    }} />
                  <output data-testid={`pt-send-level-readout-${bus.bus}`}>{send.db.toFixed(1)} dB</output>
                  <button type="button" data-testid={`pt-remove-send-${bus.bus}`}
                    aria-label={`Remove ${bus.name} send`}
                    onClick={() => void run("remove_send", { trackId: track.id, bus: bus.bus },
                      `The ${bus.name} send could not be removed.`)}>
                    <IconClose size={11} />
                  </button>
                </div>
              ) : (
                <button type="button" className="pt-add-send" data-testid={`pt-add-send-${bus.bus}`}
                  onClick={() => void run("add_send", { trackId: track.id, bus: bus.bus, db: 0 },
                    `The ${bus.name} send could not be assigned.`)}>
                  Assign send
                </button>
              )}
            </div>
          );
        })}
      </div>
      {confirmBus && (
        <ConfirmDialog title={`Delete the ${confirmBus.name} Aux bus?`}
          body={<>This removes its return track and every send feeding it. Recreating the bus will not restore those sends.</>}
          confirmLabel="Delete bus" danger testId="pt-remove-bus-confirm"
          onCancel={() => setConfirmBus(null)}
          onConfirm={() => {
            const bus = confirmBus.bus;
            setConfirmBus(null);
            void run("remove_bus", { bus }, "The Aux bus could not be deleted.");
          }} />
      )}
    </section>
  );
}
