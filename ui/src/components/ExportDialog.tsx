import { useState } from "react";
import { useStore } from "../store";
import { pickSaveFile } from "../bridge";
import type { ExportFormat } from "../types";

// Export dialog (IOX-002 / IOX-007). A topbar popover modeled on Settings — reuses
// .tool-btn / .remote-pop / .settings-* styling, no new visual language. The only
// mutation is the export_audio command (the seam); pickSaveFile is a native dialog
// that just resolves a destination path. "wav"/"aiff"/"flac" are generic media
// formats, not engine type names, so they stay out of any Tracktion concept.

const FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "wav", label: "WAV", ext: "wav" },
  { value: "aiff", label: "AIFF", ext: "aiff" },
  { value: "flac", label: "FLAC", ext: "flac" },
];

// Bit depth per format: FLAC tops out at 24-bit, WAV/AIFF go to 32.
const DEPTHS_BY_FORMAT: Record<ExportFormat, number[]> = {
  wav: [16, 24, 32],
  aiff: [16, 24, 32],
  flac: [16, 24],
};

// 0 = project rate (omit sampleRate -> backend keeps the device/44100 fallback).
const SAMPLE_RATES: { value: number; label: string }[] = [
  { value: 0, label: "Project rate" },
  { value: 44100, label: "44100 Hz" },
  { value: 48000, label: "48000 Hz" },
  { value: 96000, label: "96000 Hz" },
];

export function ExportDialog({ audioEnabled }: { audioEnabled: boolean }) {
  const exec = useStore((s) => s.exec);
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState(24);
  const [sampleRate, setSampleRate] = useState(0);
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  // Default filename tracks the chosen format extension.
  const ext = FORMATS.find((f) => f.value === format)?.ext ?? "wav";
  const defaultName = `mixdown.${ext}`;
  const depths = DEPTHS_BY_FORMAT[format];

  const onFormatChange = (next: ExportFormat) => {
    setFormat(next);
    // Keep bit depth valid for the new format.
    if (!DEPTHS_BY_FORMAT[next].includes(bitDepth))
      setBitDepth(DEPTHS_BY_FORMAT[next].includes(24) ? 24 : DEPTHS_BY_FORMAT[next][0]);
    // Swap the chosen destination's extension to match.
    if (dest) {
      const nextExt = FORMATS.find((f) => f.value === next)?.ext ?? "wav";
      setDest(dest.replace(/\.[^./\\]+$/, `.${nextExt}`));
    }
    setDone("");
  };

  const onChoose = async () => {
    const r = await pickSaveFile({
      filters: `*.${ext}`,
      title: "Export audio",
      defaultName,
    });
    if (r.ok && r.file) {
      setDest(r.file);
      setDone("");
    }
  };

  const onExport = async () => {
    setBusy(true);
    setDone("");
    const args: Record<string, unknown> = { format, bitDepth };
    if (dest) args.file = dest;
    if (sampleRate >= 7000) args.sampleRate = sampleRate;
    const res = await exec("export_audio", args);
    setBusy(false);
    if (res.ok) {
      const file = (res.data as { file?: string } | undefined)?.file ?? dest;
      setDone(file);
    }
  };

  return (
    <div className="remote-companion">
      <button
        className={`tool-btn ${open ? "on" : ""}`}
        onClick={() => { if (!open) setDone(""); setOpen((v) => !v); }}
        disabled={!audioEnabled}
        title={audioEnabled ? "Export the mix" : "No audio device — export disabled"}
      >
        ⤓ Export
      </button>
      {open && (
        <div className="remote-pop settings-pop">
          <div className="remote-head">
            <strong>Export</strong>
            <button className="mini" onClick={() => setOpen(false)}>x</button>
          </div>

          <div className="settings-group">
            <div className="settings-label">Destination</div>
            <div className="settings-files">
              <button className="tool-btn" onClick={onChoose} disabled={busy}>Choose…</button>
            </div>
            <div className="settings-editfile" title={dest || defaultName}>
              {dest || `(default — ${defaultName})`}
            </div>
          </div>

          <div className="settings-group">
            <div className="settings-label">Format</div>

            <label className="settings-row">
              <span>Format</span>
              <select value={format} disabled={busy} onChange={(e) => onFormatChange(e.target.value as ExportFormat)}>
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </label>

            <label className="settings-row">
              <span>Bit depth</span>
              <select value={String(bitDepth)} disabled={busy} onChange={(e) => setBitDepth(Number(e.target.value))}>
                {depths.map((d) => (
                  <option key={d} value={String(d)}>{d}-bit</option>
                ))}
              </select>
            </label>

            <label className="settings-row">
              <span>Sample rate</span>
              <select value={String(sampleRate)} disabled={busy} onChange={(e) => setSampleRate(Number(e.target.value))}>
                {SAMPLE_RATES.map((sr) => (
                  <option key={sr.value} value={String(sr.value)}>{sr.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="settings-group">
            <div className="settings-files">
              <button className="tool-btn" onClick={onExport} disabled={busy || !audioEnabled}>
                {busy ? "Exporting…" : "Export"}
              </button>
            </div>
            {done && <div className="settings-editfile" title={done}>Exported: {done}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
