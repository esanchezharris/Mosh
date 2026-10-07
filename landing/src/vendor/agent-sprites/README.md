# agent-sprites (vendored)

The splat: Moshi's face. This is a copy of `ui/src/vendor/agent-sprites/engine.js` from the
app, so the site draws the same creature the dock does. `landing/` is a standalone package and
cannot import across the monorepo, hence the copy; when the app's engine changes, copy it again.

`engine.js` is UMD with no ES exports: import it for its side effect and read
`globalThis.AgentSprites` (see `src/splat.ts`). Do not add a `package.json` here: one with
`"sideEffects": false` makes Rollup drop that import from the production bundle.

`TRUTH.md` holds the design truth for the stills. Do not re-derive proportions.
