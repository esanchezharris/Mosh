import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

/** Tutorial-replication tooling (phase0 spec s6) — the hand-replication
 *  sprint's cockpit. Paste the tutorial URL at session start; press M (or the
 *  Mark button) to drop a marker binding (current op index <-> video time);
 *  a one-line friction note rides along into the gap ledger. The session
 *  recorder is always on; the consent toggle gates corpus entry, not
 *  recording. Pure UI — every action is a MoshOps command. */
export function TutorialBar() {
  const exec = useStore((s) => s.exec);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [urlSet, setUrlSet] = useState(false);
  const [ts, setTs] = useState("");
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [lastMark, setLastMark] = useState<string | null>(null);
  const tsRef = useRef<HTMLInputElement>(null);

  // Hotkey M: jump to the marker field (ignored while typing elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "m" || e.key === "M") {
        setOpen(true);
        setTimeout(() => tsRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const parseTs = (text: string): number | null => {
    const t = text.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    const m = t.match(/^(\d+):([0-5]?\d(\.\d+)?)$/); // mm:ss
    if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    return null;
  };

  const bindUrl = async () => {
    if (!url.trim()) return;
    const r = await exec("set_tutorial", { url: url.trim() });
    if (r.ok) setUrlSet(true);
  };

  const mark = async () => {
    const seconds = parseTs(ts);
    if (seconds == null) {
      setLastMark("bad time — use seconds or mm:ss");
      return;
    }
    const args: Record<string, unknown> = { videoTs: seconds };
    if (note.trim()) args.note = note.trim();
    const r = await exec("drop_marker", args);
    if (r.ok) {
      setLastMark(`marked ${ts}${note.trim() ? " + friction note" : ""}`);
      setTs("");
      setNote("");
    }
  };

  const toggleConsent = async () => {
    const next = !consent;
    const r = await exec("set_consent", { consent: next });
    if (r.ok) setConsent(next);
  };

  if (!open) {
    return (
      <button
        className="tool-btn"
        onClick={() => setOpen(true)}
        title="Tutorial replication: bind a video + drop op/time markers (hotkey M)"
      >
        ◉ Rec
      </button>
    );
  }

  return (
    <div className="tutorial-bar">
      <input
        className="tutorial-input tutorial-url"
        placeholder="tutorial URL"
        value={url}
        disabled={urlSet}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void bindUrl()}
        onBlur={() => void bindUrl()}
      />
      <input
        ref={tsRef}
        className="tutorial-input tutorial-ts"
        placeholder="4:32"
        value={ts}
        onChange={(e) => setTs(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void mark()}
        title="Video timestamp (mm:ss or seconds)"
      />
      <input
        className="tutorial-input tutorial-note"
        placeholder="friction note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void mark()}
        title="One line of friction -> gap ledger"
      />
      <button className="tool-btn" onClick={() => void mark()} title="Drop marker (op index <-> video time)">
        ◉ Mark
      </button>
      <button
        className={"tool-btn" + (consent ? " consent-on" : "")}
        onClick={() => void toggleConsent()}
        title={consent
          ? "Consent ON: this session may enter the training corpus"
          : "Consent OFF: recording stays local, never enters the corpus"}
      >
        {consent ? "✓ consent" : "✗ consent"}
      </button>
      {lastMark && <span className="tutorial-status">{lastMark}</span>}
      <button className="tool-btn" onClick={() => setOpen(false)} title="Collapse">
        ×
      </button>
    </div>
  );
}
