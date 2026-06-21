# DAW information-architecture comparison — Phase 0

**Purpose:** ground the "minimal agent-first default layout" by studying how the four reference DAWs actually lay themselves out. Every claim traces to `SOURCES.md` (official manuals). This is the factual base for the Phase 1 design brainstorm — it does **not** prescribe the final design.

---

## 1. How each DAW lays out, by zone

| Zone | FL Studio | Ableton Live | Pro Tools | Logic Pro |
|---|---|---|---|---|
| **Top bar** | Main menu + Toolbar (transport, tempo, pattern/song) | Control Bar (transport, tempo, metronome) | Toolbar + rulers (Bars\|Beats, Timecode, Tempo, Markers) | Control bar (transport, displays) + Toolbar |
| **Left** | Browser (samples, generators, clips) — persistent column | Browser (library, devices, samples) — persistent | Edit window: **Tracks List** far left | Inspector + Library (contextual params, patches) |
| **Center** | **Playlist** window (arrangement of pattern/audio/automation clips) | **Arrangement** view (linear) **or** Session grid | **Edit** window timeline (track lanes, clips) | **Tracks area** (regions on horizontal lanes) |
| **Right** | — | — | Edit window: **Clips List** far right | — |
| **Bottom / drawer** | — (editors are separate windows) | **Detail/Device view** (selected track's devices + clip) | — (Inserts/I/O can be shown in Edit) | **Editors** drawer (Piano Roll / Audio / Step / Score) |
| **Mixer** | Separate **window** (F9) | Show/hide **panel** (View menu) | Separate **Mix window** (console) | Shows in the main window / separate |
| **Deep editors** (piano roll, automation, plugin UIs) | Separate **windows** (F7 piano roll) | In the bottom **Detail view** | In/over the Edit window | In the bottom **Editors** drawer |

## 2. What's *always on screen* vs *summoned* — the key axis

| | Always-on by default | Summoned on demand |
|---|---|---|
| **FL Studio** | Toolbar, Browser, Channel Rack, Playlist | Piano Roll (F7), Mixer (F9), plugin UIs — **window-toggle paradigm** |
| **Ableton** | Control Bar, Browser, one main view, Detail view | Mixer sections (show/hide), second view (Tab), plugin UIs |
| **Pro Tools** | One window at a time (Edit *or* Mix) | The other window, plugin UIs — **window-config paradigm** |
| **Logic** | Control bar, Tracks area | Inspector, Library, Editors drawer, Mixer — all **toggleable** |

**Takeaway:** *no* mainstream DAW shows everything at once. Mixer, piano roll, automation, and plugin editors are **summoned** in all four. The differences are only *how* (FL/PT = separate windows; Ableton/Logic = toggleable panels in one window).

## 3. The common denominator (intersection of all four)

A DAW's irreducible default is just **four zones**:

```
┌─────────────────────────────────────────────┐
│  TOP: control/transport bar (always)         │
├──────┬──────────────────────────────────────┤
│ LEFT │  CENTER: tracks/timeline (always)     │
│ brow │  track headers + clips on lanes       │
│ -ser │                                       │
│ (col-├──────────────────────────────────────┤
│ laps)│  BOTTOM: contextual detail/editor      │
│      │  (collapsible drawer)                  │
└──────┴──────────────────────────────────────┘
   Mixer · Piano roll · Automation · Plugin UIs  →  SUMMONED
```

Everything beyond top-bar + tracks-area is **optional and collapsible**.

## 4. Mosh today vs. the common denominator

Mosh's shell **already is** the common denominator (`ui/src/App.tsx` + `ui/src/ui/dock/DockShell.tsx`):
- **Top:** `Topbar.tsx` + `TopbarTools.tsx` ✅
- **Left:** `SampleBrowser.tsx` in a collapsible dock zone ✅
- **Center:** `Arrange.tsx` (tracks/timeline) ✅
- **Bottom:** `Dock.tsx` (plugin rack + generative drawer + Moshi) — collapsible ✅
- **Summoned:** `PianoRoll`, `PluginBrowser`, `AutomationPanel`, `Mixer` view, plugin editors ✅

So the **bones are right**. The gaps that block "simplest version of all of them":

1. **The default starts too full, not too empty.** Progressive disclosure is the thesis — but left + bottom docks aren't collapsed by default, and the topbar shows everything always.
2. **The topbar is the main clutter.** `TopbarTools.tsx` is 441 lines of always-visible controls (tools, zoom, snap, theme, layout, view, track-create…). This is the first thing to thin — push rarely-used controls into menus or agent-surfaced popovers.
3. **The `layout` template axis doesn't restructure zones.** `templates.ts` (Mosh/Ableton/FL) only swaps colors/keymaps/gestures/feel — it does **not** move panels. To make a real "Ableton template" / "FL template" / "Pro Tools template", `layout` must drive zone arrangement & default-collapsed state (e.g. FL → floating-window feel, Ableton → browser-left+detail-bottom docked, PT → Edit/Mix split, Logic → inspector-left+editor-drawer).
4. **No Pro Tools / Logic templates yet** — only Mosh/Ableton/FL exist as (color-only) templates.

## 5. The agent-first inversion (Emilio's thesis, made concrete)

Traditional DAWs keep controls on-screen because *you* have to find them. With an agent driving the session, the **default can be the empty intersection** and the agent (or a deliberate user gesture) **reveals** the right zone when it's relevant:

- Recording vocals → agent surfaces the input/meter strip, hides everything else.
- "Make the drums punchier" → agent surfaces the drum track's rack + the relevant plugin, not the whole mixer.
- Editing a melody → piano roll drawer opens on the selected clip; closes when done.

**Net Phase-0 finding:** this is **not** a rebuild. It's (a) ship a genuinely minimal *default* (docks collapsed, topbar thinned), (b) make `layout` drive real zone arrangement, (c) add Pro Tools + Logic templates, (d) define the agent's "surface-this-control" vocabulary. All zero-C++, behind the existing settings/skin seam.

---

## Open questions for the Phase 1 brainstorm
- How minimal is the *default* default? (Mosh skin = empty intersection, or a sensible "tracks + transport + collapsed browser"?)
- Faithful-recreation vs. spiritual-homage for the FL/Ableton/PT/Logic templates — how literal?
- Which controls are "always", which are "agent-surfaced", which are "user-summoned (menu/shortcut)"?
- Do templates change *gestures/keymaps* too (already supported) or *only* layout?
