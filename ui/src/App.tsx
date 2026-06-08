import { useEffect, useState } from "react";
import { ping, isNative, type AppInfo } from "./bridge";

// Stage 0 placeholder. Proves: (1) the JUCE WebView loads the bundled React app,
// (2) native integration is present, (3) the bridge round-trips `ping`.
// Stage 2 replaces this with the conventional arrangement (track list · timeline
// lanes · transport · mixer), rendered from a snapshot + typed events.
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    ping().then(setInfo);
  }, []);

  const native = isNative();

  return (
    <div className="shell">
      <div className="brand">
        <div className="logo">M</div>
        <div>
          <h1>Mosh</h1>
          <p className="tagline">native hybrid DAW · v0 skeleton</p>
        </div>
      </div>

      <div className="status-grid">
        <Status label="WebView" ok value="React + Vite mounted" />
        <Status
          label="Native bridge"
          ok={native}
          value={native ? "window.__JUCE__ present" : "web dev (no JUCE)"}
        />
        <Status
          label="ping()"
          ok={!!info?.ok}
          value={
            info
              ? `${info.app} ${info.version} · stage ${info.stage} · ${info.backend}`
              : "calling…"
          }
        />
      </div>

      <div className="stage-rail">
        {STAGES.map((s) => (
          <div className={`stage ${s.n === 0 ? "active" : ""}`} key={s.n}>
            <span className="n">{s.n}</span>
            <span className="t">{s.t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Status({ label, ok, value }: { label: string; ok?: boolean; value: string }) {
  return (
    <div className="status">
      <div className="status-head">
        <span className={`dot ${ok ? "on" : "off"}`} />
        <span className="status-label">{label}</span>
      </div>
      <div className="status-value">{value}</div>
    </div>
  );
}

const STAGES = [
  { n: 0, t: "Skeleton" },
  { n: 1, t: "Engine + MoshOps" },
  { n: 2, t: "Arrangement" },
  { n: 3, t: "VST3 hosting" },
  { n: 4, t: "Tier-A neural" },
  { n: 5, t: "Generative" },
  { n: 6, t: "Consolidation" },
];
