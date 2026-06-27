// Finish-My-Song — the v2 Lyrics tab (per-track lyric sheet). A pure client of the
// command seam, mirroring the generative drawer's create → edit → review shape. L0
// ships: create a sheet, write lines with ___ gaps, a LIVE flow meter (instant local
// syllable estimate vs the grid target), per-line constraints, and a rhyme tool
// (get_rhymes, phonology-only — no LLM). Generation (suggest/complete/accept) is L2.

import { useState } from "react";
import { useStore } from "../../store";
import { countSyllables, gridTarget, flowStatus, parseSeed } from "../../lyrics/flowMeter";
import type { Track, LyricLine, RhymeCandidate } from "../../types";

export function LyricPanel({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const sheet = track.lyricSheet;

  if (!sheet) {
    return (
      <div className="v2-lyrics" data-testid="lyric-panel">
        <span className="rack-empty">Write the hook — start a lyric sheet on this track.</span>
        <button className="v2-btn primary" data-testid="lyric-create"
          onClick={() => void exec("create_lyric_sheet", { trackId: track.id })}>+ Write Lyrics</button>
      </div>
    );
  }

  return (
    <div className="v2-lyrics" data-testid="lyric-panel" data-has-sheet="true">
      <div className="v2-lyric-head">
        <span className="v2-lyric-title">Lyrics</span>
        <select className="btn ghost" aria-label="Beat grid" value={sheet.grid}
          onChange={(e) => void exec("set_lyric_constraint", { trackId: track.id, grid: e.target.value })}>
          <option value="1/4">1/4</option>
          <option value="1/8">1/8</option>
          <option value="1/16">1/16</option>
        </select>
        <select className="btn ghost" aria-label="Rhyme strictness" value={sheet.rhymeStrictness}
          onChange={(e) => void exec("set_lyric_constraint", { trackId: track.id, rhymeStrictness: e.target.value })}>
          <option value="perfect">perfect</option>
          <option value="slant">slant</option>
          <option value="free">free</option>
        </select>
      </div>

      <input className="v2-lyric-topic" placeholder="topic / mood (e.g. comeback, defiant)"
        aria-label="Topic" defaultValue={sheet.topic}
        onBlur={(e) => { if (e.target.value !== sheet.topic) void exec("set_lyric_constraint", { trackId: track.id, topic: e.target.value }); }} />

      <ol className="v2-lyric-lines" data-testid="lyric-lines">
        {sheet.lines.map((line) => (
          <LyricLineRow key={line.index} trackId={track.id} line={line} grid={sheet.grid} />
        ))}
      </ol>
      <button className="v2-btn" data-testid="lyric-add-line"
        onClick={() => void exec("set_lyric_line", { trackId: track.id, lineIndex: sheet.lines.length, role: "verse", seedText: "" })}>+ line</button>

      <RhymeTool />
    </div>
  );
}

function LyricLineRow({ trackId, line, grid }: { trackId: string; line: LyricLine; grid: string }) {
  const exec = useStore((s) => s.exec);
  // The seed (with ___ gaps) drives the live meter; once a line is finalized, `text` wins.
  const content = line.text || line.seedText;
  const count = countSyllables(content);
  const target = line.syllableTarget > 0 ? line.syllableTarget : gridTarget(grid, 1);
  const state = flowStatus(count, target, line.syllableTol || 1);
  const gaps = parseSeed(line.seedText).gaps;

  return (
    <li className="v2-lyric-line" data-testid={`lyric-line-${line.index}`} data-flow={state}>
      <span className="v2-lyric-role" data-role={line.role}>{line.role}</span>
      <input className="v2-lyric-text" aria-label={`line ${line.index + 1}`}
        defaultValue={content} placeholder="type bars, ___ for a gap"
        onBlur={(e) => { if (e.target.value !== content) void exec("set_lyric_line", { trackId, lineIndex: line.index, seedText: e.target.value }); }} />
      <span className={`v2-flow-meter st-${state}`} data-testid={`flow-${line.index}`}
        title={`${count} syllables vs ~${target} (${grid})${gaps ? `, ${gaps} gap(s)` : ""}`}>
        {count}/{target}{gaps ? ` ·${gaps}_` : ""}
      </span>
      {line.rhymeGroup && <span className="v2-lyric-rgroup">{line.rhymeGroup}</span>}
      <button className={`btn${line.locked ? " on" : ""}`} data-testid={`lyric-lock-${line.index}`}
        title="lock this line" aria-label={`${line.locked ? "Unlock" : "Lock"} line ${line.index + 1}`} aria-pressed={line.locked}
        onClick={() => void exec("set_lyric_line", { trackId, lineIndex: line.index, locked: !line.locked })}>{line.locked ? "🔒" : "🔓"}</button>
      <button className="btn x" data-testid={`lyric-rm-${line.index}`} title="remove line" aria-label={`Remove line ${line.index + 1}`}
        onClick={() => void exec("remove_lyric_line", { trackId, lineIndex: line.index })}>✕</button>
    </li>
  );
}

// The rhyme tool — rung 1: phonology only, no LLM. Type a word, get ranked rhymes.
function RhymeTool() {
  const exec = useStore((s) => s.exec);
  const [word, setWord] = useState("");
  const [strictness, setStrictness] = useState("slant");
  const [results, setResults] = useState<RhymeCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    const w = word.trim();
    if (!w) return;
    setBusy(true); setError(null);
    const r = await exec("get_rhymes", { word: w, strictness });
    setBusy(false);
    if (r.ok) setResults(((r.data as { candidates?: RhymeCandidate[] })?.candidates) ?? []);
    else { setResults(null); setError(r.error ?? "rhyme lookup failed"); }
  };

  return (
    <div className="v2-rhyme-tool" data-testid="rhyme-tool">
      <div className="v2-rhyme-row">
        <input className="v2-rhyme-input" placeholder="rhymes for…" aria-label="Rhyme word"
          value={word} onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void lookup(); }} />
        <select className="btn ghost" aria-label="Rhyme type" value={strictness} onChange={(e) => setStrictness(e.target.value)}>
          <option value="perfect">perfect</option>
          <option value="slant">slant</option>
        </select>
        <button className="v2-btn" data-testid="rhyme-go" disabled={busy || !word.trim()} onClick={() => void lookup()}>{busy ? "…" : "Rhymes"}</button>
      </div>
      {error && <span className="rack-empty" data-testid="rhyme-error">{error}</span>}
      {results && (
        <ul className="v2-rhyme-results" data-testid="rhyme-results">
          {results.length === 0 ? <li className="rack-empty">no rhymes found</li>
            : results.map((c) => <li key={c.word} className={`v2-rhyme st-${c.grade}`}>{c.word}<span className="v2-rhyme-syl">{c.syllables}</span></li>)}
        </ul>
      )}
    </div>
  );
}
