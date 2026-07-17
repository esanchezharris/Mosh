// Finish-My-Song — the v2 Lyrics tab (per-track lyric sheet). A pure client of the
// command seam, mirroring the generative drawer's create → edit → review shape.
//   L0: create a sheet, write lines with ___ gaps, a LIVE flow meter, the rhyme tool.
//   L2: the generation loop — Finish gaps / fill a line / suggest the next, then review
//       the ranked proposals (accept / reject / regenerate), constraint-checked by phonology.

import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { countSyllables, gridTarget, flowStatus, parseSeed } from "../../lyrics/flowMeter";
import type { Track, LyricLine, LyricProposal, RhymeCandidate, LyricAnalysis } from "../../types";

export function LyricPanel({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const sheet = track.lyricSheet;
  const [busy, setBusy] = useState(false);
  // The inline "ghost" next-bar suggestion: the index of the line currently shown as a
  // greyed tab-to-accept ghost (vs the full proposal-review block). UI-local; cleared on
  // accept / dismiss. (§7/§9 rung 2 — the engine command is the existing suggest_next_line.)
  const [ghostIndex, setGhostIndex] = useState<number | null>(null);
  // §7 — "it's learning my voice" cue: the cross-song corpus count (counts only; grows as
  // accepted lines accumulate). Pulled on demand (never via the snapshot — that would spawn
  // the service); -1/absent ⇒ service down ⇒ shown as nothing.
  const [corpusLines, setCorpusLines] = useState<number | null>(null);
  const acceptedCount = sheet?.lines.filter((l) => l.status === "accepted" || l.status === "asserted").length ?? 0;
  useEffect(() => {
    if (!sheet) return;
    let alive = true;
    void exec("get_lyric_corpus_stats", {}).then((r) => {
      if (alive && r.ok) setCorpusLines((r.data as { lines?: number })?.lines ?? null);
    });
    return () => { alive = false; };
  }, [exec, sheet?.id, acceptedCount]);

  if (!sheet) {
    return (
      <div className="v2-lyrics" data-testid="lyric-panel">
        <span className="rack-empty">Write the hook — start a lyric sheet on this track.</span>
        <button className="v2-btn primary" data-testid="lyric-create"
          onClick={() => void exec("create_lyric_sheet", { trackId: track.id })}>+ Write Lyrics</button>
      </div>
    );
  }

  const run = async (cmd: string, args: Record<string, unknown>) => {
    setBusy(true);
    try { await exec(cmd, { trackId: track.id, ...args }); } finally { setBusy(false); }
  };
  // "Suggest the next line" = append an empty line, fill it, then surface its top proposal
  // as an INLINE GHOST (greyed, tab-to-accept) rather than the full review block.
  const suggestNext = async () => {
    const next = sheet.lines.length;
    setBusy(true);
    try {
      await exec("set_lyric_line", { trackId: track.id, lineIndex: next, role: "verse", seedText: "" });
      await exec("suggest_next_line", { trackId: track.id, afterIndex: next - 1 });
      setGhostIndex(next);
    } finally { setBusy(false); }
  };

  return (
    <div className="v2-lyrics" data-testid="lyric-panel" data-has-sheet="true" data-busy={busy}>
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

      <label className="v2-lyric-stylebias" data-testid="lyric-stylebias" title="§7 — bias generation toward your own voice (this song's accepted lines + your accumulated corpus)">
        <input type="checkbox" checked={!!sheet.styleBias} aria-label="Bias to my voice"
          onChange={(e) => void exec("set_lyric_constraint", { trackId: track.id, styleBias: e.target.checked })} />
        <span>Sound like me</span>
        {corpusLines != null && corpusLines > 0 && (
          <span className="v2-lyric-corpus" data-testid="lyric-corpus-count"
            title="lines accumulated in your voice corpus — grows each time you accept a line">{corpusLines} in your voice</span>
        )}
      </label>

      <div className="v2-lyric-actions">
        <button className="v2-btn primary" data-testid="lyric-finish" disabled={busy || sheet.lines.length === 0}
          onClick={() => void run("complete_lyrics", {})}>{busy ? "…" : "✨ Finish gaps"}</button>
        <button className="v2-btn" data-testid="lyric-analyze" disabled={busy || sheet.lines.length === 0}
          title="Precise phonology — syllables, stress, rhyme (dictionary, no LLM)"
          onClick={() => void run("analyze_lyrics", {})}>Analyze flow</button>
      </div>

      {sheet.lines.some((l) => l.status === "skeleton") && (
        <div className="v2-skel-confirm" data-testid="skeleton-confirm-bar" role="status">
          <span>From your take — confirm the syllable grid, then finish the words.</span>
          <button className="v2-btn primary" data-testid="skeleton-confirm" disabled={busy}
            onClick={() => void run("confirm_skeleton", {})}>✓ Confirm flow</button>
        </div>
      )}

      <ol className="v2-lyric-lines" data-testid="lyric-lines">
        {sheet.lines.map((line) => (
          <LyricLineRow key={line.index} trackId={track.id} line={line} grid={sheet.grid} busy={busy} run={run}
            isGhost={line.index === ghostIndex} onGhostDone={() => setGhostIndex(null)} />
        ))}
      </ol>
      <div className="v2-lyric-add">
        <button className="v2-btn" data-testid="lyric-add-line"
          onClick={() => void exec("set_lyric_line", { trackId: track.id, lineIndex: sheet.lines.length, role: "verse", seedText: "" })}>+ line</button>
        <button className="v2-btn" data-testid="lyric-suggest" disabled={busy} onClick={() => void suggestNext()}>✨ suggest line</button>
      </div>

      <RhymeTool />
    </div>
  );
}

function LyricLineRow({ trackId, line, grid, busy, run, isGhost, onGhostDone }: {
  trackId: string; line: LyricLine; grid: string; busy: boolean;
  run: (cmd: string, args: Record<string, unknown>) => Promise<void>;
  isGhost: boolean; onGhostDone: () => void;
}) {
  const exec = useStore((s) => s.exec);

  // ── Skeleton row (Phase-2 grid editor) ──────────────────────────────────────────────
  // A line built from a hummed take lands `skeleton` (distinct from L2 `proposed` = "has
  // proposals"): a wordless syllable grid the producer tunes (−/+ the count) before confirming.
  // No text input — it's all gaps; confirm_skeleton flips it to `seed` so "Finish gaps" fills
  // the words. (set_lyric_line preserves the `skeleton` status while editing.)
  if (line.status === "skeleton") {
    const target = line.syllableTarget > 0 ? line.syllableTarget : gridTarget(grid, 1);
    const setTarget = (n: number) =>
      exec("set_lyric_line", { trackId, lineIndex: line.index, syllableTarget: Math.max(1, n) });
    return (
      <li className="v2-lyric-line v2-skel-line" data-testid={`skeleton-line-${line.index}`} data-status="skeleton">
        <span className="v2-lyric-role" data-role={line.role}>{line.role}</span>
        {line.origin && (
          <span className="v2-lyric-origin" data-testid={`lyric-origin-${line.index}`}
            data-origin={line.origin} title="words heard in your take anchor this line">♪</span>
        )}
        <span className="v2-skel-grid" data-testid={`skel-grid-${line.index}`} aria-label={`${target} syllable slots`}>
          {(() => {
            // Extraction anchors: heard words render as chips in their slots; gaps stay
            // pips. An all-gaps skeleton (the wordless take) renders exactly as before.
            const toks = (line.seedText || "").split(/\s+/).filter(Boolean);
            const anchored = toks.some((t) => !/^_{2,}$/.test(t));
            if (!anchored)
              return Array.from({ length: Math.min(target, 32) }).map((_, i) => (
                <span key={i} className="v2-skel-pip" aria-hidden="true">•</span>
              ));
            return toks.slice(0, 32).map((t, i) =>
              /^_{2,}$/.test(t)
                ? <span key={i} className="v2-skel-pip" aria-hidden="true">•</span>
                : <span key={i} className="v2-skel-chip" data-testid={`skel-chip-${line.index}-${i}`}>{t}</span>);
          })()}
        </span>
        <span className="v2-skel-count" data-testid={`skel-count-${line.index}`}>{target} syl</span>
        <button className="btn" data-testid={`skel-dec-${line.index}`} disabled={busy || target <= 1}
          aria-label={`Fewer syllables, line ${line.index + 1}`} onClick={() => void setTarget(target - 1)}>−</button>
        <button className="btn" data-testid={`skel-inc-${line.index}`} disabled={busy}
          aria-label={`More syllables, line ${line.index + 1}`} onClick={() => void setTarget(target + 1)}>+</button>
        <button className="btn x" data-testid={`lyric-rm-${line.index}`} title="remove line"
          aria-label={`Remove line ${line.index + 1}`}
          onClick={() => void exec("remove_lyric_line", { trackId, lineIndex: line.index })}>✕</button>
      </li>
    );
  }

  // ── Inline ghost (the next-bar suggestion) ──────────────────────────────────────────
  // While this line is the active ghost AND its top proposal has landed AND nothing's been
  // committed yet, render it as a greyed, focused one-liner: Tab accepts it, Esc throws it
  // (and the throwaway line) away. Falls back to the normal row until the proposal arrives.
  const ghostTop = line.proposals?.[0];
  if (isGhost && ghostTop && !line.text.trim()) {
    const acceptGhost = async () => { await exec("accept_lyric_proposal", { trackId, lineIndex: line.index, proposalIndex: 0 }); onGhostDone(); };
    const dismissGhost = async () => {
      await exec("reject_lyric_proposal", { trackId, lineIndex: line.index });
      await exec("remove_lyric_line", { trackId, lineIndex: line.index });
      onGhostDone();
    };
    return (
      <li className="v2-lyric-line v2-lyric-ghost-line" data-testid={`ghost-line-${line.index}`} data-status="ghost">
        <span className="v2-lyric-role" data-role={line.role}>{line.role}</span>
        <input className="v2-lyric-text v2-lyric-ghost-text" data-testid={`ghost-text-${line.index}`}
          readOnly autoFocus value={ghostTop.text}
          aria-label={`Suggested next line: ${ghostTop.text}. Press Tab to accept or Escape to dismiss.`}
          onKeyDown={(e) => {
            if (e.key === "Tab") { e.preventDefault(); void acceptGhost(); }
            else if (e.key === "Escape") { e.preventDefault(); void dismissGhost(); }
          }} />
        <span className="v2-lyric-ghost-hint" aria-hidden="true">⇥ accept · esc</span>
      </li>
    );
  }

  const content = line.text || line.seedText;
  const count = countSyllables(content);
  const target = line.syllableTarget > 0 ? line.syllableTarget : gridTarget(grid, 1);
  const state = flowStatus(count, target, line.syllableTol || 1);
  const gaps = parseSeed(line.seedText).gaps;
  const fillable = !line.locked && (!line.text.trim() || gaps > 0);
  const canAssert = Boolean(content.trim() && !content.includes("___") && /[A-Za-z0-9]/.test(content));

  return (
    <li className="v2-lyric-line" data-testid={`lyric-line-${line.index}`} data-flow={state} data-status={line.status}>
      <div className="v2-lyric-line-main">
        <span className="v2-lyric-role" data-role={line.role}>{line.role}</span>
        {line.origin && (
          <span className="v2-lyric-origin" data-testid={`lyric-origin-${line.index}`}
            data-origin={line.origin}
            title={line.origin === "sung" ? "verbatim — you sang this"
                 : line.origin === "partial" ? "partly from your take"
                 : line.origin === "mixed" ? "generated around your words"
                 : line.origin === "edited" ? "edited by hand" : "generated"}>
            {line.origin === "sung" ? "♪ sung" : line.origin === "partial" ? "♪ part" : line.origin}
          </span>
        )}
        <input className="v2-lyric-text" aria-label={`line ${line.index + 1}`}
          key={content} defaultValue={content} placeholder="type bars, ___ for a gap"
          onBlur={(e) => {
            if (e.target.value === content) return;
            // A finalized line (accepted/sung) edits its TEXT — the backend mirrors and
            // demotes "sung" → "edited"; a seed-stage line keeps committing to the seed.
            void exec("set_lyric_line", line.text.trim()
              ? { trackId, lineIndex: line.index, text: e.target.value, seedText: e.target.value }
              : { trackId, lineIndex: line.index, seedText: e.target.value });
          }} />
        <span className={`v2-flow-meter st-${state}`} data-testid={`flow-${line.index}`}
          title={`${count} syllables vs ~${target} (${grid})${gaps ? `, ${gaps} gap(s)` : ""}`}>
          {count}/{target}{gaps ? ` ·${gaps}_` : ""}
        </span>
        {line.rhymeGroup && <span className="v2-lyric-rgroup">{line.rhymeGroup}</span>}
        {fillable && !line.proposals?.length && (
          <button className="btn" data-testid={`lyric-fill-${line.index}`} disabled={busy} title="fill this line"
            aria-label={`Fill line ${line.index + 1}`}
            onClick={() => void run("fill_lyric_gap", { lineIndex: line.index })}>✨</button>
        )}
        {canAssert && !line.asserted && (
          <button className="btn" data-testid={`lyric-assert-${line.index}`} disabled={busy}
            title="assert these words for sing render"
            onClick={() => void exec("assert_lyric_line", { trackId, lineIndex: line.index, text: content })}>Assert</button>
        )}
        {line.asserted && (
          <span className="v2-lyric-rgroup" data-testid={`lyric-asserted-${line.index}`}>asserted</span>
        )}
        <button className={`btn${line.locked ? " on" : ""}`} data-testid={`lyric-lock-${line.index}`}
          title="lock this line" aria-label={`${line.locked ? "Unlock" : "Lock"} line ${line.index + 1}`} aria-pressed={line.locked}
          onClick={() => void exec("set_lyric_line", { trackId, lineIndex: line.index, locked: !line.locked })}>{line.locked ? "🔒" : "🔓"}</button>
        <button className="btn x" data-testid={`lyric-rm-${line.index}`} title="remove line" aria-label={`Remove line ${line.index + 1}`}
          onClick={() => void exec("remove_lyric_line", { trackId, lineIndex: line.index })}>✕</button>
      </div>
      {line.analysis && <FlowViz index={line.index} a={line.analysis} />}
      {!!line.proposals?.length && (
        <div className="v2-lyric-proposals" data-testid={`lyric-proposals-${line.index}`} role="group" aria-label={`Proposals for line ${line.index + 1}`}>
          {line.proposals.map((p: LyricProposal, j) => (
            <div key={j} className="v2-lyric-prop" data-testid={`lyric-prop-${line.index}-${j}`} data-passes={p.passes}>
              <span className="v2-lyric-prop-text">{p.text}</span>
              <span className={`v2-lyric-prop-badge st-${p.grade ?? "free"}`} title={`${p.syllables} syllables · ${p.grade ?? "free"}`}>
                {p.syllables}{p.passes ? " ✓" : " !"}
              </span>
              <button className="btn" data-testid={`lyric-accept-${line.index}-${j}`}
                onClick={() => void exec("accept_lyric_proposal", { trackId, lineIndex: line.index, proposalIndex: j })}>Accept</button>
            </div>
          ))}
          <div className="v2-lyric-prop-actions">
            <button className="btn" data-testid={`lyric-regen-${line.index}`} disabled={busy}
              onClick={() => void run("regenerate_lyric", { lineIndex: line.index })}>⟳ regenerate</button>
            <button className="btn" data-testid={`lyric-reject-${line.index}`}
              onClick={() => void exec("reject_lyric_proposal", { trackId, lineIndex: line.index })}>Reject</button>
          </div>
        </div>
      )}
    </li>
  );
}

// L1 — the precise flow visualizer. Draws the dictionary stress contour as a row of
// per-word dots (● stressed, · unstressed), the precise syllable count vs target, and the
// rhyme grade vs the group anchor. Distinct from the live local meter (an instant
// estimate) — this is the phonology service's exact read, so it can disagree and correct.
function FlowViz({ index, a }: { index: number; a: LyricAnalysis }) {
  return (
    <div className="v2-flow-viz" data-testid={`flow-viz-${index}`}
      data-analyzed={a.analyzed} data-complete={a.complete} data-syl-ok={a.syllableOk}>
      <span className="v2-flow-stress" aria-label={`stress ${a.stress || "n/a"}`}>
        {a.words.length === 0 ? <span className="v2-flow-empty">—</span> : a.words.map((w, i) => (
          <span key={i} className="v2-flow-word" data-in-dict={w.inDict}
            title={`${w.w} · ${w.syllables} syllable${w.syllables === 1 ? "" : "s"}${w.inDict ? "" : " (estimated)"}`}>
            {Array.from(w.stress).map((s, j) => (
              <span key={j} className={`v2-flow-dot${s === "X" ? " on" : ""}`} aria-hidden="true">{s === "X" ? "●" : "·"}</span>
            ))}
          </span>
        ))}
      </span>
      <span className={`v2-flow-syl${a.syllableOk ? " ok" : " off"}`} data-testid={`flow-syl-${index}`}
        title={`precise: ${a.syllables} syllables vs target ${a.target}±${a.tol}`}>{a.syllables}/{a.target}</span>
      {a.rhymeGroup && (
        <span className={`v2-flow-rhyme st-${a.rhymeGrade}`} data-testid={`flow-rhyme-${index}`} data-ok={a.rhymeOk}
          title={a.rhymeAnchor && a.rhymeGrade !== "anchor" ? `${a.rhymeGrade} rhyme vs "${a.rhymeAnchor}"` : a.rhymeGrade}>
          {a.rhymeGrade === "anchor" ? "⚓ anchor" : a.rhymeGrade}
          {a.rhymeAnchor && a.rhymeGrade !== "anchor" ? ` →${a.rhymeAnchor}` : ""}
        </span>
      )}
    </div>
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
