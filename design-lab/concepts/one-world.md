# ONE WORLD — should Moshi and the stone be one artifact?

*The user's question (2026-06-10): "we have two 3D artifacts now… is there a way to
consolidate Moshi and the stone? Maybe they are one artifact? Maybe not — have a
think about how we might reorganize this more intelligently."*

## The distinction that matters

The two bodies answer different questions:

| | the stone | Moshi |
|---|---|---|
| **is** | the WORK — your track as matter | the AGENT — a being with a face |
| **grows from** | what you make (spectral fill, arrangement) | nothing — he's constant |
| **belongs to** | you | himself (he works *for* you) |
| **signals** | how built/hot/wild the song is | listening / recording / reacting |

That table is why a *full* merge is dangerous: if the stone wears Moshi's face, the
track becomes the agent — "is this song mine or his?" — and the REC signal (his heat)
gets tangled with the song's energy (its light). Identity collapse, not consolidation.

## Three options weighed

**A — ONE WORLD, TWO BEINGS (recommended, previewed).** Keep both identities; merge
their *space*. Moshi stations at the stone's base — the keeper of the kiln — sharing
its ground, its light, its physics. Already shipped as a DOM preview in 009 (his
position rides the stone's live radius, like the orbit knobs). The full version moves
his SDF into the pit shader: one canvas, one raymarch, shared room lighting, true
occlusion — he can WALK to the stone, lean on it, look up at it when a section morphs,
warm his hands on the contact glow when you record. Same grammar (he already IS the
stone's smin-lobe parent), so the merge is mostly plumbing, not redesign. Bonus:
009 drops to one GL context.

**B — THE STONE IS MOSHI (full merge).** The artifact grows Moshi's face; the track
literally becomes the creature. Bold, memorable — we even saw accidental pareidolia
on the v6 mass that charmed. But it breaks the ownership table above, and the two
non-negotiables (am-I-recording vs how-built-is-the-song) would share one body's
expression budget. Parked as a special MOMENT instead: when a track is *finished*
(complete = 1, exported), the stone could briefly smile — the work comes alive once,
as a reward — without living as a face all the time.

**C — BEHAVIORAL COUPLING ONLY (cheapest).** Keep two canvases; Moshi merely reacts
to stone events (glances on slams, hops on renders). Low risk, low payoff — it
doesn't answer the "two separate 3D components" feeling, which is spatial, not
behavioral.

## Recommendation

**A**, in two steps: the shipped DOM preview now (keeper at the kiln — judge the
composition), then the single-canvas merge as its own pass (move MoshiBlob's map()
into the pit shader behind a `u_moshi` toggle; retarget poke/gaze; retire the second
context). B's finished-track smile rides along later as a one-shot moment, where it's
magic instead of confusion. The component model survives: MoshiBlob stays canonical
for 008/011 and any surface without a world.
