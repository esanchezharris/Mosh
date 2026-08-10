import { useStore } from "../store";
import type { Snapshot, Track } from "../types";

export function ProToolsMixSends({ snapshot, track }: {
  readonly snapshot: Snapshot;
  readonly track: Track;
}) {
  const exec = useStore((state) => state.exec);
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
                onChange={(event) => void exec("set_send_level", {
                  trackId: track.id,
                  bus: send.bus,
                  db: Number(event.currentTarget.value),
                })} />
              <output>{send.db.toFixed(1)}</output>
              <button type="button" aria-label={`Remove ${name} send`}
                onClick={() => void exec("remove_send", { trackId: track.id, bus: send.bus })}>×</button>
            </div>
          );
        })}
        {sends.length === 0 && <span className="pt-mix-empty-slot">No sends</span>}
      </div>
      <select className="pt-mix-add-send" data-testid="pt-mix-add-send" aria-label={`Assign send on ${track.name}`}
        value="" disabled={sends.length >= 5 || available.length === 0}
        onChange={(event) => {
          const bus = Number(event.currentTarget.value);
          if (Number.isInteger(bus)) void exec("add_send", { trackId: track.id, bus, db: 0 });
        }}>
        <option value="">+ Assign send</option>
        {available.map((bus) => <option key={bus.bus} value={bus.bus}>{bus.name}</option>)}
      </select>
    </section>
  );
}
