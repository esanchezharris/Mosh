# Vendored third-party licence texts

Every `.txt` in this directory is a **verbatim copy of an upstream LICENSE/NOTICE file**,
copied from the exact source tree Mosh builds against. They are the payload of the shipped
`Contents/Resources/NOTICES.txt`, which
[`service/scripts/packaging_check.py`](../../service/scripts/packaging_check.py) generates
with `--emit-notices` and then verifies with `--bundle` on every deploy and release.

**Do not edit these files.** They are not ours to reword. Re-copy from upstream when a
dependency is re-pinned; the packaging check compares the shipped bytes against them, so a
hand-edit here silently changes what every user receives.

## Why this directory exists

The first version of the packaging check generated NOTICES.txt from the BOM's **Obligations**
column, which holds *internal engineering notes about what Mosh owes* — not the notices
themselves. The published file therefore carried working notes (`**JUCE 8 Indie caps at
$300K … stale**`), unfinished TODOs, literal markdown, **zero copyright lines and zero
licence text**, while the check reported `OK — 12 shipping BOM rows acknowledged` because it
only tested that each dependency's *name* appeared somewhere in the body.

A notice you cannot read is not a notice. The rule now is: what ships is the upstream text,
byte for byte.

## The contract

`docs/DEPENDENCY_BOM.md` §1 carries a **`Notice`** column. Every row that is not `EXCLUDED`
must name one of:

| Value | Meaning |
|---|---|
| `licenses/<file>.txt` | Distributed with Mosh. The file's bytes are emitted verbatim into NOTICES.txt. |
| `not-bundled` | Present in the repo or in local tooling, but **not** inside the distributable. Nothing to retain. |
| `hosted-service` | Reached over the network. No third-party code is distributed, so no notice attaches. |

The check **fails closed**: a shipping row naming a `licenses/` file that does not exist, or
whose text is absent from the built bundle's NOTICES.txt, is a hard error. So the day one of
the `not-bundled` dependencies starts shipping, the release stops until its text is vendored
here — which is the whole point.

## What is vendored today, and why only these

| File | Dependency | Sourced from |
|---|---|---|
| `tracktion-engine.txt` | Tracktion Engine | the pinned `tracktion_engine` clone the build links against |
| `juce-8.txt` | JUCE 8 | `modules/juce/LICENSE.md` in that same clone |
| `sentry-native.txt` | sentry-native SDK | the pinned sentry-native CPM source |
| `crashpad.txt` | crashpad (vendored inside sentry-native) | `external/crashpad/LICENSE` in that source |

These four are the third-party code that is actually **linked into the shipped binary**.
Verified empirically against a Release build, not assumed: `Mosh.app` has no `Contents/
Frameworks`, `otool -L` on the executable lists no non-system dylib, and `Contents/Resources`
holds only `AppIcon.icns`, a nib, `companion/`, `drumkits/` and `ui/`. The bundled drum kits
are first-party — synthesised in-repo by `resources/drumkits/generate_kit*.py`, nothing
sampled.

The sentry/crashpad pair only reaches a user in a `-DMOSH_ENABLE_SENTRY=ON` build (default
OFF), and is vendored anyway so that build cannot ship unattributed.
