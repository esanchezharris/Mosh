"""LoRA Lab end-to-end: a REAL fine-tune, published as takes, auditioned.

This is the check `--selftest` structurally cannot make. The harness can prove
`submit_training_job` returned a jobId — which is exactly the `freeze_layer`
trap CLAUDE.md documents, a green check on a command that did nothing. What
matters is the chain AFTER the jobId:

    real clips -> precompute (live SA3 engine) -> pmetal -> .safetensors
      -> published into sa3/lab/ -> visible to the registry
      -> render_lora_take resolves it -> audio that DIFFERS from the base

Every link is verified against artifacts on disk, and the last one is verified
by comparing samples, because an all-zeros adapter — the shape a
plausible-but-broken trainer produces — merges cleanly, renders cleanly, and
sounds exactly like the base model.

## What this deliberately does NOT test

Adapter QUALITY. That is settled: the 2026-08 round put a local adapter at
0.8835 taste_sim against a cloud reference's 0.8896, and the owner picked the
local one by ear. Re-litigating it here would cost an hour to re-derive a
known answer. The step count below is therefore far under the measured recipe
(44 epochs for this corpus) — it exists to produce SEVERAL checkpoints quickly,
not a good adapter.

## Running it

Needs a live SA3 service. Start one that OUTLIVES the app processes, because a
run-script invocation exits while the training job continues inside the service:

    MOSH_ENABLE_SA3=1 MOSH_SERVICE_PORT=8791 service/run.sh &
    MOSH_SERVICE_PORT=8791 python3 scripts/verify-hardware/lab_train_check.py \\
        --binary build/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh

Run it from the REPO ROOT: GenerativeJobManager resolves service/server.py
CWD-relative, and running from this directory fails every service-dependent
check with "generative service unavailable".
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

DEFAULT_CORPUS = Path.home() / "mosh-loras" / "datasets" / "ken-sa3"
SESSION = "verify-lab-train"

# Small on purpose (see the module docstring): enough checkpoints to populate a
# take sheet, nowhere near the measured 44-epoch recipe for this corpus.
CLIPS = 48
STEPS = 300
PROMPT = "kxc, rage trap instrumental, heavy distorted 808 bass, 152 bpm"


def port() -> int:
    return int(os.environ.get("MOSH_SERVICE_PORT", "8770"))


def svc(path: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port()}{path}", timeout=timeout) as r:
        return json.loads(r.read().decode())


def mosh_base() -> Path:
    return Path.home() / "Library" / "Mosh"


def run_script(binary: Path, commands: list[dict], art: Path,
               tag: str, timeout: int = 900) -> tuple[list[dict], subprocess.CompletedProcess]:
    """Drive REAL MoshOps commands through --run-script. Same mechanism verify.py
    uses; kept local so this file can run standalone."""
    spath = art / f"{tag}.script.jsonl"
    opath = art / f"{tag}.results.jsonl"
    spath.write_text("\n".join(json.dumps(c) for c in commands) + "\n")
    if opath.exists():
        opath.unlink()
    env = dict(os.environ)
    env.update({
        "MOSH_RUN_SCRIPT": str(spath),
        "MOSH_RUN_SCRIPT_OUT": str(opath),
        # RELATIVE `_harness/<leaf>`, never an absolute path. The value is resolved
        # under the Mosh data dir, so an absolute path is not a location — it is a
        # nonsense leaf, which is rejected and silently redirected to a unique
        # SAFETY session. Nothing errors; you just get a fresh empty registry every
        # invocation and "source not found" for sources you watched import.
        #
        # ONE leaf for every invocation in this check —
        # NOT one per tag. The rights registry lives in the session dir, so a
        # per-tag leaf puts the imports in one registry and the approvals in
        # another, and `build_training_corpus` then fails with "source not
        # found" for sources you just watched succeed. (CLAUDE.md's "two runs
        # must use distinct leaves" is about CONCURRENT runs; the sequential
        # phases of one check are one run.) JUCE ignores $HOME, so a
        # marker-owned leaf is the only real isolation available.
        "MOSH_SELFTEST_SESSION": f"_harness/{SESSION}",
        "MOSH_ENABLE_SA3": "1",
    })
    proc = subprocess.run([str(binary), "--run-script"], env=env,
                          capture_output=True, text=True, timeout=timeout)
    results = []
    if opath.exists():
        for line in opath.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    results.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return results, proc


def by_command(results: list[dict]) -> dict:
    out: dict = {}
    for r in results:
        out.setdefault(r.get("command", "?"), []).append(r)
    return out


def read_wav_mono(path: Path, limit: int = 44100 * 8) -> list[float]:
    """First `limit` frames, mono-summed, normalised to [-1,1]."""
    with wave.open(str(path), "rb") as w:
        n = min(w.getnframes(), limit)
        raw = w.readframes(n)
        ch, sw = w.getnchannels(), w.getsampwidth()
    if sw != 2:
        return []
    vals = struct.unpack(f"<{len(raw)//2}h", raw)
    if ch == 2:
        return [(vals[i] + vals[i + 1]) / 2.0 / 32768.0 for i in range(0, len(vals) - 1, 2)]
    return [v / 32768.0 for v in vals]


def rms(xs: list[float]) -> float:
    return math.sqrt(sum(x * x for x in xs) / len(xs)) if xs else 0.0


def diff_rms(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(n)) / n)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    ap.add_argument("--clips", type=int, default=CLIPS)
    ap.add_argument("--steps", type=int, default=STEPS)
    ap.add_argument("--art", default="/tmp/lab-train-check")
    args = ap.parse_args()

    binary = Path(args.binary)
    art = Path(args.art)
    art.mkdir(parents=True, exist_ok=True)
    corpus = Path(os.path.expanduser(args.corpus))

    checks: list[tuple[bool, str]] = []

    def check(cond: bool, msg: str) -> bool:
        checks.append((bool(cond), msg))
        print(f"  {'ok  ' if cond else 'FAIL'} {msg}", flush=True)
        return bool(cond)

    print(f"LoRA Lab end-to-end  (corpus={corpus.name}, clips={args.clips}, steps={args.steps})")
    print("=" * 72)

    if not binary.is_file():
        print(f"FAIL binary not found: {binary}")
        return 1
    wavs = sorted(glob.glob(str(corpus / "*.wav")))[: args.clips]
    if not wavs:
        print(f"FAIL no wavs in {corpus}")
        return 1

    # ── 0) the service is real, and the trainer is NOT the stub ──────────────
    print("\n[0] service + trainer capability")
    cap = svc("/capabilities")
    tr = (cap.get("training") or [{}])[0]
    check(tr.get("backend") == "local_pmetal", f"backend is local_pmetal (got {tr.get('backend')})")
    # The one Stage-1 assertion that matters: a stub would say json_stub here,
    # and everything downstream would still "work" while producing nothing.
    check(tr.get("output_formats") == ["safetensors"],
          f"output_formats is safetensors, not json_stub (got {tr.get('output_formats')})")
    check(not tr.get("blockers"), f"no blockers (got {tr.get('blockers')})")
    check("stable_audio3" in (svc("/health").get("adapters") or []),
          "the REAL SA3 adapter is loaded (not the FakeAdapter downgrade)")

    # ── 1) register the corpus + submit, through real MoshOps commands ───────
    print(f"\n[1] registering {len(wavs)} sources + submitting (real commands)")
    cmds: list[dict] = []
    for w in wavs:
        cap_txt = ""
        txt = Path(w).with_suffix(".txt")
        if txt.is_file():
            cap_txt = txt.read_text(encoding="utf-8", errors="ignore").strip().splitlines()[0][:300]
        cmds.append({"command": "import_training_source", "args": {
            # The caption is the prompt the adapter learns to answer.
            # _clips_from_bundle falls back title -> caption, so it rides here.
            "title": cap_txt or PROMPT,
            "creator": "Emilio Sanchez-Harris",
            "localPath": w,
            "userClaimedLicense": "owner-created; local verification run",
            "proofOfRights": "self-authored corpus (lab_train_check)",
        }})
    # ONE invocation for register + approve + build. A --run-script process WIPES
    # its session dir at startup (harness modes do; only the interactive GUI keeps
    # the owner's session), so NOTHING in the session survives to the next
    # invocation — the rights registry included. Splitting these across two
    # invocations gives "source not found" for sources you just watched import,
    # which reads as a broken command rather than a vanished registry.
    #
    # The approvals therefore cannot be driven off a listing from a PREVIOUS run;
    # the ids are deterministic (beat-001…) so they are derived here instead.
    ids = [f"beat-{i+1:03d}" for i in range(len(wavs))]
    cmds += [{"command": "approve_training_source", "args": {"sourceId": i, "approved": True}} for i in ids]
    cmds.append({"command": "list_training_sources", "args": {}})
    cmds.append({"command": "build_training_corpus", "args": {}})
    t0 = time.time()
    results, proc = run_script(binary, cmds, art, "register", timeout=900)
    reg = by_command(results)
    imported = [r for r in reg.get("import_training_source", []) if r.get("ok")]
    check(len(imported) == len(wavs),
          f"all {len(wavs)} sources imported ({len(imported)} ok) in {time.time()-t0:.0f}s")
    approved = [r for r in reg.get("approve_training_source", []) if r.get("ok")]
    check(len(approved) == len(wavs), f"all {len(wavs)} sources approved ({len(approved)} ok)")

    srcs = (reg.get("list_training_sources", [{}])[0].get("data") or {}).get("sources") or []
    eligible = [s for s in srcs if s.get("eligible")]
    check(len(eligible) == len(wavs),
          f"{len(eligible)}/{len(wavs)} sources eligible for training")

    built = reg.get("build_training_corpus", [{}])[0]
    bundle = (built.get("data") or {}).get("bundlePath", "")
    check(built.get("ok") and bundle, f"corpus bundle built: {bundle}")
    if not bundle:
        return report(checks)

    # Copy the bundle OUT of the session before any further invocation. The bundle
    # lives under the session dir, the service reads its clips throughout
    # precompute, and the next run-script's startup wipe would delete it out from
    # under a training run that is already going — a mid-run failure whose cause
    # is three steps away from its symptom.
    stable = art / "corpus-bundle"
    if stable.exists():
        shutil.rmtree(stable)
    shutil.copytree(bundle, stable)
    out_dir = art / "training-output"
    out_dir.mkdir(parents=True, exist_ok=True)
    check(any(stable.rglob("*.wav")), f"bundle copied out of the session: {stable}")

    results, proc = run_script(binary, [{"command": "submit_training_job", "args": {
        "corpusBundle": str(stable),
        # Explicit, and OUTSIDE the session, for the same reason.
        "outputDir": str(out_dir),
        "config": {"rank": 16, "steps": args.steps, "lr": 0.0001,
                   "checkpoint_every": max(1, args.steps // 6), "label": "labcheck"},
    }}], art, "submit", timeout=300)
    sub = by_command(results).get("submit_training_job", [{}])[0]
    job_id = (sub.get("data") or {}).get("jobId", "")
    check(sub.get("ok") and job_id, f"training job submitted: {job_id}")
    if not job_id:
        return report(checks)

    # ── 2) wait, polling the SERVICE (the app process has exited) ────────────
    print(f"\n[2] training (steps={args.steps}) — polling /training/status")
    t0, last = time.time(), ""
    status, st = "", {}
    lab_dir = Path.home() / "Library" / "Mosh" / "loras" / "sa3" / "lab"
    while time.time() - t0 < 5400:
        try:
            st = svc(f"/training/status?jobId={job_id}", timeout=15)
        except Exception as e:  # noqa: BLE001
            print(f"    (status unreachable: {e})", flush=True)
            time.sleep(10)
            continue
        status = st.get("status", "")
        # `progress` is a plain 0..1 FLOAT here, not the richer progress dict the
        # trainer writes to <run>/progress.json. Takes are counted off disk
        # instead, which also proves publishing is happening DURING the run
        # rather than only at the end.
        pct = st.get("progress")
        pct = f"{float(pct)*100:5.1f}%" if isinstance(pct, (int, float)) else "  ?  "
        live = len(list(lab_dir.glob("labcheck@*.safetensors"))) if lab_dir.is_dir() else 0
        line = f"    {status:10s} {pct}   takes on disk: {live}   {(time.time()-t0)/60:5.1f} min"
        if line != last:
            print(line, flush=True)
            last = line
        if status in ("ready", "error", "cancelled"):
            break
        time.sleep(15)
    mins = (time.time() - t0) / 60
    check(status == "ready", f"training finished (status={status}) in {mins:.1f} min")
    if status != "ready":
        print(f"    error: {st.get('error')}")
        return report(checks)

    # ── 3) the artifact is a real adapter, and takes were published ──────────
    print("\n[3] artifact + published takes")
    res = st.get("result") or {}
    check(res.get("output_format") == "safetensors",
          f"result output_format == safetensors (got {res.get('output_format')})")
    art_path = Path(res.get("artifact_path", ""))
    check(art_path.is_file() and art_path.stat().st_size > 1_000_000,
          f"adapter on disk, non-trivial: {art_path} "
          f"({art_path.stat().st_size/1e6:.1f}MB)" if art_path.is_file() else f"adapter missing: {art_path}")

    takes = res.get("takes") or []
    check(len(takes) >= 2, f"{len(takes)} takes published into sa3/lab/")

    # The registry must SEE them — a link it cannot see is a take that cannot be
    # auditioned, and that is the failure that would leave the sheet empty.
    sys.path.insert(0, str(HERE.parent.parent / "service"))
    from loras import registry as REG  # noqa: E402
    rows = {r["name"]: r for r in REG.list_loras()}
    lab_rows = [r for r in rows.values() if r.get("family") == "lab" and r.get("valid")]
    check(len(lab_rows) >= 2, f"registry lists {len(lab_rows)} valid lab takes")
    for t in takes[:3]:
        nm = t["name"]
        check(nm in rows and rows[nm].get("valid"),
              f"take {nm} resolves and is valid (rank {rows.get(nm, {}).get('rank')})")

    final = next((t["name"] for t in takes if t.get("isFinal")), takes[-1]["name"] if takes else "")
    check(bool(final), f"a final take exists: {final}")

    # ── 4) the take AUDITIONS, and it moves the sound ────────────────────────
    # The one that catches an all-zeros adapter: it merges, renders, and sounds
    # identical to the base. Only comparing samples finds it.
    print(f"\n[4] auditioning base vs {final} through render_lora_take")
    results, proc = run_script(binary, [
        {"command": "render_lora_take", "args": {"prompt": PROMPT, "seed": 11, "seconds": 8, "adapters": []}},
        {"command": "render_lora_take", "args": {"prompt": PROMPT, "seed": 11, "seconds": 8,
                                                 "adapters": [{"name": final, "value": 100}]}},
    ], art, "audition", timeout=600)
    takes_res = by_command(results).get("render_lora_take", [])
    check(len(takes_res) == 2 and all(r.get("ok") for r in takes_res),
          f"both renders accepted ({[r.get('ok') for r in takes_res]})")
    if len(takes_res) != 2:
        return report(checks)

    wav_base = Path((takes_res[0].get("data") or {}).get("outputWav", ""))
    wav_lora = Path((takes_res[1].get("data") or {}).get("outputWav", ""))
    check(wav_base != wav_lora,
          "the two takes have DIFFERENT ids — the adapter is part of the cache key")

    # The app exited while the renders were still queued; the service finishes
    # them and writes the files, so wait on the artifacts, not the process.
    for p in (wav_base, wav_lora):
        t0 = time.time()
        while time.time() - t0 < 600 and not (p.is_file() and p.with_name("output_manifest.json").is_file()):
            time.sleep(3)
    check(wav_base.is_file(), f"base take rendered: {wav_base}")
    check(wav_lora.is_file(), f"adapter take rendered: {wav_lora}")
    if not (wav_base.is_file() and wav_lora.is_file()):
        return report(checks)

    a, b = read_wav_mono(wav_base), read_wav_mono(wav_lora)
    check(rms(a) > 0.001 and rms(b) > 0.001,
          f"both takes carry audio (rms {rms(a):.4f} / {rms(b):.4f}) — neither is silence")
    d = diff_rms(a, b)
    # Same seed, same prompt, same everything except the weights. A meaningful
    # delta here is the adapter doing work; near-zero is the all-zeros shape.
    check(d > 0.01, f"the adapter MOVES the sound: diff-RMS {d:.4f} vs base rms {rms(a):.4f}")

    # ── 5) KEEP: promote a take, and prove it outlives its run ──────────────
    # The one durable action in the Lab, and the one whose failure mode is
    # delayed: a kept adapter that was merely another link into the run dir
    # still promotes cleanly, still renders, and evaporates later when the
    # producer deletes the experiment. So this checks the bytes, not the call.
    print(f"\n[5] keeping {final} into the library")
    kept_name = "labcheck-kept"
    lib = Path(REG.lora_dir())
    for stale in lib.glob(f"{kept_name}.*"):
        stale.unlink()

    results, proc = run_script(binary, [
        {"command": "promote_lora_checkpoint", "args": {"source": final, "name": kept_name}},
        # Refusals are part of the contract: keeping onto a name already in use
        # must fail rather than silently replace a decision the producer made.
        {"command": "promote_lora_checkpoint", "args": {"source": final, "name": kept_name}},
        {"command": "promote_lora_checkpoint", "args": {"source": "no-such-take@1", "name": "nope"}},
    ], art, "keep", timeout=300)
    kept = by_command(results).get("promote_lora_checkpoint", [])
    check(len(kept) == 3 and kept[0].get("ok"), f"promote succeeded ({[k.get('ok') for k in kept]})")
    check(not kept[1].get("ok") and "already exists" in (kept[1].get("error") or ""),
          f"a second promote onto the same name is REFUSED: {kept[1].get('error')!r}")
    check(not kept[2].get("ok"), "promoting an unknown take is refused")

    kept_file = lib / f"{kept_name}.safetensors"
    check(kept_file.is_file(), f"kept adapter on disk: {kept_file}")
    # Phrased as the POSITIVE assertion on purpose: this helper prints every
    # message with an ok/FAIL prefix, so "kept adapter is a SYMLINK" printed
    # beside "ok" reads as though the bug shipped. State what is true when the
    # check passes; the failure is legible from the FAIL prefix.
    check(not kept_file.is_symlink(),
          "kept adapter is a real COPY, not a symlink (a link would evaporate with the run)")
    check(kept_file.stat().st_size > 1_000_000,
          f"kept adapter is real ({kept_file.stat().st_size/1e6:.1f}MB)")

    rows = {r["name"]: r for r in REG.list_loras()}
    check(rows.get(kept_name, {}).get("family") == "library",
          "kept adapter joins the LIBRARY family (so it shows in the rack, not the sheet)")
    check(rows.get(kept_name, {}).get("valid"), "kept adapter is valid to the registry")

    # Drop the run's lab links...
    sys.path.insert(0, str(HERE.parent.parent / "service" / "training"))
    import lab_publish as LP  # noqa: E402
    dropped = LP.forget("labcheck")
    check(dropped > 0, f"forget() removed {dropped} lab links")
    rows = {r["name"]: r for r in REG.list_loras()}
    check(final not in rows, "the take is gone after forget()")

    # ...and then DELETE THE RUN ITSELF. forget() only unlinks files under
    # sa3/lab/, so a kept adapter that was secretly a symlink into the run dir
    # would survive it perfectly well — meaning a check that stopped here would
    # pass with the exact bug this module exists to prevent still in place. The
    # run directory is what has to disappear for the claim to mean anything.
    run_root = Path(res.get("artifact_path", "")).parent.parent
    if run_root.is_dir() and str(run_root).startswith(str(art)):
        shutil.rmtree(run_root, ignore_errors=True)
    check(not run_root.is_dir(), f"the run directory is gone: {run_root}")

    rows = {r["name"]: r for r in REG.list_loras()}
    kept_row = rows.get(kept_name, {})
    check(kept_row.get("valid"),
          "THE KEPT ADAPTER SURVIVED its entire run directory being deleted")
    check(kept_row.get("tensors", 0) > 100 and kept_row.get("rank") == 16,
          f"...and is still fully readable (rank {kept_row.get('rank')}, "
          f"{kept_row.get('tensors')} tensors) — not just a surviving filename")

    print(f"\n    listen:  open {wav_base.parent.parent}")
    return report(checks)


def report(checks: list[tuple[bool, str]]) -> int:
    ok = sum(1 for c, _ in checks if c)
    print("\n" + "=" * 72)
    print(f"===== {ok}/{len(checks)} checks passed, {len(checks)-ok} failed =====")
    for c, m in checks:
        if not c:
            print(f"  FAILED: {m}")
    return 0 if ok == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
