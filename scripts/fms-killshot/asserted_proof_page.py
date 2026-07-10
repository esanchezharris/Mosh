from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path


def _load(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _current(path: Path, label: str, manifest: dict) -> bool:
    entry = manifest.get("files", {}).get(label)
    return bool(path.is_file() and entry and hashlib.sha256(path.read_bytes()).hexdigest() == entry.get("sha256"))


def _all_inputs_current(manifest: dict, artifact_root: Path) -> bool:
    output_labels = {
        "renderPlan", "targetScore", "rawSlice", "guide", "relaxedGuide", "repairPlan", "repairTargetScore", "repairGuide",
        "localRepairGuide", "localRepairMetadata", "svc", "lexicalGuide", "lexicalGuideUnpitched", "lexicalGuideMetadata",
        "voiceboxLexicalGuide", "voiceboxLexicalGuideUnpitched", "voiceboxLexicalGuideMetadata",
    }
    for label, entry in manifest.get("files", {}).items():
        if label in output_labels:
            continue
        path = Path(str(entry.get("path", "")))
        if not path.is_absolute():
            path = artifact_root / path
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != entry.get("sha256"):
            return False
    return True


def _audio_card(number: str, title: str, detail: str, path: Path, relative: str, label: str, manifest: dict, inputs_current: bool) -> str:
    if not path.is_file():
        player = "<div class='empty'>Not rendered in this batch.</div>"
        status = "missing"
    elif not inputs_current or not _current(path, label, manifest):
        player = "<div class='quarantine'>Quarantined: an input or artifact hash does not match the current manifest.</div>"
        status = "quarantined"
    else:
        player = f"<audio controls preload='metadata' src='{html.escape(relative)}'></audio>"
        status = "current"
    return f"""
      <article class='evidence {status}'>
        <div class='stage'>{number}</div>
        <div class='evidence-copy'><div class='eyebrow'>{html.escape(status)}</div><h2>{html.escape(title)}</h2><p>{html.escape(detail)}</p>{player}</div>
      </article>"""


def _owner_passes_current_manifest(opening: Path) -> bool:
    verdict_path, manifest_path = opening / "owner-verdict.json", opening / "manifest.json"
    if not verdict_path.is_file() or not manifest_path.is_file():
        return False
    verdict = _load(verdict_path)
    manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    return verdict.get("verdict") == "pass" and verdict.get("manifestSha256") == manifest_hash


def _expansion_sections(output_dir: Path) -> str:
    sections = []
    definitions = (
        ("middle", "Middle known-lyrics stress test"),
        ("truman-lead", "Truman lead-in"),
        ("first-half-continuous", "Continuous corrected first half"),
    )
    for clip_id, title in definitions:
        clip_dir = output_dir / clip_id
        plan_path, manifest_path = clip_dir / "asserted-render-plan.json", clip_dir / "manifest.json"
        if not plan_path.is_file() or not manifest_path.is_file():
            continue
        plan, manifest = _load(plan_path), _load(manifest_path)
        inputs_current = _all_inputs_current(manifest, output_dir.parent)
        metrics_path = clip_dir / "metrics.json"
        metrics = _load(metrics_path) if inputs_current and _current(metrics_path, "metrics", manifest) else {}
        words = plan.get("words", [])
        text = " ".join(str(word["text"]) for word in words)
        heuristics = plan.get("articulationHeuristics", [])
        metric_text = (
            f"attack median {metrics.get('medianAttackErrorMs', 'pending')}ms · "
            f"pitch median {metrics.get('medianVoicedPitchErrorSemitones', 'pending')}st · "
            f"silence bleed {metrics.get('silenceBleedMs', 'pending')}ms"
        )
        players = [
            _audio_card("R", "Raw reference", "Original owner performance for this exact known-lyrics window.", clip_dir / "raw.wav", f"{clip_id}/raw.wav", "rawSlice", manifest, inputs_current),
            _audio_card("S", "SoulX heuristic render", "Corrected words, measured pitch, original attacks, and narrow DH-schwa weighting.", clip_dir / "guide.wav", f"{clip_id}/guide.wav", "guide", manifest, inputs_current),
        ]
        sections.append(
            f"<article class='expansion-card'><div class='clip-head'><div><div class='kicker'>Diagnostic · {html.escape(clip_id)}</div>"
            f"<h3>{html.escape(title)}</h3></div><div class='clip-stats'>{len(words)} words · {len(heuristics)} heuristic applications<br>{html.escape(metric_text)}</div></div>"
            f"<details><summary>Asserted text</summary><p>{html.escape(text)}</p></details><div class='rail'>{''.join(players)}</div></article>"
        )
    if not sections:
        return ""
    return "<section class='expansions'><div class='section-heading'><div class='kicker'>Known-first-half system test</div><h2>Beyond the opening.</h2><p>These are diagnostic expansions after a close verdict, not accepted masters.</p></div>" + "".join(sections) + "</section>"


def _ace_candidate_chips(evaluation: dict) -> str:
    chips = []
    for entry in (evaluation.get("lexical") or {}).get("perWord", []):
        title = f"heard: {entry.get('heard')}" if entry.get("heard") else "not heard"
        chips.append(f"<span class='chip {html.escape(str(entry.get('cls')))}' title='{html.escape(title)}'>{html.escape(str(entry.get('text')))}</span>")
    return "".join(chips)


def _ace_metric_cells(candidate: dict) -> str:
    failures = set(candidate.get("shortlistFailures", []))
    cells = (
        ("Attack median", candidate["metrics"].get("medianAttackErrorMs"), "ms", "medianAttack"),
        ("Attack p95", candidate["metrics"].get("p95AttackErrorMs"), "ms", "p95Attack"),
        ("Silence bleed (pre-gate)", candidate["metrics"].get("silenceBleedMs"), "ms", "silenceBleed"),
        ("Pitch median", candidate["metrics"].get("medianAbsPitchErrorSemitones"), "st", "medianPitch"),
        ("Register offset", candidate["metrics"].get("registerOffsetSemitones"), "st", None),
        ("Octave error", candidate["metrics"].get("longestOctaveErrorMs"), "ms", "octaveRun"),
        ("Voiced overlap", candidate["metrics"].get("voicedOverlap"), "", "voicedOverlap"),
        ("Contour corr", candidate["metrics"].get("contourCorrelation"), "", None),
        ("Envelope corr", candidate["metrics"].get("envelopeCorrelation"), "", None),
    )
    rendered = []
    for label, value, unit, gate in cells:
        shown = "pending" if value is None else f"{value}{(' ' + unit) if unit else ''}"
        failed = " fail" if gate in failures else ""
        rendered.append(f"<div class='{failed.strip()}'><span>{html.escape(label)}</span><strong>{html.escape(str(shown))}</strong></div>")
    return "".join(rendered)


def _ab_arm_card(letter: str, arm: dict, label_key: str, ab_manifest: dict, output_dir: Path) -> str:
    audio_rel = str(arm.get("audio", ""))
    audio_path = output_dir / audio_rel
    if _current(audio_path, label_key, ab_manifest):
        player = f"<audio controls preload='metadata' src='{html.escape(audio_rel)}'></audio>"
    else:
        player = "<div class='quarantine'>Quarantined: this arm's audio does not match the A/B manifest.</div>"
    lexical = arm.get("lexical") or {}
    metrics = arm.get("metrics") or {}
    stats = (
        f"lexical {lexical.get('hits', '?')}/16 hits · {lexical.get('misses', '?')} miss · "
        f"pitch {metrics.get('medianAbsPitchErrorSemitones', '?')} st · register {metrics.get('registerOffsetSemitones', '?')} st · "
        f"bleed(pre) {metrics.get('silenceBleedMs', '?')} ms"
    )
    return (
        f"<article class='cand-card ab-arm'><div class='clip-head'><div><div class='kicker'>Arm {letter}</div>"
        f"<h3>{html.escape(str(arm.get('label', '')))}</h3></div><div class='clip-stats'>{html.escape(stats)}</div></div>{player}</article>"
    )


def _ab_section(output_dir: Path) -> str:
    ab_dir = output_dir / "opening/ace-step-cover/ab"
    summary_path, manifest_path = ab_dir / "ab.json", ab_dir / "manifest.json"
    if not (summary_path.is_file() and manifest_path.is_file()):
        return ""
    summary, ab_manifest = _load(summary_path), _load(manifest_path)
    ab_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    reproduction = summary.get("round1TranscriptReproduction") or {}
    repro_text = (
        "Arm B reproduced the round-1 transcript exactly — same render."
        if reproduction.get("reproduced")
        else f"Arm B did NOT reproduce the round-1 transcript verbatim (similarity {reproduction.get('sequenceRatio')}) — treat it as a fresh draw under the round-1 config."
    )
    cards = _ab_arm_card("A", summary.get("armA") or {}, "armAOpening", ab_manifest, output_dir) + _ab_arm_card("B", summary.get("armB") or {}, "armBOpening", ab_manifest, output_dir)
    return f"""<article class='cand-card ab-block'>
<div class='section-heading'><div><div class='kicker'>A/B · which arm carries forward?</div><h3>{html.escape(str(summary.get('question', '')))}</h3></div></div>
<p class='clip-stats'>{html.escape(repro_text)}</p>
{cards}
<div class='cand-verdict ab-verdict' data-endpoint='/used2/asserted-proof/api/verdict/ace-cover-ab'>
  <div class='eyebrow'>Owner A/B verdict · metrics never imply approval</div>
  <div class='actions'><button data-w='A'>A wins</button><button data-w='B'>B wins</button><button data-w='neither'>Neither</button></div>
  <label><span class='eyebrow'>Notes</span><textarea class='notes' placeholder='What decided it?'></textarea></label>
  <p class='verdict-status' role='status' aria-live='polite'>No A/B verdict saved.</p>
  <div class='commit-actions'><button class='save'>Save A/B verdict</button></div>
</div>
<script>
(()=>{{
  const panel=document.querySelector('.ab-verdict'); if(!panel)return;
  const abManifestSha256='{ab_hash}'; const endpoint=panel.dataset.endpoint;
  let winner=''; const buttons=[...panel.querySelectorAll('[data-w]')];
  const status=panel.querySelector('.verdict-status'); const notes=panel.querySelector('.notes');
  const setStatus=(message,state='')=>{{status.textContent=message;status.className=`verdict-status ${{state}}`;}};
  buttons.forEach(button=>button.addEventListener('click',()=>{{winner=button.dataset.w;buttons.forEach(item=>item.classList.toggle('selected',item===button));setStatus('Winner selected. Save it to record the listen.');}}));
  fetch(endpoint,{{cache:'no-store'}}).then(response=>response.ok?response.json():null).then(payload=>{{if(payload&&payload.manifestSha256===abManifestSha256){{winner=payload.winner||'';notes.value=payload.notes||'';buttons.forEach(item=>item.classList.toggle('selected',item.dataset.w===winner));setStatus(`Saved: ${{payload.winner}} wins.`,'saved');}}}}).catch(()=>{{}});
  panel.querySelector('.save').addEventListener('click',async()=>{{
    if(!winner){{setStatus('Choose A, B, or neither first.','error');return;}}
    const payload={{clip:'ace-cover-ab',winner,notes:notes.value,createdAt:new Date().toISOString(),manifestSha256:abManifestSha256}};
    try{{const response=await fetch(endpoint,{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(payload)}});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not save verdict.');setStatus(`Saved: ${{winner}} wins.`,'saved');}}
    catch(error){{setStatus(error.message||'Could not save verdict.','error');}}
  }});
}})();
</script>
</article>"""


def _ace_cover_section(output_dir: Path) -> str:
    ace_dir = output_dir / "opening/ace-step-cover"
    ledger_path, manifest_path, request_path = ace_dir / "ledger.json", ace_dir / "manifest.json", ace_dir / "request.json"
    if not (ledger_path.is_file() and manifest_path.is_file() and request_path.is_file()):
        return ""
    ledger, manifest, request = _load(ledger_path), _load(manifest_path), _load(request_path)
    manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    lane_note = ""
    lane_status_path = ace_dir / "lane-status.json"
    if lane_status_path.is_file():
        lane = _load(lane_status_path)
        lane_note = f"<p class='lane-blocked'>Lane stopped: <strong>{html.escape(str(lane.get('status')))}</strong> — {html.escape(str(lane.get('rationale', '')))}</p>"
    menu_note = ""
    if (ace_dir / "melody-round.html").is_file():
        menu_note = "<p class='clip-stats'>Ear diagnostics: <a href='opening/ace-step-cover/melody-round.html'>melody-round listening menu</a> — probes rank by numbers, never verdictable.</p>"
    ranked = sorted((entry for entry in ledger.get("candidates", []) if entry.get("rank") in (1, 2, 3)), key=lambda entry: entry["rank"])
    total = len(ledger.get("candidates", []))
    raw_card = _audio_card("R", "Raw opening reference", "The owner take this cover must preserve — timing and register truth.", output_dir / "opening/raw.wav", "opening/raw.wav", "rawSlice", manifest, True)
    cards = []
    for candidate in ranked:
        seed = candidate.get("seed")
        wav = ace_dir / f"seed-{seed}-opening.wav"
        wav_current = _current(wav, f"seed{seed}Opening", manifest)
        player = (
            f"<audio controls preload='metadata' src='opening/ace-step-cover/seed-{seed}-opening.wav'></audio>"
            if wav_current
            else "<div class='quarantine'>Quarantined: an artifact hash does not match the current spike manifest.</div>"
        )
        evaluation_path = ace_dir / f"seed-{seed}-eval.json"
        chips = ""
        heard = ""
        if _current(evaluation_path, f"seed{seed}Eval", manifest):
            evaluation = _load(evaluation_path)
            chips = _ace_candidate_chips(evaluation)
        asr_path = ace_dir / f"seed-{seed}-asr.json"
        if _current(asr_path, f"seed{seed}Asr", manifest):
            asr = _load(asr_path)
            heard = " ".join(str(word.get("word", "")).strip() for word in asr.get("words", []))
        provenance = " · imported ad-hoc" if candidate.get("provenance") == "imported-ad-hoc" else ""
        verdict = candidate.get("verdict") or {}
        cards.append(
            f"""<article class='cand-card'>
        <div class='clip-head'><div><div class='kicker'>Rank {candidate['rank']} · {html.escape(str(candidate.get('status')))}{provenance}</div><h3>Seed {seed}</h3></div>
        <div class='clip-stats'>lexical {candidate['lexical'].get('hits', '?')}/16 hits · {candidate['lexical'].get('nearMisses', '?')} near · {candidate['lexical'].get('misses', '?')} miss</div></div>
        {player}
        <details><summary>Heard transcript</summary><p>{html.escape(heard) or 'pending'}</p><div class='chips'>{chips}</div></details>
        <section class='metrics lane-metrics' aria-label='Seed {seed} diagnostics'>{_ace_metric_cells(candidate)}</section>
        <div class='cand-verdict' data-seed='{seed}' data-endpoint='/used2/asserted-proof/api/verdict/ace-cover/{seed}'>
          <div class='eyebrow'>Owner verdict · metrics never imply approval</div>
          <div class='actions'><button data-v='pass'>Pass</button><button data-v='close but revise'>Close but revise</button><button data-v='fail'>Fail</button></div>
          <label><span class='eyebrow'>Failure class</span><select class='cls'><option value=''>Not classified</option><option>words</option><option>timing</option><option>pitch/register</option><option>voice/timbre</option></select></label>
          <label><span class='eyebrow'>Notes</span><textarea class='notes' placeholder='What did you hear?'>{html.escape(str(verdict.get('notes', '')))}</textarea></label>
          <p class='verdict-status' role='status' aria-live='polite'>No verdict saved for this candidate.</p>
          <div class='commit-actions'><button class='save'>Save verdict</button></div>
        </div>
      </article>"""
        )
    section = f"""<section class='ace-cover'>
<style>
.ace-cover{{margin-top:64px;padding-top:48px;border-top:1px solid var(--rule)}}
.chips{{margin-top:8px}} .chip{{display:inline-block;padding:2px 8px;margin:2px;border-radius:999px;font:600 11px 'IBM Plex Mono',Menlo,monospace}}
.chip.hit{{background:rgba(139,191,118,.15);color:var(--pass)}} .chip.near_miss{{background:rgba(242,169,59,.15);color:var(--accent)}} .chip.substitution,.chip.miss{{background:rgba(224,107,85,.15);color:var(--fail)}}
.cand-card{{margin-top:24px;padding:24px;background:var(--surface);border-radius:var(--r)}} .cand-card audio{{margin-top:12px}}
.cand-verdict{{margin-top:16px;padding:16px;background:var(--inset);border-radius:8px}}
.lane-blocked{{margin:16px 0;padding:12px 16px;border:1px solid var(--fail);border-radius:8px;color:var(--fail);font:600 12px 'IBM Plex Mono',Menlo,monospace}}
.metrics div.fail strong{{color:var(--fail)}}
</style>
<div class='section-heading'><div class='kicker'>Local model spike · ACE-Step 1.5 turbo cover</div><h2>Same take, asserted words.</h2><p>The raw take supplies structure, the sixteen asserted words supply lyrics. ASR and contour metrics rank candidates; only your ear passes one.</p></div>
{lane_note}
{menu_note}
<div class='rail'>{raw_card}</div>
<section class='assertion'><div class='kicker'>Asserted text · target lyrics</div><p>{html.escape(str(request.get('assertedText', '')))}</p></section>
{''.join(cards) if cards else "<p class='empty'>No current ranked candidates yet — run ace-cover-spike.</p>"}
{_ab_section(output_dir)}
<p class='clip-stats'>{len(ranked)} of {total} evaluated candidates shown; the full ranking lives in ledger.json.</p>
<script>
const aceManifestSha256='{manifest_hash}';
document.querySelectorAll('.cand-verdict').forEach(panel=>{{
  const endpoint=panel.dataset.endpoint; const seed=Number(panel.dataset.seed);
  let verdict=''; const buttons=[...panel.querySelectorAll('[data-v]')];
  const status=panel.querySelector('.verdict-status'); const cls=panel.querySelector('.cls'); const notes=panel.querySelector('.notes');
  const setStatus=(message,state='')=>{{status.textContent=message;status.className=`verdict-status ${{state}}`;}};
  buttons.forEach(button=>button.addEventListener('click',()=>{{verdict=button.dataset.v;buttons.forEach(item=>item.classList.toggle('selected',item===button));setStatus('Verdict selected. Save it to record the listen.');}}));
  fetch(endpoint,{{cache:'no-store'}}).then(response=>response.ok?response.json():null).then(payload=>{{if(payload&&payload.manifestSha256===aceManifestSha256){{verdict=payload.verdict||'';cls.value=payload.classification||'';notes.value=payload.notes||'';buttons.forEach(item=>item.classList.toggle('selected',item.dataset.v===verdict));setStatus(`Saved ${{payload.verdict}} for this candidate.`,'saved');}}}}).catch(()=>{{}});
  panel.querySelector('.save').addEventListener('click',async()=>{{
    if(!verdict){{setStatus('Choose pass, close but revise, or fail first.','error');return;}}
    const payload={{clip:'ace-cover',seed,verdict,classification:cls.value,notes:notes.value,createdAt:new Date().toISOString(),manifestSha256:aceManifestSha256}};
    try{{const response=await fetch(endpoint,{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(payload)}});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not save verdict.');setStatus(`Saved ${{verdict}} for this candidate.`,'saved');}}
    catch(error){{setStatus(error.message||'Could not save verdict.','error');}}
  }});
}});
</script>
</section>"""
    return section


def build_page(output_dir: Path) -> Path:
    opening = output_dir / "opening"
    plan = _load(opening / "asserted-render-plan.json")
    manifest = _load(opening / "manifest.json")
    inputs_current = _all_inputs_current(manifest, output_dir.parent)
    voicebox_metrics_path = opening / "metrics-voicebox-lexical-guide.json"
    voicebox_metrics = _load(voicebox_metrics_path) if inputs_current and _current(voicebox_metrics_path, "voiceboxLexicalGuideMetrics", manifest) else {}
    words = plan.get("words", [])
    text = " ".join(str(word["text"]) for word in words)
    mapping_rows = []
    for word in words:
        syllables = word.get("syllables", [])
        mapping_rows.append(
            "<tr>"
            f"<th>{html.escape(str(word['text']))}</th>"
            f"<td>{float(word['start']):.3f}-{float(word['end']):.3f}s</td>"
            f"<td>{html.escape(' | '.join('-'.join(syl['phones']) for syl in syllables))}</td>"
            f"<td>{html.escape(' / '.join(str(syl['midiPitch']) for syl in syllables))}</td>"
            f"<td>{html.escape(' / '.join(str(syl['pitchProvenance']) for syl in syllables))}</td>"
            "</tr>"
        )
    voicebox_metric_items = [("Clone envelope corr", voicebox_metrics.get("envelopeCorrelation", "pending")), ("Clone attack median", f"{voicebox_metrics.get('medianAttackErrorMs', 'pending')} ms"), ("Clone pitch median", f"{voicebox_metrics.get('medianVoicedPitchErrorSemitones', 'pending')} st")]
    voicebox_metrics_html = "".join(f"<div><span>{html.escape(label)}</span><strong>{html.escape(str(value))}</strong></div>" for label, value in voicebox_metric_items)
    cards = [
        _audio_card("01", "Raw opening reference", "Owner take, sliced from 0.35 to 7.90 seconds. This is the timing and register truth.", opening / "raw.wav", "opening/raw.wav", "rawSlice", manifest, inputs_current),
        _audio_card("02", "Deterministic lexical control", "Neutral Alex speech says all 16 asserted words exactly, then follows the measured word slots and pitch. This proves the lexical mapping before cloning.", opening / "lexical-guide.wav", "opening/lexical-guide.wav", "lexicalGuide", manifest, inputs_current),
        _audio_card("03", "Cloned deterministic guide (review this)", "Short Voicebox-cloned phrases pass an exact lexical gate, discard enrollment echo, then transfer word by word onto the same measured timing and pitch.", opening / "voicebox-lexical-guide.wav", "opening/voicebox-lexical-guide.wav", "voiceboxLexicalGuide", manifest, inputs_current),
        _audio_card("04", "Prior SoulX score-mode guide", "Historical diagnostic only. This lane caused the blurred article and broader lexical artifacts, so it is not the current candidate.", opening / "guide.wav", "opening/guide.wav", "guide", manifest, inputs_current),
        _audio_card("05", "Prior localized SoulX repair", "Historical diagnostic that changed only the in-the-night phrase. It remains available for comparison, not acceptance.", opening / "guide-word-repair-local.wav", "opening/guide-word-repair-local.wav", "localRepairGuide", manifest, inputs_current),
    ]
    expansions = _expansion_sections(output_dir) if _owner_passes_current_manifest(opening) else ""
    ace_cover = _ace_cover_section(output_dir)
    page = f"""<!doctype html>
<html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>
<title>Used2 asserted re-sing proof</title><meta name='description' content='Provenance-safe opening re-sing proof for Used2.'><link rel='icon' href='data:,'>
<style>
:root{{--canvas:#11110f;--surface:#1b1a17;--inset:#151411;--text:#f4f0e8;--muted:#aaa399;--rule:#36322c;--accent:#f2a93b;--pass:#8bbf76;--fail:#e06b55;--r:12px}}
*{{box-sizing:border-box}} body{{margin:0;background:radial-gradient(circle at 82% 0,#282016 0,transparent 34rem),var(--canvas);color:var(--text);font-family:'Avenir Next','Helvetica Neue',sans-serif;line-height:1.5}} main{{max-width:1180px;margin:auto;padding:48px 24px 72px}}
header{{display:grid;grid-template-columns:1.4fr .6fr;gap:32px;align-items:end;padding-bottom:32px;border-bottom:1px solid var(--rule)}} .kicker,.eyebrow{{font:600 11px/1.2 'IBM Plex Mono',Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}} h1{{font-size:clamp(40px,7vw,84px);line-height:.92;letter-spacing:-.055em;margin:12px 0 0;max-width:820px}} header p{{color:var(--muted);margin:0;max-width:38ch}} .status{{display:inline-flex;margin-top:16px;border:1px solid var(--accent);border-radius:999px;padding:6px 10px;color:var(--accent);font:600 12px/1 'IBM Plex Mono',Menlo,monospace}}
.assertion{{margin:32px 0;padding:24px;border-left:4px solid var(--accent);background:linear-gradient(90deg,rgba(242,169,59,.1),transparent)}} .assertion p{{font-size:22px;letter-spacing:-.02em;margin:8px 0 0}}
.repair-note{{margin:0 0 32px;padding:20px 24px;border:1px solid var(--accent);border-radius:var(--r);background:var(--inset)}} .repair-note p{{margin:8px 0 0;color:var(--muted)}} .repair-note strong{{color:var(--text)}}
.rail{{border-top:1px solid var(--rule)}} .evidence{{display:grid;grid-template-columns:72px 1fr;gap:24px;padding:28px 0;border-bottom:1px solid var(--rule);animation:reveal .5s ease both}} .evidence:nth-child(2){{animation-delay:.06s}} .evidence:nth-child(3){{animation-delay:.12s}} .evidence:nth-child(4){{animation-delay:.18s}} .stage{{font:500 14px 'IBM Plex Mono',Menlo,monospace;color:var(--muted)}} .evidence h2{{font-size:25px;margin:4px 0 4px;letter-spacing:-.025em}} .evidence p{{color:var(--muted);margin:0 0 16px}} audio{{width:100%;height:44px}} .empty,.quarantine{{padding:14px 16px;border:1px dashed var(--rule);border-radius:8px;color:var(--muted);font:13px 'IBM Plex Mono',Menlo,monospace}} .quarantine{{border-color:var(--fail);color:var(--fail)}}
.metrics{{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--rule);margin:32px 0}} .metrics div{{background:var(--inset);padding:16px}} .metrics span,.metrics strong{{display:block;font-family:'IBM Plex Mono',Menlo,monospace}} .metrics span{{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}} .metrics strong{{font-size:18px;margin-top:6px}}
.mapping{{overflow:auto;margin-top:32px}} table{{width:100%;border-collapse:collapse;font:12px 'IBM Plex Mono',Menlo,monospace}} caption{{text-align:left;font:600 11px 'IBM Plex Mono',Menlo,monospace;color:var(--accent);letter-spacing:.14em;text-transform:uppercase;margin-bottom:12px}} th,td{{padding:12px;border-bottom:1px solid var(--rule);text-align:left;white-space:nowrap}} th{{color:var(--text)}} td{{color:var(--muted)}}
.expansions{{margin-top:64px;padding-top:48px;border-top:1px solid var(--rule)}} .section-heading{{display:grid;grid-template-columns:1fr 1fr;align-items:end;gap:24px;margin-bottom:24px}} .section-heading h2{{font-size:clamp(36px,6vw,64px);line-height:1;margin:8px 0 0;letter-spacing:-.045em}} .section-heading p{{color:var(--muted);margin:0}} .expansion-card{{margin-top:24px;padding:24px;background:var(--surface);border-radius:var(--r)}} .clip-head{{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:end}} .clip-head h3{{font-size:28px;margin:6px 0 0}} .clip-stats{{text-align:right;color:var(--muted);font:12px/1.7 'IBM Plex Mono',Menlo,monospace}} details{{margin:20px 0;border-block:1px solid var(--rule);padding:12px 0}} summary{{cursor:pointer;color:var(--accent);font:600 12px 'IBM Plex Mono',Menlo,monospace;text-transform:uppercase;letter-spacing:.08em}} details p{{color:var(--muted)}} .expansion-card .rail{{border-top:0}} .expansion-card .evidence{{grid-template-columns:44px 1fr;padding:20px 0}}
.verdict{{margin-top:40px;padding:24px;background:var(--surface);border-radius:var(--r)}} .verdict h2{{margin:0 0 16px}} .actions,.commit-actions{{display:flex;flex-wrap:wrap;gap:8px}} button,select,textarea{{font:600 14px 'Avenir Next',sans-serif;border-radius:8px;border:1px solid var(--rule);background:var(--inset);color:var(--text)}} button{{min-height:44px;padding:0 16px;cursor:pointer}} button:hover,button:focus-visible{{border-color:var(--accent);outline:2px solid transparent}} button:disabled{{cursor:wait;opacity:.55}} button.selected{{background:var(--accent);color:var(--canvas);border-color:var(--accent)}} select{{height:44px;padding:0 12px;margin:16px 0;width:100%}} textarea{{width:100%;min-height:96px;padding:12px;resize:vertical}} .save{{background:var(--text);color:var(--canvas)}} .verdict-status{{min-height:24px;margin:12px 0 8px;color:var(--muted);font:12px 'IBM Plex Mono',Menlo,monospace}} .verdict-status.saved{{color:var(--pass)}} .verdict-status.error{{color:var(--fail)}}
@keyframes reveal{{from{{opacity:0;transform:translateY(8px)}}to{{opacity:1;transform:none}}}} @media(max-width:700px){{main{{padding:28px 16px 48px}}header,.section-heading,.clip-head{{grid-template-columns:1fr}}.clip-stats{{text-align:left}}.evidence{{grid-template-columns:44px 1fr;gap:12px}}.metrics{{grid-template-columns:1fr 1fr}}.lane-metrics{{grid-template-columns:1fr}}}} @media(prefers-reduced-motion:reduce){{.evidence{{animation:none}}}}
</style></head><body><main>
<header><div><div class='kicker'>Used2 / asserted proof / opening</div><h1>Words first. Then voice.</h1><span class='status'>needs owner ear</span></div><p>This page isolates whether corrected words can survive exact timing and measured register before any second-half invention resumes.</p></header>
<section class='assertion'><div class='kicker'>Asserted text · {len(words)} words</div><p>{html.escape(text)}</p></section>
<section class='rail'>{''.join(cards)}</section>
	<section class='metrics lane-metrics' aria-label='Voicebox cloned lexical diagnostics'>{voicebox_metrics_html}</section>
<section class='mapping'><table><caption>Word to syllable mapping</caption><thead><tr><th>Word</th><th>Absolute span</th><th>Phones</th><th>MIDI</th><th>Pitch source</th></tr></thead><tbody>{''.join(mapping_rows)}</tbody></table></section>
{ace_cover}{expansions}
<section class='verdict'><h2>Owner-ear gate</h2><div class='actions'><button data-verdict='pass'>Pass</button><button data-verdict='close but revise'>Close but revise</button><button data-verdict='fail'>Fail</button></div><label><span class='eyebrow'>Failure class</span><select id='classification'><option value=''>Not classified</option><option>words</option><option>timing</option><option>pitch/register</option><option>voice/timbre</option></select></label><label><span class='eyebrow'>Notes</span><textarea id='notes' placeholder='What changed when you heard it?'></textarea></label><p class='verdict-status' id='verdict-status' role='status' aria-live='polite'>No verdict saved for this render.</p><div class='commit-actions'><button class='save' id='save'>Save verdict</button><button id='download'>Download JSON</button></div></section>
</main><script>
const manifestSha256='{hashlib.sha256((opening / 'manifest.json').read_bytes()).hexdigest()}';
let verdict=''; const buttons=[...document.querySelectorAll('[data-verdict]')]; const classification=document.querySelector('#classification'); const notes=document.querySelector('#notes'); const status=document.querySelector('#verdict-status'); const save=document.querySelector('#save');
const setStatus=(message,state='')=>{{status.textContent=message;status.className=`verdict-status ${{state}}`;}};
const applyPayload=payload=>{{verdict=payload.verdict||'';classification.value=payload.classification||'';notes.value=payload.notes||'';buttons.forEach(item=>item.classList.toggle('selected',item.dataset.verdict===verdict));}};
const makePayload=()=>({{clip:'opening',verdict,classification:classification.value,notes:notes.value,createdAt:new Date().toISOString(),manifestSha256}});
buttons.forEach(button=>button.addEventListener('click',()=>{{verdict=button.dataset.verdict;buttons.forEach(item=>item.classList.toggle('selected',item===button));setStatus('Verdict selected. Save it to advance the listening gate.');}}));
fetch('/used2/asserted-proof/api/verdict/opening',{{cache:'no-store'}}).then(response=>response.ok?response.json():null).then(payload=>{{if(payload&&payload.manifestSha256===manifestSha256){{applyPayload(payload);setStatus(`Saved ${{payload.verdict}} for this render.`,'saved');}}}}).catch(()=>{{}});
save.addEventListener('click',async()=>{{if(!verdict){{setStatus('Choose pass, close but revise, or fail first.','error');return;}}save.disabled=true;setStatus('Saving verdict...');try{{const payload=makePayload();const response=await fetch('/used2/asserted-proof/api/verdict/opening',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(payload)}});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not save verdict.');localStorage.setItem('used2-opening-verdict',JSON.stringify(payload));setStatus(`Saved ${{payload.verdict}} for this render.`,'saved');}}catch(error){{setStatus(error.message||'Could not save verdict.','error');}}finally{{save.disabled=false;}}}});
document.querySelector('#download').addEventListener('click',()=>{{if(!verdict){{setStatus('Choose pass, close but revise, or fail first.','error');return;}}const payload=makePayload();const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{{type:'application/json'}}));link.download='used2-opening-verdict.json';link.click();URL.revokeObjectURL(link.href);}});
</script></body></html>"""
    page_path = output_dir / "index.html"
    page_path.write_text(page, encoding="utf-8")
    return page_path
