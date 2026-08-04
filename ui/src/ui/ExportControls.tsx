// The export form (format + bit-depth + run), shared by the topbar Export popover and
// the redesign "+" file/options control so there's ONE export entry point definition.
// Every render stays a command on the seam (export_audio); the native file dialog only
// resolves the path.

import { useState } from "react";
import { useStore } from "../store";
import type { ExportFormat } from "../types";
import { copyText } from "../clipboard";
import { parentDir } from "../exportPath";
import { resolveSectionExportRange } from "../exportSection";
import { stemCount } from "../exportStems";
import { ConfirmDialog } from "./ConfirmDialog";

const FORMATS: { value: ExportFormat; depths: number[] }[] = [
  { value: "wav", depths: [16, 24, 32] }, { value: "aiff", depths: [16, 24, 32] }, { value: "flac", depths: [16, 24] },
];

type RangeChoice = "full" | "loop" | "custom" | "section";
type TailChoice = "cut" | "include";
// G7 — one mixdown, or one file per track. A mode select rather than a second panel:
// format and bit depth mean the same thing in both, and this file exists specifically to
// be the ONE export entry point definition (see the header), so forking it would undo that.
type ModeChoice = "mixdown" | "stems";

export function ExportControls({ audioEnabled }: { audioEnabled: boolean }) {
  const exec = useStore((s) => s.exec);
  const loopStart = useStore((s) => s.transport.loopStart);
  const loopEnd = useStore((s) => s.transport.loopEnd);
  const hasLoop = loopEnd - loopStart > 0;
  // CONF-EXPORT-SECTION — named song sections (MOSH_SECTIONS; beat-based) live at
  // snapshot.sections; export_audio itself only knows seconds, so a chosen section is
  // resolved to [start,end) seconds via exportSection.ts and dispatched as range:"custom".
  const sections = useStore((s) => s.snapshot?.sections ?? []);
  const tempo = useStore((s) => s.snapshot?.session.tempo);
  const timeSigNumerator = useStore((s) => s.snapshot?.session.timeSigNumerator);
  const timeSigDenominator = useStore((s) => s.snapshot?.session.timeSigDenominator);
  const hasSections = sections.length > 0;
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState(24);
  // G1: export range (invariant 78) + delay-tail policy (invariant 81). Defaults
  // ("full"/"cut") reproduce today's call — {format,bitDepth} only, byte-for-byte.
  const [range, setRange] = useState<RangeChoice>("full");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(4);
  const [sectionId, setSectionId] = useState("");
  // No explicit pick yet (or the picked id fell off the list) -> default to the first
  // section, mirroring how Range=Loop reads live transport state rather than requiring
  // an extra "select one" step.
  const effectiveSectionId = sections.some((s) => s.id === sectionId) ? sectionId : (sections[0]?.id ?? "");
  const [tail, setTail] = useState<TailChoice>("cut");
  const [tailSeconds, setTailSeconds] = useState(2);
  const [mode, setMode] = useState<ModeChoice>("mixdown");
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // How many files the last stems run actually produced — the engine's count, not the
  // pre-flight estimate, so the done-block reports what happened rather than what we guessed.
  const [doneCount, setDoneCount] = useState(0);
  const tracks = useStore((s) => s.snapshot?.tracks ?? []);
  const planned = stemCount(tracks, includeEmpty);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  // "Copied" flash — there's no native "Reveal in Finder" bridge command (JUCE's
  // File::revealToUser() has no MoshOps surface today), so a guest tester's best path to
  // their export is: see the full path, copy it, then Cmd+Shift+G it into Finder.
  const [copied, setCopied] = useState<"file" | "folder" | null>(null);
  const depths = FORMATS.find((f) => f.value === format)!.depths;
  const runStems = async () => {
    setConfirming(false);
    setBusy(true); setDone(""); setCopied(null); setDoneCount(0);
    // No `dir`: the backend picks <session>/exports/stems-<ms>/, exactly as the mixdown
    // path leaves `file` unset. There is no directory picker anywhere in this app (the
    // native FileChooser flags are files-only), so inventing an unvalidated free-text
    // destination here would be strictly worse than the default that already works.
    const args: Record<string, unknown> = { format, bitDepth };
    if (includeEmpty) args.includeEmpty = true;
    const r = await exec("export_stems", args);
    setBusy(false);
    if (r.ok) {
      const d = r.data as { dir?: string; count?: number } | undefined;
      setDone(d?.dir ?? "exported");
      setDoneCount(d?.count ?? 0);
    }
  };
  const onExport = async () => {
    // Stems gets a confirm gate; the mixdown does not. Not ceremony: export_stems runs N
    // full renders inline on the message thread (execute_command is not threaded the way
    // brain_chat is), with no progress and no cancel — and if any hosted plugin forces
    // real-time rendering, EVERY stem renders in real time. An accidental click is
    // therefore unrecoverable, which is exactly the case a confirm exists for.
    if (mode === "stems") { setConfirming(true); return; }
    setBusy(true); setDone(""); setCopied(null); setDoneCount(0);
    const args: Record<string, unknown> = { format, bitDepth };
    if (range === "custom") {
      args.range = "custom"; args.start = start; args.end = end;
    } else if (range === "section") {
      const sec = sections.find((s) => s.id === effectiveSectionId);
      const resolved = resolveSectionExportRange(sec, { tempo, timeSigNumerator, timeSigDenominator });
      if (resolved) { args.range = "custom"; args.start = resolved.start; args.end = resolved.end; }
    } else if (range === "loop") {
      args.range = "loop";
    }
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
        <label className="pop-row"><span>What</span>
          <select data-testid="export-mode" value={mode} onChange={(e) => { setMode(e.target.value as ModeChoice); setDone(""); }}>
            <option value="mixdown">Mixdown (one file)</option>
            <option value="stems">Stems (one file per track)</option>
          </select>
        </label>
        <label className="pop-row"><span>Format</span>
          <select value={format} onChange={(e) => { const f = e.target.value as ExportFormat; setFormat(f); const d = FORMATS.find((x) => x.value === f)!.depths; if (!d.includes(bitDepth)) setBitDepth(d.includes(24) ? 24 : d[0]); }}>
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.value.toUpperCase()}</option>)}
          </select>
        </label>
        <label className="pop-row"><span>Bit depth</span>
          <select data-testid="export-depth" value={String(bitDepth)} onChange={(e) => setBitDepth(Number(e.target.value))}>{depths.map((d) => <option key={d} value={d}>{d}-bit</option>)}</select>
        </label>
        {/* #551 — the note that used to sit here, warning a 16-bit render was undithered and
            telling the producer to master from 24-bit instead, is GONE: what it disclosed is
            fixed. Every export below 32-bit now gets ±1 LSB TPDF dither at the final
            requantisation (CAP-EXP-001, src/audio/TpdfDither.h). Disclosing a problem you no
            longer have is its own small lie, and worse than silence — a producer acts on it
            and avoids a 16-bit master that is now perfectly good. Nothing replaces it: the
            behaviour is automatic and correct, and a note saying so would be machinery nobody
            has to think about. The exporter reports `dither: "tpdf" | "none"` on the command
            result if a surface ever needs to ask. ExportControls.dither.test.ts keeps the old
            copy from creeping back. */}
        {/* Range and Tail are MIXDOWN-only. export_stems has no such args — it always renders
            the full edit length from a common zero point so the stems re-import aligned — so
            showing them here would be controls that visibly do nothing. */}
        {mode === "stems" ? (
          <>
            <label className="pop-row"><span>Empty tracks</span>
              <input data-testid="export-include-empty" type="checkbox" checked={includeEmpty}
                onChange={(e) => setIncludeEmpty(e.target.checked)} />
            </label>
            <div className="pop-note" data-testid="export-stem-plan">
              {planned === 0
                ? "No tracks to export — every track is empty."
                : `${planned} file${planned === 1 ? "" : "s"}, one per track, into a new folder in this session's exports.`}
            </div>
          </>
        ) : (<>
        <label className="pop-row"><span>Range</span>
          <select data-testid="export-range" value={range} onChange={(e) => setRange(e.target.value as RangeChoice)}>
            <option value="full">Full mix</option>
            <option value="loop" disabled={!hasLoop}>Loop region{hasLoop ? "" : " (none set)"}</option>
            <option value="section" disabled={!hasSections}>Section{hasSections ? "" : " (none defined)"}</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {range === "section" && hasSections && (
          <label className="pop-row"><span>Section</span>
            <select data-testid="export-section" value={effectiveSectionId} onChange={(e) => setSectionId(e.target.value)}>
              {sections.map((sec) => <option key={sec.id} value={sec.id}>{sec.name}</option>)}
            </select>
          </label>
        )}
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
        </>)}
      </div>
      <div className="pop-actions">
        {/* Nothing to render is prevented, not surfaced: native answers this with
            "no renderable tracks (all empty or hidden)", which is a worse way to learn it. */}
        <button className="btn" data-testid="export-run" disabled={busy || !audioEnabled || (mode === "stems" && planned === 0)} onClick={onExport}>{busy ? "Exporting…" : "Export"}</button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Export stems?"
          testId="export-stems-confirm"
          confirmLabel={`Export ${planned} file${planned === 1 ? "" : "s"}`}
          body={<>
            <div>{planned} file{planned === 1 ? "" : "s"} — one per track — into a new folder in this session's exports. You'll get the full path when it finishes.</div>
            <div><strong>Mosh won't respond until it's done.</strong> Each track is rendered in turn and there's no way to cancel once it starts. A short project takes seconds; a long one with plugins that need real-time rendering can take considerably longer.</div>
          </>}
          onConfirm={() => void runStems()}
          onCancel={() => setConfirming(false)}
        />
      )}
      {done && (
        <div className="pop-note export-done" data-testid="export-done">
          <div>{doneCount > 0 ? `Exported ${doneCount} stem${doneCount === 1 ? "" : "s"} to:` : "Exported to:"}</div>
          <div className="tc export-path" title={done}>{done}</div>
          <div className="pop-actions">
            {/* For stems the result IS a folder, so "Copy path" already copies what you want
                and a second button pointing at its parent would only be a way to paste the
                wrong thing. The mixdown keeps both. */}
            <button className="btn" data-testid="export-copy-path" onClick={() => void copy("file")}>{copied === "file" ? "Copied ✓" : doneCount > 0 ? "Copy folder" : "Copy path"}</button>
            {doneCount === 0 && (
              <button className="btn" data-testid="export-copy-folder" onClick={() => void copy("folder")}>{copied === "folder" ? "Copied ✓" : "Copy folder"}</button>
            )}
          </div>
          <div className="pop-note">Folder hidden by default — in Finder press ⌘⇧G (Go to Folder) and paste it.</div>
        </div>
      )}
    </>
  );
}
