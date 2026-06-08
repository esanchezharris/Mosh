# Mosh UI

React + Vite + TypeScript frontend for **Mosh**, bundled into a JUCE 8 WebView.

The UI couples to the C++ backend through exactly one seam (`src/bridge.ts`):

- `executeCommand(name, args) -> Promise<MoshResult>` — the only mutation path.
- the snapshot + events feed: `getSnapshot() -> Promise<Snapshot>` and
  `subscribe(listener)` for typed deltas.

No Tracktion/audio concepts live in the frontend. When `window.__JUCE__` is
absent (plain browser dev), the bridge falls back to an in-memory mock so the
app renders standalone and never crashes.

## Commands

```sh
npm install      # install deps
npm run dev      # browser dev with the mock bridge (Vite dev server)
npm run build    # type-check + bundle to dist/
npm run preview  # serve the built dist/ locally
```

`npm run build` emits a self-contained bundle to `dist/` with **relative** asset
URLs (`vite.config.ts` sets `base: "./"`), because the C++ JUCE `WebBrowserComponent`
loads `dist/index.html` from a local file path / embedded resource, not a web
server root.

## Layout

- `src/bridge.ts` — the seam: `MoshResult` / `Snapshot` / event types,
  `executeCommand`, `getSnapshot`, `subscribe`; JUCE vs mock transport.
- `src/store.ts` — dumb zustand store mirroring backend state.
- `src/App.tsx`, `src/main.tsx`, `index.html` — Stage 0 placeholder shell.

## JUCE wiring (later, module 03)

The JUCE 8 native-function registration and the C++→JS event emit API are marked
with `// VERIFY` comments in `src/bridge.ts`. Resolve those against the JUCE 8
`WebBrowserComponent` example when wiring the C++ bridge.
