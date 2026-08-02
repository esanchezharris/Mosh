# Vocal Map Playtest Program — Decision Log

Append-only. Amend a settled choice with a new dated decision; do not rewrite
the earlier record.

## VM-D001 — 2026-07-30 — Playtest outcome

The program is organized around one observable outcome: a solo novice keeps an
identity-preserving guide vocal from a 4–8-bar mumble, after editing at least one
word or syllable, within 15 minutes and without owner help.

## VM-D002 — 2026-07-30 — Product and agent names

The product is **Mosh** and the agent is **Moshi**. Active UI, symbols, comments,
and current documentation use Moshi. Archived history, unrelated media names,
and legacy serialized `"monster"` values are preserved/readable.

## VM-D003 — 2026-07-30 — State split

`VocalIntent` is the semantic source of truth in the session ValueTree. Dense
F0/features are immutable, content-addressed project sidecars. Snapshots contain
an additive compact summary and detail is fetched lazily.

## VM-D004 — 2026-07-30 — Edit posture

`Musical` is the default preset. Identity, lyrics, and melody remain at 100;
rhythm/expression are 80. Exact source F0 is preserved by default. Arrangement
and audio outside the affected phrase are hard locked.

## VM-D005 — 2026-07-30 — Local/cloud split

Local zero-shot own-voice previews are ephemeral and refresh after settled
edits. Cloud rendering is explicit, durable, and lands a new take. RunPod
Serverless plus encrypted Cloudflare R2 is the private-playtest target with a
$150/month ceiling; the optional owner-machine pack is at most 10 GB.

## VM-D006 — 2026-07-30 — Authorization and retention

The private playtest has no login. An invisible Keychain capability authorizes
project and voice-profile operations; a project ID alone is never sufficient.
Project cloud assets last until project deletion/purge. The install-scoped voice
profile has a separate replace/delete lifecycle.

## VM-D007 — 2026-07-30 — Safety and telemetry

Generated guides receive AudioSeal metadata plus an inaudible watermark. Mosh
adds no lyric-content filter and discloses upstream restrictions. Telemetry is
opt-in and redacted; audio, lyrics, detailed maps, embeddings, and training data
are never collected.

## VM-D008 — 2026-07-30 — Research stop

Roster cutoff is 2026-08-13. Stack freeze is 2026-08-27. Performance-loss
failures are disqualifying; survivors rank by Keep rate, pride/edit locality,
then latency/cost. If none clears the target, the best stack still freezes and
the program enters debugging. Research does not extend.

## VM-D009 — 2026-07-30 — Delivery

Vocal Map delivery is a serial PR train. Each program PR receives the complete
relevant local gate and owner merge before the next seat starts. No automation
or agent merges a Vocal Map PR.

## VM-D010 — 2026-07-30 — Superseded pull requests

Open First-Stranger PRs #471, #473, #475, and #478 remain preserved but paused.
They are not dependencies of the Vocal Map train and require an explicit owner
close, park, or rebase decision before any merge.

## VM-D011 — 2026-07-30 — Existing queue

Pre-existing PRs #322, #462, #472, #507, #508, #510, and #514 are parked outside
the active serial seat. Any owner exception requires rebasing onto current trunk
and rerunning the full gate; broad Mac compatibility remains outside the
September surface.

VM-001 necessarily edits the shared automation rulebook to make the
First-Stranger pause fail closed. It satisfies the program-STOP, exact gated
head, and failed-push portions of historical backlog item AL-028. Its remaining
hardening requirements stay `needs-human`, and the loop remains unarmed.

## VM-D012 — 2026-07-30 — Complete open-PR disposition

The status board explicitly dispositions all 22 pull requests that were open at
the VM-001 cutoff. FMS and lyric-benchmark PRs may remain as preserved research
artifacts, but research accumulation does not grant a merge exception. Every
pre-existing PR remains outside the serial seat until the owner explicitly
authorizes it, rebases it onto the then-current trunk, and reruns the full gate.

## VM-D013 — 2026-07-30 — Late-arriving PR

PR #522 opened after the 22-PR VM-001 cutoff. It is parked as pre-existing
brain-fallback work and receives no merge exception; it must follow the same
owner authorization, current-trunk rebase, and fresh full-gate rule.

## VM-D014 — 2026-07-31 — Executed owner exceptions and VM-001 order

VM-D013 remains the decision at the time PR #522 arrived. The owner later
granted explicit serial exceptions after the required current-trunk rebases and
fresh gates: PR #522 merged first as `6c3687db`, then the overlapping agent
drawer repair PR #526 merged as `379bd6a1`.

VM-001/PR #523 follows both. It must be rebased onto `379bd6a1`, discard
superseded overlap in favor of that trunk, and regenerate its complete
exact-head local gates, native matching-surface evidence, and five review lanes
before publication or owner merge. No general exception to the one-seat rule is
created by this sequence.

## VM-D015 — 2026-07-31 — Late PR #524 and #528 disposition

Draft PR #524 overlaps the active VM-001 surface. Its earlier proposed landing
chain through #514, #507, #508, and #510 is superseded: those branches remain
parked, and #524 sits behind the VM-001 owner merge. Resuming #524 requires a
rebase onto the then-current trunk and a fresh full gate.

PR #528 opened later with an urgent CoreAudio timeout repair. It also defaults
behind VM-001. The owner may grant it an explicit exception; if it advances
`main` first, VM-001 must rebase onto that merge and regenerate its exact-head
gates, matching-surface evidence, and all five reviews. Neither late arrival
silently changes the serial authority.

## VM-D016 — 2026-08-02 — Owner-only participant scope

The September proof uses the owner as its sole solo-novice participant. The
two-additional-singer recruitment gate is removed. The sealed evaluation packet
contains eight owned clips from that participant, balanced across melodic/rap
and free/paired mumble cases. Results establish owner-playtest fitness only and
make no multi-singer or broad-hardware claim.

For the owner-only proof, VM-D001's “without owner help” means self-guided use
without an external facilitator, operator, or agent intervention; it cannot
mean excluding the owner who is now the participant.

## VM-D017 — 2026-08-02 — Natural editable draft is the lyric criterion

The aligned lyric capability returns one natural, singable, constrained first
draft. It does not claim to recover lyrics that existed privately behind a
mumble. Exact-word recovery and raw-ASR edit distance remain diagnostic, but do
not gate the playtest. The product gate is whether the draft preserves the
source's cadence, syllable structure, melodic intent, and repetition well
enough that the owner can make a direct word or syllable edit and keep a guide.

This decision follows the owner acceptance of frozen Cycle 9 candidate
`cycle9-c022` (7/8/6 syllables): “this a natural, editable first draft, continue
with this in mind.”

## VM-D018 — 2026-08-02 — Source-conditioned identity evidence

For the accepted owner-lab evidence, YingMusic receives the exact source mumble
bytes as both its voice-identity reference and melody reference. The separately
supplied recording rejected by the owner is excluded from the active evidence
lineage. This validates the source-conditioned research path; it does not yet
select the August 27 production stack or remove the reusable-profile contract.

## VM-D019 — 2026-08-02 — Current-trunk refresh after owner exceptions

PR #528 merged by owner exception as `e520550b`; subsequent production fixes,
the public `v0.1.0` release, and accessible track-selection PR #596 advanced
`main` through `01adca36`. VM-001 is rebuilt as one current-trunk squash on that
exact base. Deleted public-cleanup files stay deleted; VM-001 carries forward
only the active Moshi terminology, fail-closed First-Stranger pause, and Vocal
Map program authority. All earlier VM-001 gate evidence is historical until
regenerated on the new exact head.
