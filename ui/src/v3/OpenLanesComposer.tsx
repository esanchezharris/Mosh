import { useEffect, useRef } from "react";
import { AgentComposer, type AgentTalkTargetProps } from "../ui/AgentComposer";
import "../vendor/moshi.js";

function MoshiTalkTarget(props: AgentTalkTargetProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window.Moshi !== "function") return;
    let api: ReturnType<NonNullable<Window["Moshi"]>> | null = null;
    try {
      api = window.Moshi(host, { personality: "TAR", seed: 0.5, resDiv: 1, room: false, interactive: true });
      api.setQuality("ps2").setAnatomy("A").setStyle("baked");
    } catch { api = null; }
    return () => { try { api?.destroy(); } catch {} };
  }, []);

  return (
    <button
      className={`ol-moshi-talk${props.listening ? " listening" : ""}`}
      type="button"
      disabled={props.disabled}
      aria-label={props.label}
      aria-pressed={props.listening}
      title={props.label}
      data-testid="v3-moshi-talk"
      onPointerDown={props.onPointerDown}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
    >
      <span ref={hostRef} className="ol-moshi-mount" aria-hidden="true" />
      <span className="ol-moshi-label">{props.listening ? "LISTENING" : "HOLD TO TALK"}</span>
    </button>
  );
}

export function OpenLanesComposer() {
  return (
    <div className="ol-composer" data-testid="v3-composer">
      <AgentComposer renderTalkTarget={(props) => <MoshiTalkTarget {...props} />} />
    </div>
  );
}
