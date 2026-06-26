# ClaudeMosh Scripts/Deploy/Gates Audit

Scope audited:
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/run-mosh.sh`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/relay/run-mp-selftest.sh`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/relay/test_*.py`
- auto-loop, package, deploy, playtest, preflight gates
- Excluded generated `__pycache__` and build outputs.

Read-only verification:
- `bash -n` passed for the specified worktree `run-mosh.sh` plus 27 shell scripts under `scripts/` and `relay/`.
- `git status --short` showed a dirty checkout; this audit treated current source as untrusted and did not modify scoped source files.
- Secret search found API-key variable names and dotenv handling, but no literal `sk-...` token or private-key material in scoped files.
- Line evidence was collected with `nl -ba` and non-mutating `rg` searches only.

Skill-perspective check:
- `omo:remove-ai-slops` was loaded and applied as an audit lens: over-defensive swallowing, false proof, dead/stale paths, needless complexity, and coverage slop were reviewed.
- `omo:programming` was loaded, and the Python README was consulted because scoped gate scripts include Python. The scoped files violate that perspective in the oversized/untyped Python UI gate and in tests/gates that rely on brittle text parsing, broad exceptions, and sleeps.
- No diff was provided as input; this report audits the current scoped files instead of a branch diff.

## CRITICAL

None found.

## HIGH

### 1. Destructive deploy removes the canonical installed app before the replacement is proven

Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/run-mosh.sh`

Evidence:
- Lines 146-149 define `install_app()` as `rm -rf "$2"; cp -R "$1" "$2"`.
- Lines 214-223 call it for `/Applications/Mosh.app` during `deploy`.
- Lines 227-239 do the same during `deploy-anira`.

Slop category: unsafe deploy flow; over-defensive simplicity; missing installed-app proof.

Behavior risk: if `cp -R`, permissions, disk space, or signing/bundling fails after the delete, the one canonical `/Applications/Mosh.app` is gone or half-installed. The command can also print a deploy success without a post-copy launch/signature/service proof.

Coverage: `bash -n` only proves syntax. No dry-run or staged-copy test covers interrupted copy, failed bundle copy, signature verification, or real installed-app launch.

One-wave acceptance criteria:
- Deploy into a temp sibling such as `/Applications/.Mosh.app.tmp.$$`.
- Bundle service, handle xattrs, sign, and verify the temp bundle before replacing the canonical app.
- Replace atomically enough for Finder/Dock usage, preserving the old app until the new bundle passes.
- Emit artifact paths containing bundle path, binary hash, `codesign --verify`, xattr scan, and a real `/Applications/Mosh.app/Contents/MacOS/Mosh` smoke/selftest result.

### 2. Deploy persists provider API keys into the app bundle by default

Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/run-mosh.sh`

Evidence:
- Lines 123-127 document bundling Moshi brain keys into `Contents/Resources/brain.env` and note that anyone with the app can read the key.
- Lines 128-142 write `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and `XAI_API_KEY` values into that bundle file.

Slop category: secret-boundary violation; production data persistence not required by the deploy gate.

Behavior risk: the installed app becomes a long-lived secret-bearing artifact. That preserves Dock/Finder launch behavior but weakens the repo rule that keys live in local config and raises accidental sharing/copying risk.

Coverage: no scoped gate asserts that app bundles or dist packages are free of `*_API_KEY=`. The secret search only confirmed no literal secrets in source, not no secrets in produced bundles.

One-wave acceptance criteria:
- Make persistent key bundling opt-in with an explicit scary flag, or move installed-app key discovery to `~/.config/mosh/env` with mode `600`.
- Add a non-mutating bundle scan gate for `/Applications/Mosh.app`, `build-macos-arm64*`, and `dist/` artifacts that fails on `*_API_KEY=`, private keys, or token-looking values.
- Keep installed-app proof by launching from the real installed path using user-local config, not repo cwd.

