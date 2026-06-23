// The export form (format + bit-depth + run), shared by the topbar Export popover and
// the redesign "+" file/options control so there's ONE export entry point definition.
// Every render stays a command on the seam (export_audio); the native file dialog only
// resolves the path.

import { useState } from "react";
import { useStore } from "../store";
import type { ExportFormat } from "../types";

const FORMATS: { value: ExportFormat; depths: number[] }[] = [
  { value: "wav", depths: [16, 24, 32] }, { value: "aiff", depths: [16, 24, 32] }, { value: "flac", depths: [16, 24] },
];

export function ExportControls({ audioEnabled }: { audioEnabled: boolean }) {
  const exec = useStore((s) => s.exec);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState(24);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const depths = FORMATS.find((f) => f.value === format)!.depths;
  const onExport = async () => {
    setBusy(true); setDone("");
    const r = await exec("export_audio", { format, bitDepth });
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
      </div>
      <div className="pop-actions">
        <button className="btn" data-testid="export-run" disabled={busy || !audioEnabled} onClick={onExport}>{busy ? "Exporting…" : "Export"}</button>
      </div>
      {done && <div className="pop-note tc" title={done}>Exported: {done}</div>}
    </>
  );
}
