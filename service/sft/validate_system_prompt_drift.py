#!/usr/bin/env python3
"""Check whether assist_demonstrations.jsonl's committed `system` field (the
production buildSystemPrompt() render this repo's newest committed SFT rows
embed) still matches the CURRENT ui/src/agent/commands.ts catalog + the
CURRENT DEFAULT_RULES text in ui/src/agent/brainCore.ts.

WHY this exists (r6-sft-data-pass ground rule 2): "training prompts must
match the SERVE prompt shape byte-for-byte where the pipeline expects it...
check what prompt the SFT examples embed and FLAG any mismatch rather than
guessing." This script is that check, in code (not just a one-off finding in
a report) so it can be re-run any time a new increment is about to reuse the
same embedded system prompt.

Does NOT execute any TypeScript — it diffs regex-extracted command sets and
regex-extracted rule text against the string already embedded in the JSONL.
A clean result here does NOT prove byte-identity (only a real
buildSystemPrompt() call could) — it proves the two things most likely to
silently drift (catalog completeness, the musical-time rule) have not, or
reports exactly what's missing when they have.

Usage: python3 validate_system_prompt_drift.py
Exit 0 = no known drift found. Exit 1 = drift found (printed).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sft_catalog import load_catalog  # noqa: E402

SCRIPT_DIR = Path(__file__).resolve().parent
ASSIST_DEMOS = SCRIPT_DIR / "assist_demonstrations.jsonl"
MUSICAL_TIME_TS = SCRIPT_DIR.parent.parent / "ui" / "src" / "agent" / "musicalTime.ts"


def embedded_system_prompt() -> str:
    lines = ASSIST_DEMOS.read_text(encoding="utf-8").splitlines()
    rows = [json.loads(line) for line in lines if line.strip()]
    systems = {row["messages"][0]["content"] for row in rows}
    if len(systems) != 1:
        raise RuntimeError(f"{ASSIST_DEMOS} rows do NOT all share one system prompt ({len(systems)} distinct) — cannot check drift against a single baseline")
    return next(iter(systems))


def main() -> int:
    sys_prompt = embedded_system_prompt()
    problems: list[str] = []

    live_catalog = load_catalog()
    embedded_commands = set(re.findall(r"^- ([a-z_]+)\(", sys_prompt, re.M))
    missing = sorted(set(live_catalog) - embedded_commands)
    extra = sorted(embedded_commands - set(live_catalog))
    if missing:
        problems.append(
            f"{len(missing)} command(s) in the CURRENT catalog are MISSING from the "
            f"embedded system prompt (added to commands.ts after assist_demonstrations.jsonl "
            f"was last regenerated): {missing}"
        )
    if extra:
        problems.append(
            f"{len(extra)} command(s) in the embedded system prompt no longer exist in the "
            f"current catalog (removed/renamed since regeneration): {extra}"
        )

    musical_time_rule = MUSICAL_TIME_TS.read_text(encoding="utf-8")
    m = re.search(r'export const MUSICAL_TIME_RULE =\s*\n?\s*"((?:[^"\\]|\\.)*)"', musical_time_rule)
    if m:
        rule_text = m.group(1).replace('\\"', '"')
        if rule_text not in sys_prompt:
            problems.append(
                "MUSICAL_TIME_RULE (ui/src/agent/musicalTime.ts) is NOT present in the embedded "
                "system prompt's Rules block — the embedded prompt predates this rule's addition."
            )

    if problems:
        print("DRIFT FOUND — the system prompt embedded in assist_demonstrations.jsonl (and\n"
              "anything, including r7_coverage_demonstrations.jsonl, that reuses it verbatim)\n"
              "does NOT byte-match what buildSystemPrompt() renders today:\n", file=sys.stderr)
        for p in problems:
            print(f" - {p}", file=sys.stderr)
        print("\nRegenerate via: cd ui && npx tsx scripts/build_assist_sft.mts", file=sys.stderr)
        print("then re-point any file that embeds this prompt at the fresh one before merging into a real training mix.", file=sys.stderr)
        return 1

    print("OK: no known drift between the embedded system prompt and the current catalog/rules.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
