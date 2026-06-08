import { useStore } from "../store";

function fmt(t: number): string {
  const s = Math.max(0, t);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${mm}:${ss.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

export function Transport() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const t = snapshot?.transport;

  const playing = t?.playing ?? false;
  const looping = t?.looping ?? false;

  return (
    <div className="transport">
      <button
        className={`tbtn ${playing ? "stop" : "play"}`}
        onClick={() => exec("set_transport", { action: "toggle" })}
        title={playing ? "Stop" : "Play"}
      >
        {playing ? "■" : "▶"}
      </button>
      <button
        className="tbtn"
        onClick={() => exec("set_transport", { action: "stop", position: 0 })}
        title="Return to start"
      >
        ⏮
      </button>
      <button
        className={`tbtn toggle ${looping ? "on" : ""}`}
        onClick={() => exec("set_transport", { loop: !looping })}
        title="Loop"
      >
        ⟳
      </button>
      <span className="pos">{fmt(t?.position ?? 0)}</span>
    </div>
  );
}
