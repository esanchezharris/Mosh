// The export form (format + bit-depth + range/tail + run), shared by the topbar Export
// popover and the redesign "+" file/options control so there's ONE export entry point
// definition. Every render stays a command on the seam (export_audio); the native file
// dialog only resolves the path.
//
// G1 — range/section + delay-tail policy: the form can export the whole edit (default)
// or just the transport loop region, and can extend the render past the range so
// delay/reverb tails ring out. The arg shaping lives in buildExportArgs (pure, tested);
// this component is just the form around it.

import { useState } from "react";
import { useStore } from "../store";
import type { ExportFormat } from "../types";
import { buildExportArgs, hasLoopRegion, type ExportRange } from "./exportArgs";

const FORMATS: { value: ExportFormat; depths: number[] }[] = [
  { value: "wav", depths: [16, 24, 32] }, { value: "aiff", depths: [16, 24, 32] }, { value: "flac", depths: [16, 24] },
];

export function ExportControls({ audioEnabled }: { audioEnabled: boolean }) {
  const exec = useStore((s) => s.exec);
  const loop = useStore((s) => ({ loopStart: s.transport.loopStart, loopEnd: s.transport.loopEnd }));
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState(24);
  const [range, setRange] = useState<ExportRange>("full");
  const [includeTail, setIncludeTail] = useState(false);
  const [tailSeconds, setTailSeconds] = useState(2);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const depths = FORMATS.find((f) => f.value === format)!.depths;
  const loopAvailable = hasLoopRegion(loop);
  // If the loop region disappears (or was never set), don't let a stale "loop" choice ride.
  const effectiveRange: ExportRange = range === "loop" && loopAvailable ? "loop" : "full";
  const onExport = async () => {
    setBusy(true); setDone("");
    const args = buildExportArgs({ format, bitDepth, range: effectiveRange, includeTail, tailSeconds, loop });
    const r = await exec("export_audio", args);
    setBusy(false);
    if (r.ok) setDone((r.data as { file?: string } | undefined)?.file ?? "exported");
  };
  return (
    <>
      <div className="pop-head">Export</div>
      <div className="pop-group">
        <label className="pop-row"><span>Format</span>
          <select value={format} onChange={(e) => { const f = e.target.value as ExportFormat; setFormat(f); const d = FORMATS.find((x) => x.value === f)!.depths; if (!d.includes(bitDepth)) setBitDepth(d.includes(24) ? 24 : d[0]); }}>
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.value.toUpperCase()}</option>)}
          </select>
        </label>
        <label className="pop-row"><span>Bit depth</span>
          <select value={String(bitDepth)} onChange={(e) => setBitDepth(Number(e.target.value))}>{depths.map((d) => <option key={d} value={d}>{d}-bit</option>)}</select>
        </label>
        <label className="pop-row"><span>Range</span>
          <select data-testid="export-range" value={effectiveRange} onChange={(e) => setRange(e.target.value as ExportRange)}>
            <option value="full">Whole song</option>
            <option value="loop" disabled={!loopAvailable}>Loop region{loopAvailable ? "" : " (none)"}</option>
          </select>
        </label>
        <label className="pop-row"><span>Include tail</span>
          <input type="checkbox" data-testid="export-tail" checked={includeTail} onChange={(e) => setIncludeTail(e.target.checked)} />
        </label>
        {includeTail && (
          <label className="pop-row"><span>Tail (s)</span>
            <input type="number" data-testid="export-tail-seconds" min={0} max={30} step={0.5} value={tailSeconds}
              onChange={(e) => setTailSeconds(Math.max(0, Number(e.target.value) || 0))} />
          </label>
        )}
      </div>
      <div className="pop-actions">
        <button className="btn" data-testid="export-run" disabled={busy || !audioEnabled} onClick={onExport}>{busy ? "Exporting…" : "Export"}</button>
      </div>
      {done && <div className="pop-note tc" title={done}>Exported: {done}</div>}
    </>
  );
}
