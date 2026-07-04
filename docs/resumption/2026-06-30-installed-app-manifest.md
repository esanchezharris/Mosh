# Installed App Preservation Manifest - 2026-06-30

This is a read-only preservation record for `/Applications/Mosh.app`.
Do not redeploy over the installed app until this divergence is intentionally
resolved.

## Bundle Identity

| Field | Value |
| --- | --- |
| Path | `/Applications/Mosh.app` |
| Bundle id | `studio.mosh.app` |
| Executable | `Mosh` |
| Version | `0.0.1` |
| Signature | ad-hoc |
| TeamIdentifier | not set |
| CDHash | `a462a55a67a1000e752ba999000bf3dabdedce04` |
| Sealed resources | yes, version 2, 65 files |

## Key File Fingerprints

| File | Size | mtime | SHA-256 |
| --- | ---: | --- | --- |
| `/Applications/Mosh.app/Contents/MacOS/Mosh` | 20007040 | `2026-06-30T03:18:47-0700` | `d14fd4062a592a4c2774da0c982bf7e0679b5854e5528afcc30d1264d03dc90c` |
| `/Applications/Mosh.app/Contents/Resources/ui/index.html` | 708896 | `2026-06-30T03:18:47-0700` | `94ab75d2ef6b1e1905ea2f372e82e6477ca7bdfec5cf332f9081623d3ccfdcff` |
| `/Applications/Mosh.app/Contents/Resources/service/server.py` | 53833 | `2026-06-30T03:18:47-0700` | `a198c3e60c5994aab82d4446e1cca2d9b5ee1b088340b82163488609ef4efcc3` |
| `/Applications/Mosh.app/Contents/Resources/service/run.sh` | 3748 | `2026-06-30T03:18:47-0700` | `43521283c307f2e0d6381817135052a01f33a79a70711c6dc0c554574076d5d2` |

## Closest Source Matches

The installed app is not a coherent match for one local build artifact.

| Installed artifact | Closest observed local match | Evidence |
| --- | --- | --- |
| `Resources/service/server.py` | Current `origin/main` source in `/Users/emiliosanchez-harris/Documents/ClaudeMosh-moshfx`, this worktree, `.claude/worktrees/recursing-black-291d86`, and `.claude/worktrees/vigilant-robinson-a5b2c2` | All share SHA-256 `a198c3e60c5994aab82d4446e1cca2d9b5ee1b088340b82163488609ef4efcc3`. |
| `Resources/ui/index.html` | `.claude/worktrees/vigilant-robinson-a5b2c2` (`claude/reimagine-inplace-wholeclip`, PR #185) | Both share SHA-256 `94ab75d2ef6b1e1905ea2f372e82e6477ca7bdfec5cf332f9081623d3ccfdcff`. |
| `Contents/MacOS/Mosh` | No local Release binary match found among checked worktrees with existing Release artifacts | Installed binary SHA-256 is `d14fd4062a592a4c2774da0c982bf7e0679b5854e5528afcc30d1264d03dc90c`; nearest checked local Release artifacts differed. |

## Policy

- Treat `/Applications/Mosh.app` as preserved/diverged until proven otherwise.
- Before any `./run-mosh.sh deploy`, either archive this exact bundle or identify
  and rebuild its intended source branch.
- Do not use the installed app as proof that the current checkout or this
  branch has been deployed.
- If installed-app truth matters for a task, run the app gate from the intended
  source after preservation, not from the stale `codex/phone-controller-latency-gate`
  checkout.
