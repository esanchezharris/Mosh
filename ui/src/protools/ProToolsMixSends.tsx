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
          const targets = () => targetTrackIds.filter((trackId) => snapshot.tracks
            .find((candidate) => candidate.id === trackId)?.sends?.some((candidate) => candidate.bus === send.bus));
          const run = (command: string, argsForTrack: (trackId: string) => Record<string, unknown>) =>
            executeProToolsMixFanout({
              snapshot,
              targetTrackIds: targets(),
              commandForTrack: (trackId) => ({ command, args: argsForTrack(trackId) }),
            });
          return (
            <div className="pt-mix-send-row" key={send.bus}>
              <div className="pt-mix-send-head">
                <span>{String.fromCharCode(65 + index)} · {name}</span>
                <button type="button" data-testid={`pt-mix-send-mute-${send.bus}`}
                  aria-label={`${send.mute ? "Unmute" : "Mute"} ${name} send`} aria-pressed={send.mute}
                  onClick={() => void run("set_send_mute", (trackId) => ({
                    trackId, bus: send.bus, mute: !send.mute,
                  }))}>M</button>
                <button type="button" data-testid={`pt-mix-send-pre-${send.bus}`}
                  aria-label={`${name} send ${send.preFader ? "pre" : "post"}-fader`} aria-pressed={Boolean(send.preFader)}
                  onClick={() => void run("set_send_pre_fader", (trackId) => ({
                    trackId, bus: send.bus, preFader: !send.preFader,
                  }))}>{send.preFader ? "Pre" : "Post"}</button>
                <button type="button" aria-label={`Remove ${name} send`}
                onClick={() => {
                  void run("remove_send", (trackId) => ({ trackId, bus: send.bus }));
                }}>×</button>
              </div>
              <label className="pt-mix-send-control">
                <span>Lvl</span>
                <input type="range" min={-60} max={6} step={0.5} value={send.db}
                  data-testid={`pt-mix-send-level-${send.bus}`} aria-label={`${name} send level`}
                  onChange={(event) => {
                    const db = Number(event.currentTarget.value);
                    void run("set_send_level", (trackId) => ({ trackId, bus: send.bus, db }));
                  }} />
                <output>{send.db.toFixed(1)}</output>
              </label>
              <label className="pt-mix-send-control">
                <span>Pan</span>
                <input type="range" min={-1} max={1} step={0.05} value={send.pan ?? 0}
                  data-testid={`pt-mix-send-pan-${send.bus}`} aria-label={`${name} send pan`}
                  onChange={(event) => {
                    const pan = Number(event.currentTarget.value);
                    void run("set_send_pan", (trackId) => ({ trackId, bus: send.bus, pan }));
                  }} />
                <output>{(send.pan ?? 0).toFixed(2)}</output>
              </label>
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
