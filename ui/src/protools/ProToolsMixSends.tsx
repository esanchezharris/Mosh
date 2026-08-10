import type { Snapshot, Track } from "../types";
import { executeProToolsMixFanout } from "./proToolsMixFanout";

export function ProToolsMixSends({ snapshot, track, targetTrackIds }: {
  readonly snapshot: Snapshot;
  readonly track: Track;
  readonly targetTrackIds: readonly string[];
}) {
  const buses = (snapshot.buses ?? []).filter((bus) => bus.trackId !== track.id);
  const sends = (track.sends ?? []).slice(0, 5);
  const assigned = new Set(sends.map((send) => send.bus));
  const available = buses.filter((bus) => !assigned.has(bus.bus));

  return (
    <section className="pt-mix-sends" data-testid="pt-mix-sends" aria-label={`Sends on ${track.name}`}>
      <header>Sends A–E</header>
      <div className="pt-mix-send-rows">
        {sends.map((send, index) => {
          const bus = buses.find((candidate) => candidate.bus === send.bus)
            ?? snapshot.buses?.find((candidate) => candidate.bus === send.bus);
          const name = bus?.name ?? `Bus ${send.bus}`;
          return (
            <div className="pt-mix-send-row" key={send.bus}>
              <span>{String.fromCharCode(65 + index)} · {name}</span>
              <input type="range" min={-60} max={6} step={0.5} value={send.db}
                data-testid={`pt-mix-send-level-${send.bus}`} aria-label={`${name} send level`}
                onChange={(event) => {
                  const db = Number(event.currentTarget.value);
                  const targets = targetTrackIds.filter((trackId) => snapshot.tracks
                    .find((candidate) => candidate.id === trackId)?.sends?.some((candidate) => candidate.bus === send.bus));
                  void executeProToolsMixFanout({
                    snapshot,
                    targetTrackIds: targets,
                    commandForTrack: (trackId) => ({
                      command: "set_send_level",
                      args: { trackId, bus: send.bus, db },
                    }),
                  });
                }} />
              <output>{send.db.toFixed(1)}</output>
              <button type="button" aria-label={`Remove ${name} send`}
                onClick={() => {
                  const targets = targetTrackIds.filter((trackId) => snapshot.tracks
                    .find((candidate) => candidate.id === trackId)?.sends?.some((candidate) => candidate.bus === send.bus));
                  void executeProToolsMixFanout({
                    snapshot,
                    targetTrackIds: targets,
                    commandForTrack: (trackId) => ({
                      command: "remove_send",
                      args: { trackId, bus: send.bus },
                    }),
                  });
                }}>×</button>
            </div>
          );
        })}
        {sends.length === 0 && <span className="pt-mix-empty-slot">No sends</span>}
      </div>
      <select className="pt-mix-add-send" data-testid="pt-mix-add-send" aria-label={`Assign send on ${track.name}`}
        value="" disabled={Boolean(track.isGroup) || sends.length >= 5 || available.length === 0}
        onChange={(event) => {
          const bus = Number(event.currentTarget.value);
          if (!Number.isInteger(bus)) return;
          const busTrackId = snapshot.buses?.find((candidate) => candidate.bus === bus)?.trackId;
          const targets = targetTrackIds.filter((trackId) => {
            const target = snapshot.tracks.find((candidate) => candidate.id === trackId);
            return target && trackId !== busTrackId && (target.sends?.length ?? 0) < 5
              && !target.sends?.some((candidate) => candidate.bus === bus);
          });
          void executeProToolsMixFanout({
            snapshot,
            targetTrackIds: targets,
            commandForTrack: (trackId) => ({
              command: "add_send",
              args: { trackId, bus, db: 0 },
            }),
          });
        }}>
        <option value="">+ Assign send</option>
        {available.map((bus) => <option key={bus.bus} value={bus.bus}>{bus.name}</option>)}
      </select>
    </section>
  );
}