### 3. Anira self-containment can report success even when rpath surgery failed

Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/run-mosh.sh`

Evidence:
- Lines 171-173 run `install_name_tool` rpath edits with `2>/dev/null || true`.
- Lines 178-181 then strip xattrs, ad-hoc sign, verify the signature, and print `self-contained`.

Slop category: false proof; over-defensive error swallowing.

Behavior risk: code signing can pass while the binary still contains absolute build-tree rpaths. The deploy output can claim a self-contained `/Applications/Mosh.app` that breaks after build cleanup or on another Mac.

Coverage: no `otool -l`/`otool -L` postcondition checks prove that build-tree rpaths are gone or that `libanira`/LibTorch dylibs resolve from `Contents/Frameworks`.

One-wave acceptance criteria:
- Do not suppress `install_name_tool` failures.
- Assert no build-tree rpaths remain after surgery.
- Assert the expected dylibs exist in `Contents/Frameworks` and are referenced through app-relative paths.
- Keep `codesign --verify --deep --strict`, but treat it as signature proof only, not self-containment proof.

### 4. Auto-loop selftest parsing allows reduced-suite false greens when no baseline is configured

Paths:
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/auto-loop/lib.sh`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/auto-loop/gate.sh`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/src/app/SelfTest.cpp`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/plugin-host-evidence-gate.sh`

Evidence:
- `SelfTest.cpp` lines 4553-4555 prints the canonical footer as `===== passed/total checks passed, failed failed =====`.
- `auto-loop/lib.sh` lines 103-111 parses only the substring `N checks passed, F failed`, losing the total.
- `auto-loop/gate.sh` lines 95-109 makes the minimum-count baseline optional; if `MOSH_SELFTEST_BASELINE` is unset, it records baseline `unset` and can still pass.
- `plugin-host-evidence-gate.sh` lines 21-39 shows the stronger local pattern: parse passed, total, failed, require passed equals total, failed equals zero, and total above a floor.

Slop category: brittle gate parsing; coverage false confidence.

Behavior risk: a binary that silently skips large parts of the selftest can pass auto-loop if the reduced run is deterministic and has zero failures.

Coverage: no parser unit test covers missing summary, reduced total, multiple summaries, failed checks, or JUCE assertion combinations.

One-wave acceptance criteria:
- Use one shared parser for selftest summaries.
- Parse passed, total, and failed from the full canonical footer.
- Require `passed == total`, `failed == 0`, deterministic totals across three runs, and a mandatory floor.
- Add parser fixture tests for canonical pass, reduced-suite fail, explicit failure fail, missing-summary fail, and multiple-summary logs.

### 5. Live multiplayer smoke exits success on a partial sync result

Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/playtest/mp-live-smoke.sh`

Evidence:
- Lines 121-124 exit 0 only for full pass.
- Lines 125-127 also exit 0 for `PARTIAL` when the audio stem arrives but the saved edit lacks both expected track names.

Slop category: useless/false-positive gate; test accepts weaker behavior than its name promises.

Behavior risk: a live multiplayer playtest can be treated as green even when session state did not fully sync. That is exactly the path this script claims to prove.

Coverage: no wrapper shown here distinguishes `PARTIAL` from `PASS`; exit status alone cannot protect users.

One-wave acceptance criteria:
- Make `PARTIAL` exit nonzero, or use a distinct code that every caller treats as no-go.
- Emit a machine-readable result with `stem_ok`, `drums_ok`, `tone_ok`, and command-result failures.
- Require all three assertions for a pass.
- Add a small fixture test or shell harness proving `PARTIAL` does not return success.

### 6. Binary resolvers still use stale/nondeterministic path selection in playtest and relay gates

Paths:
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/relay/run-mp-selftest.sh`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/playtest/preflight.sh`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/playtest/mp-live-smoke.sh`
- `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/auto-loop/gate.sh`

Evidence:
- `relay/run-mp-selftest.sh` line 13 defaults to a `find ... build-macos-arm64 ... | head -1` debug binary.
- `scripts/playtest/preflight.sh` line 14 defaults to `find ... build-macos-arm64-release ... | head -1`, then falls back to `/Applications/Mosh.app` at line 15.
- `scripts/playtest/mp-live-smoke.sh` line 17 uses the same release `find | head -1` pattern.
- `scripts/auto-loop/gate.sh` line 164 uses `find ... MoshTests ... | head -1` for the Catch2 fallback.

Slop category: stale hardcoded build paths; nondeterministic gate target selection.

Behavior risk: gates can validate a stale or arbitrary binary while the real installed app differs. `head -1` over filesystem traversal order is not a deterministic "newest" or "current preset" resolver.

Coverage: scripts print some selected paths, but there is no shared resolver test, no hash evidence, and no installed-app equivalence check.

One-wave acceptance criteria:
- Consolidate binary/app resolution into one script helper.
- Prefer explicit env override, then newest current preset by mtime, then installed app only when the gate is explicitly installed-app scoped.
- Print path, mtime, and SHA-256 for every selected binary.
- Add resolver tests using temp directories with multiple candidate apps.

### 7. macOS UI automation gate is an oversized, untyped, sleep-heavy proof surface

Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/macos-ui-automation-gate.py`

Evidence:
- Pure LOC measurement: `scripts/macos-ui-automation-gate.py:1041`.
- Lines 130-220 show untyped `dict` result plumbing, process killing, service startup polling, command-log polling, and sleeps.
- Search evidence found many `time.sleep(...)` calls and many `dict` annotations throughout the file.

Slop category: oversized module; excessive complexity; untyped escape hatches; nondeterministic waits.

Behavior risk: this gate is too large to review as one unit and mixes service control, AX parsing, mouse synthesis, screenshot analysis, and scenario assertions. It is likely to accumulate flaky timing fixes and makes false UI proof harder to diagnose.

Coverage: no focused unit tests were found for command-log parsing, AX row parsing, candidate selection, or image-diff thresholds. The gate only tests itself by driving the full app.

