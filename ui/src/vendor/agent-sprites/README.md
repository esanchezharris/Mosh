# agent-sprites

Drop-in splat body for Emilio’s multiplayer app. Clock-free engine: you own `t`. Copy this `pkg/` folder into any app — no build step required.

Hero palettes: **encre** (`#1B1D1C`) and **creme** (`#F3EDE4`). Draw defaults are **transparent paper, flat fill, no drop shadow**. The parent owns the background.

## Copy into an app

```
your-app/
  vendor/agent-sprites/     ← this folder
    engine.js
    index.cjs
    index.esm.js
    index.mjs
    index.d.ts
    package.json
    react/
```

Point imports at the folder (`./vendor/agent-sprites` or a file: dependency). Bundlers pick `index.esm.js`; Node CJS picks `index.cjs`.

## Script tag

`engine.js` is UMD. It attaches `AgentSprites` on `window`.

```html
<script src="./vendor/agent-sprites/engine.js"></script>
<script>
  const { sample, drawCanvas, createEngine, toSVG } = AgentSprites;
</script>
```

## Canvas + createEngine

The clock lives in the caller. No `Date.now` inside the engine.

```js
import { createEngine, drawCanvas } from "./vendor/agent-sprites/index.esm.js";

const bot = createEngine({ colorway: "encre", state: "idle", seed: 0 });
const ctx = canvas.getContext("2d", { alpha: true });

function frame(now) {
  const t = now / 1000;
  bot.setState(player.state, t); // no-op if already that state
  ctx.clearRect(0, 0, size, size);
  drawCanvas(ctx, bot.sample(t), {
    size,
    paper: "transparent",
    flat: true,
    shadow: false,
    pad: 0.28,
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

Or sample without a handle:

```js
const frame = sample(t, {
  colorway: player.colorway,
  state: player.state,
  prevState,
  changedAt,
  seed: player.id,
});
drawCanvas(ctx, frame, { size: 128, x: player.x, y: player.y });
```

## React

```jsx
import { SplatAgent } from "./vendor/agent-sprites/react";

<SplatAgent
  colorway="encre"
  state={player.state}
  seed={player.id}
  size={64}
  onClick={onSelect}
/>
```

`SplatAgent` creates one `createEngine` per mount, runs rAF, and calls `setState` / `setColorway` when those props change. Pass `reducedMotion` to freeze the loop on a still.

## Figma plugin

- **Stills** — `toSVG(sample(t, world), { size: 128, paper: "transparent", flat: true, shadow: false })` returns an SVG string. Drop it into a node.
- **Live** — same `createEngine` + `drawCanvas` loop on a plugin `<canvas>`. The engine has no DOM clock; the plugin owns `t`.

## World fields

`sample(t, world)` is a pure function of `t` plus this declared pose:

| field | type | meaning |
|---|---|---|
| `colorway` | id or row | palette (`encre`, `creme`, …) |
| `state` | string | current pose (`idle`, `laugh`, …) |
| `prevState` | string | pose we are morphing from |
| `changedAt` | seconds | sample time of the last state change |
| `seed` | number | desync blinks / gaze / catalogue phase |
| `morphDur` | seconds | override morph length |
| `mouthOpen` | 0..1 | override laugh D opening |
| `reducedMotion` | boolean | freeze idle lobe orbit |

`createEngine({ colorway, state, seed })` keeps that history on a handle: `setState(next, t)`, `setColorway(id)`, `sample(t)`, `getState()`.

## Draw defaults

`toSVG` and `drawCanvas` share the same paint:

| opt | default | note |
|---|---|---|
| `paper` | `"transparent"` | sprite never paints a page fill |
| `flat` | `true` | solid body, **no sheen / gradient** |
| `shadow` | `false` | no drop shadow |
| `pad` | `0.34` (`0.28` in `<SplatAgent>`) | inset around the silhouette |
| `size` | `256` canvas / `512` SVG | box in CSS pixels |
| `x`, `y` | `0` | canvas top-left of the sprite box |

Pass `flat: false` / `shadow: true` only for the studio. Product UI stays flat.

## Colorways

Heroes:

| id | body | accent | void |
|---|---|---|---|
| `encre` | `#1B1D1C` | lime mouth | `#070709` |
| `creme` | `#F3EDE4` | dark mouth | `#2A1418` |

Also: `carnaval`, `fools`, `block`, `sea`, `exhalation`, `cruller`, `sanctuary`, `bodega`, `wallet`, `passage`. See `COLORWAYS` / `COLORWAY_BY_ID`.

## Don'ts

- **No sheen.** Leave `flat: true`. Do not turn on the radial highlight in product.
- **Parent owns the background.** Paper is transparent. Never let the sprite fill the page.
- **Don't put a clock in the engine.** You pass `t`. The engine does not call `Date.now` or `requestAnimationFrame`.
- **Don't skip `t` on `setState`.** `setState(state, t)` needs the sample time of the change so the morph eases from that instant.
