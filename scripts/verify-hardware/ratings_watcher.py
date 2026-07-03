#!/usr/bin/env python3
"""Ratings watcher — "build the next pack right after my audition" (owner ask).

Fired by launchd on ~/Downloads changes (WatchPaths). Sees a freshly exported
TASTE-PACK-RATINGS-pack-NNN*.csv → copies it beside its pack → merges labels →
builds the NEXT planned pack of the active era, so a fresh pack is always
waiting at :8188. Fail-closed everywhere: any gate/build failure ships NOTHING;
no active era / era complete are clean no-ops. Downloads is never mutated
(processed files are remembered by content sha in watcher.state.json).

The installed copy lives OUTSIDE any repo (~/mosh-beats/eras/) and drives the
ACTIVE ERA's frozen worktree tools — so what runs is exactly what was frozen.

    python3 ratings_watcher.py            # one pass (what launchd runs)
    python3 ratings_watcher.py --install  # copy self + load the launchd agent
    python3 ratings_watcher.py --uninstall
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

BEATS = Path(os.path.expanduser("~/mosh-beats"))
ERAS = BEATS / "eras"
DOWNLOADS = Path(os.path.expanduser("~/Downloads"))
STATE = ERAS / "watcher.state.json"
CSV_RE = re.compile(r"^TASTE-PACK-RATINGS-(pack-\d+).*\.csv$")
PLIST = Path(os.path.expanduser("~/Library/LaunchAgents/com.mosh.ratings-watcher.plist"))
INSTALLED = ERAS / "ratings_watcher.py"


def log(msg: str) -> None:
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def active_era() -> dict | None:
    best = None
    for d in sorted(ERAS.glob("era-*")):
        m = d / "manifest.json"
        if m.is_file():
            doc = json.loads(m.read_text())
            if not doc.get("closedAt"):
                best = doc
    return best


def ensure_server() -> None:
    """The listening room on :8188 — start a plain static server if nothing answers."""
    import urllib.request
    try:
        urllib.request.urlopen("http://127.0.0.1:8188/", timeout=2)
        return
    except Exception:  # noqa: BLE001
        pass
    subprocess.Popen(["/usr/bin/python3", "-m", "http.server", "8188",
                      "--bind", "127.0.0.1", "-d", str(BEATS)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log("started static listening-room server on :8188")


def one_pass() -> int:
    state = json.loads(STATE.read_text()) if STATE.is_file() else {"processed": {}}
    processed = state.setdefault("processed", {})
    ingested_any = False
    for f in sorted(DOWNLOADS.glob("TASTE-PACK-RATINGS-*.csv")):
        m = CSV_RE.match(f.name)
        if not m:
            continue
        sha = _sha(f)
        if processed.get(str(f)) == sha:
            continue
        pack = m.group(1)
        pack_dir = BEATS / pack
        if not pack_dir.is_dir():
            log(f"skip {f.name}: no {pack_dir}")
            processed[str(f)] = sha
            continue
        if list(pack_dir.glob("RATINGS*.csv")):
            log(f"skip {f.name}: {pack} already has ratings")
            processed[str(f)] = sha
            continue
        dest = pack_dir / f"RATINGS-{pack.split('-')[1]}.csv"
        shutil.copy2(f, dest)
        processed[str(f)] = sha
        ingested_any = True
        log(f"ingested {f.name} → {dest}")
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1))
    if not ingested_any:
        return 0

    era = active_era()
    if era is None:
        log("ratings merged later — no active era (era_boundary --open)")
        return 0
    wt = Path(os.path.expanduser(era["worktree"]))
    tools = wt / "scripts" / "verify-hardware"
    if not tools.is_dir():
        log(f"era worktree tools missing at {tools} — NOT building (fail-closed)")
        return 1
    r = subprocess.run(["/usr/bin/python3", str(tools / "merge_labels.py")])
    if r.returncode != 0:
        log(f"merge_labels rc={r.returncode} — NOT building (fail-closed)")
        return 1
    r = subprocess.run(["/usr/bin/python3", str(tools / "make_pack.py"), "--next"])
    if r.returncode == 3:
        log("era complete or none active — nothing to build (run era_boundary)")
        return 0
    if r.returncode != 0:
        log(f"make_pack rc={r.returncode} — NO pack shipped (fail-closed)")
        return 1
    ensure_server()
    log("next pack ready at :8188")
    return 0


_PLIST_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mosh.ratings-watcher</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string><string>@SCRIPT@</string>
  </array>
  <key>WatchPaths</key><array><string>@DOWNLOADS@</string></array>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>@LOG@</string>
  <key>StandardErrorPath</key><string>@LOG@</string>
</dict></plist>
"""


def install() -> int:
    ERAS.mkdir(parents=True, exist_ok=True)
    shutil.copy2(os.path.abspath(__file__), INSTALLED)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_text(_PLIST_TMPL.replace("@SCRIPT@", str(INSTALLED))
                     .replace("@DOWNLOADS@", str(DOWNLOADS))
                     .replace("@LOG@", str(ERAS / "watcher.log")))
    subprocess.run(["launchctl", "unload", str(PLIST)], capture_output=True)
    r = subprocess.run(["launchctl", "load", str(PLIST)], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"launchctl load failed: {r.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"watcher installed: {PLIST}\n(log: {ERAS / 'watcher.log'}; "
          "uninstall any time with --uninstall)")
    return 0


def uninstall() -> int:
    subprocess.run(["launchctl", "unload", str(PLIST)], capture_output=True)
    if PLIST.is_file():
        PLIST.unlink()
    print("watcher uninstalled (installed copy left at "
          f"{INSTALLED} for reference)")
    return 0


if __name__ == "__main__":
    if "--install" in sys.argv:
        raise SystemExit(install())
    if "--uninstall" in sys.argv:
        raise SystemExit(uninstall())
    raise SystemExit(one_pass())
