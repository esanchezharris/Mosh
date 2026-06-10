# 010 · MOSHI — the agent as a 3D component

**Thesis.** The agent stops being an indicator and becomes a *creature on the desk*.
`MoshiBlob(host)` is a portable, self-contained component (canonical copy in this
experiment; 008/009 carry pastes per the artifact-portability rule): five smin-blended
lobes raymarched at third-res, **faceted normals** (flat low-poly light — the
Crash-era look), Bayer band shading, on-twos noise wobble. No glow anywhere; the
REC ember is a banded heart.

**Why it's fun (the actual spec).** It *watches your cursor* (eyes ride a gaze
vector), blinks on its own clock, **squashes-and-stretches on the beat** via a damped
spring (overshoot, never robotic), opens its mouth wider as things heat up, and when
poked it squishes deep, goes wide-eyed, and bristles for a second — indignant, then
forgiving. Personality through physics, not animation clips.

**States** (drive via `set()`): calm · listening · recording (ember + hot mouth) ·
feral (spike noise). Behaviors via `pulse(amount)` and `poke()`.

**House-style v2 compliance.** Faceted + dithered + on-twos like the world; crisp
DOM bracket eyes (PS2 games drew sharp HUD faces over chunky models — period-correct).

**Risks.** Three instances on one page = three GL contexts (fine at these buffer
sizes; production composites once). The blob's silhouette at 96px needs the arousal
ceiling clamped or facets mush — the workbench's CHIP size is the regression test.

**Steal even if killed.** The damped-spring squash as THE motion primitive for all
Mosh UI; gaze-tracking as ambient "it's alive" signal.
