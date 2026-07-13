# Prompts

The live prompt used to summon model designers is built in
[`src/models/prompts.ts`](../src/models/prompts.ts) (`buildMessages`). It composes:

- a **system** prompt casting the model as an elite designer auditioning for Mosh,
- the **two-pass brief** — `elevate` (keep the identity, make it exquisite) or
  `bolder` (push it, but lime + MOSH stay),
- the **target brief** (what to render: whole shell, waveform, composer, …),
- strict **output rules** (HTML fragment / GLSL only, self-contained, no fences),
- and, for HTML, the **injected Mosh tokens** so `var(--v2-*)` resolves in the candidate.

Edit `prompts.ts` to tune tone or add targets — it's the single source of truth so the
Arena and any future scripted runs stay in sync.
