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

Delivery is a serial PR train. Each PR receives the complete relevant local
gate and owner merge before the next starts. No automation or agent merges.
