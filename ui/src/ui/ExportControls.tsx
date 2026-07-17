// The export form (format + bit-depth + run), shared by the topbar Export popover and
// the redesign "+" file/options control so there's ONE export entry point definition.
// Every render stays a command on the seam (export_audio); the native file dialog only
// resolves the path.

import { useState } from "react";
import { useStore } from "../store";
import type { ExportFormat } from "../types";
import { copyText } from "../clipboard";
import { parentDir } from "../exportPath";

const FORMATS: { value: ExportFormat; depths: number[] }[] = [
  { value: "wav", depths: [16, 24, 32] }, { value: "aiff", depths: [16, 24, 32] }, { value: "flac", depths: [16, 24] },
];

type RangeChoice = "full" | "loop" | "custom";
type TailChoice = "cut" | "include";

export function ExportControls({ audioEnabled }: { audioEnabled: boolean }) {
  const exec = useStore((s) => s.exec);
  const loopStart = useStore((s) => s.transport.loopStart);
  const loopEnd = useStore((s) => s.transport.loopEnd);
  const hasLoop = loopEnd - loopStart > 0;
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState(24);
  // G1: export range (invariant 78) + delay-tail policy (invariant 81). Defaults
  // ("full"/"cut") reproduce today's call — {format,bitDepth} only, byte-for-byte.
  const [range, setRange] = useState<RangeChoice>("full");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(4);
  const [tail, setTail] = useState<TailChoice>("cut");
  const [tailSeconds, setTailSeconds] = useState(2);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  // "Copied" flash — there's no native "Reveal in Finder" bridge command (JUCE's
  // File::revealToUser() has no MoshOps surface today), so a guest tester's best path to
  // their export is: see the full path, copy it, then Cmd+Shift+G it into Finder.
  const [copied, setCopied] = useState<"file" | "folder" | null>(null);
  const depths = FORMATS.find((f) => f.value === format)!.depths;
  const onExport = async () => {
    setBusy(true); setDone(""); setCopied(null);
    const args: Record<string, unknown> = { format, bitDepth };
    if (range !== "full") args.range = range;
    if (range === "custom") { args.start = start; args.end = end; }
    if (tail === "include") { args.tail = "include"; args.tailSeconds = tailSeconds; }
    const r = await exec("export_audio", args);
    setBusy(false);
    if (r.ok) setDone((r.data as { file?: string } | undefined)?.file ?? "exported");
  };
  const copy = async (which: "file" | "folder") => {
    const ok = await copyText(which === "file" ? done : parentDir(done));
    if (ok) { setCopied(which); window.setTimeout(() => setCopied(null), 1600); }
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
          <select data-testid="export-range" value={range} onChange={(e) => setRange(e.target.value as RangeChoice)}>
            <option value="full">Full mix</option>
            <option value="loop" disabled={!hasLoop}>Loop region{hasLoop ? "" : " (none set)"}</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {range === "custom" && (
          <label className="pop-row"><span>Start / End (s)</span>
            <span className="pop-inline">
              <input data-testid="export-start" type="number" min={0} step={0.1} value={start} onChange={(e) => setStart(Number(e.target.value))} />
              <input data-testid="export-end" type="number" min={0} step={0.1} value={end} onChange={(e) => setEnd(Number(e.target.value))} />
            </span>
          </label>
        )}
        <label className="pop-row"><span>Tail</span>
          <select data-testid="export-tail" value={tail} onChange={(e) => setTail(e.target.value as TailChoice)}>
            <option value="cut">Cut tails</option>
            <option value="include">Include tails</option>
          </select>
        </label>
        {tail === "include" && (
          <label className="pop-row"><span>Tail length (s)</span>
            <input data-testid="export-tail-seconds" type="number" min={0.05} max={30} step={0.5} value={tailSeconds} onChange={(e) => setTailSeconds(Number(e.target.value))} />
          </label>
        )}
      </div>
      <div className="pop-actions">
        <button className="btn" data-testid="export-run" disabled={busy || !audioEnabled} onClick={onExport}>{busy ? "Exporting…" : "Export"}</button>
      </div>
      {done && (
        <div className="pop-note export-done" data-testid="export-done">
          <div>Exported to:</div>
          <div className="tc export-path" title={done}>{done}</div>
          <div className="pop-actions">
            <button className="btn" data-testid="export-copy-path" onClick={() => void copy("file")}>{copied === "file" ? "Copied ✓" : "Copy path"}</button>
            <button className="btn" data-testid="export-copy-folder" onClick={() => void copy("folder")}>{copied === "folder" ? "Copied ✓" : "Copy folder"}</button>
          </div>
          <div className="pop-note">Folder hidden by default — in Finder press ⌘⇧G (Go to Folder) and paste it.</div>
        </div>
      )}
    </>
  );
}