One-wave acceptance criteria:
- Split into named modules by responsibility: service control, command log, AX tree, pointer actions, image assertions, and scenarios.
- Replace raw `dict` rows with typed dataclasses or TypedDicts at boundaries.
- Unit-test parsers/selectors and keep one end-to-end UI gate as the final integration proof.
- Reduce fixed sleeps in favor of observable waits where the app exposes a command log, AX state, process state, or file artifact.

## MEDIUM

### 8. Quarantine clearing reports success after suppressing recursive xattr failures

Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/playtest/unquarantine.sh`

Evidence:
- Line 20 runs `xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true`.
- Lines 22-26 only check `xattr -p` on the bundle root.

Slop category: over-defensive error swallowing; false verification after destructive action.

Behavior risk: protected nested files can retain quarantine while the script prints that the app is cleared.

Coverage: no recursive residual xattr scan or package round-trip gate verifies the copied app is actually launchable after the user's one-line bypass.

One-wave acceptance criteria:
- Fail if recursive `xattr -dr` fails unexpectedly.
- Scan recursively for remaining `com.apple.quarantine` attributes and print exact residual paths.
- Add a package round-trip check that unzips the artifact, clears quarantine, and verifies the app bundle can be inspected or launched.

## LOW

### 9. Playtest preflight summary extraction is presentation-only and not artifact-backed

Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/playtest/preflight.sh`

Evidence:
- Lines 31, 33, 43, 53, and 63 use `grep ... | tail -1` to decorate PASS/FAIL messages.
- The underlying pass/fail correctly comes from command exit status, but the summary can be blank or misleading if output format changes.

Slop category: brittle prompt/text parsing in test output.

Behavior risk: lower than the auto-loop parser because exit status still controls the gate, but playtest operators may lose the useful tally in the no-go/go summary.

Coverage: no golden-output fixture checks the summary messages.

One-wave acceptance criteria:
- Reuse the shared selftest/verify parser from the auto-loop work.
- Write a machine-readable preflight report next to the temp logs.
- Include selected binary SHA and artifact paths in the final summary.

## Blockers Before Approval

- Fix the destructive `/Applications/Mosh.app` deployment sequence or gate it behind staged, verified replacement.
- Remove default persistent API-key bundling from deploy, or make it explicit opt-in with bundle/dist secret scans.
- Make anira self-containment fail on failed rpath edits and prove app-relative dynamic-library resolution.
- Replace auto-loop selftest parsing with a mandatory full-footer parser and count floor.
- Make live multiplayer `PARTIAL` a failure for playtest readiness.
- Consolidate nondeterministic binary selection before treating relay/playtest gates as installed-app proof.
- Start splitting or quarantining the oversized UI automation gate so future gate changes are reviewable.

## Commands / Evidence

```sh
sed -n '1,240p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/remove-ai-slops/SKILL.md
sed -n '241,520p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/remove-ai-slops/SKILL.md
sed -n '1,260p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/programming/SKILL.md
sed -n '261,560p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/programming/SKILL.md
sed -n '1,260p' /Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.13.0/skills/programming/references/python/README.md
git status --short
find scripts -type f \( -name '*.sh' -o -name '*.bash' -o -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.mjs' -o -name '*.cjs' \) ! -path '*/__pycache__/*' | sort
find relay -type f \( -name '*.sh' -o -name '*.bash' -o -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.mjs' -o -name '*.cjs' \) ! -path '*/__pycache__/*' | sort
for f in /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/run-mosh.sh $(find scripts relay -type f \( -name '*.sh' -o -name '*.bash' \) ! -path '*/__pycache__/*' 2>/dev/null | sort); do bash -n "$f" || exit 1; done
rg -n --glob '!**/__pycache__/**' --glob '!build*/**' --glob '!ui/node_modules/**' --glob '!third_party/**' 'build/Mosh|build/|build-macos|Mosh_artefacts|/Applications/Mosh\.app|MOSH_APP|APP=|APP_PATH|xattr|codesign|spctl|notar|ditto|hdiutil|create-dmg|cp -R|rsync|rm -rf|sudo|chmod|install_name_tool' scripts relay /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/run-mosh.sh run-mosh.sh service/run.sh
rg -n --glob '!**/__pycache__/**' --glob '!build*/**' 'except Exception|except BaseException|Any|dict\]|dict\)|: dict|argparse|time\.sleep|sleep [0-9]|head -1|tail -1|grep -oE|grep -Eo' scripts relay
rg -n 'checks passed|failed|selftest' src/app/SelfTest.cpp src -g '!build*/**' | head -80
python3 - <<'PY'
from pathlib import Path
files = [Path('scripts/macos-ui-automation-gate.py'), Path('scripts/verify-hardware/verify.py'), Path('relay/server.py'), Path('relay/test_server.py')]
for f in files:
    if f.exists():
        pure = 0
        for line in f.read_text(encoding='utf-8', errors='replace').splitlines():
            s=line.strip()
            if s and not s.startswith('#'):
                pure += 1
        print(f'{f}:{pure}')
PY
```

## Status

codeQualityStatus: BLOCK

recommendation: REQUEST_CHANGES

reportPath: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.omo/evidence/scripts-deploy-gates-audit-code-review.md`
