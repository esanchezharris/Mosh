# Classic-Shell Audit — Inventory (B-PR0)

*Evidence gathering only. The decision (freeze-and-sever vs port-and-archive) is the
owner's — see [RECOMMENDATION.md](RECOMMENDATION.md). The e2e migration bill and the
REACHABILITY scan live in [SPEC-MIGRATION.md](SPEC-MIGRATION.md). Every claim below was
verified against source at the audit commit (branch `claude/auto-wave1-classic-audit`,
based on `52759cae`), with file:line citations.*

---

## 1. Module-graph diff

**Method.** The walker from [`ui/src/agent/uiReachability.test.ts`](../../ui/src/agent/uiReachability.test.ts)
(`moduleGraph`, lines 88–105: relative static/side-effect/dynamic imports, resolved the way
Vite/TS would) was re-run as a one-off script (not committed, per task instructions):
`moduleGraph(AppLegacy.tsx)` minus `moduleGraph(AppV2.tsx)`.

**Raw diff** (no boundary): legacy graph **139** modules, v2 graph **170**, shared **126**,
classic-only **13** (1,075 LOC):

| LOC | classic-only module |
|----:|---|
| 146 | `ui/src/AppLegacy.tsx` |
|  55 | `ui/src/settings/layoutPresets.ts` |
|  57 | `ui/src/ui/Inspector.tsx` |
|  57 | `ui/src/ui/Mixer.tsx` |
|  37 | `ui/src/ui/MonsterChanges.tsx` |
|  71 | `ui/src/ui/Participants.tsx` |
| 151 | `ui/src/ui/PluginBrowser.tsx` |
|  32 | `ui/src/ui/PresenceCluster.tsx` |
|  58 | `ui/src/ui/SectionNavigator.tsx` |
|  16 | `ui/src/ui/SessionRail.tsx` |
| 206 | `ui/src/ui/Topbar.tsx` |
|  92 | `ui/src/ui/dock/DockShell.tsx` |
|  97 | `ui/src/ui/dock/useDockLayout.ts` |

**Effective diff** (the one that matters): the raw diff undercounts, because v2 imports four
*presentational* exports (`ClipWave`/`ClipMidi`/`ClipDrumGrid`/`isDrumClip`,
[`v2/lanes/ClipView.tsx:29`](../../ui/src/v2/lanes/ClipView.tsx)) from classic's
`ui/Arrange.tsx`, which drags Arrange and its exclusive subtree into the "shared" set.
`uiReachability.test.ts` declares exactly this boundary (`CLASSIC_ONLY_MODULES`, lines
77–83) and stops the v2 walk at `ui/Arrange.tsx`. Re-running the diff with that boundary
applied adds the Arrange-exclusive subtree — **17 modules, 1,285 LOC total**:

| LOC | additional effective-classic-only module | why |
|----:|---|---|
| (821) | `ui/src/ui/Arrange.tsx` | whole file classic-rendered; v2 takes only the 4 canvas/SVG renderers (test comment, lines 73–83). Not counted in the 1,285 because 4 exports ARE live in v2. |
|  94 | `ui/src/ui/AnnotationRuler.tsx` | only importer is Arrange |
|  57 | `ui/src/ui/RemotePlayheads.tsx` | only importer is Arrange |
|  41 | `ui/src/ui/TrackFxDrawer.tsx` | only importer is Arrange |
|  18 | `ui/src/ui/laneLayout.ts` | only importer is Arrange |

So the sever surface is **17 modules / ~1,285 LOC of exclusively-classic code, plus the
~800 classic-only lines of `Arrange.tsx`** (whose 4 presentational exports would need a
new home, e.g. a `clipRenderers.tsx`, before Arrange can be deleted).

**Shared set** (126 modules) is dominated by: the whole `agent/` tree, `store.ts`, the
`interaction/` layer, `settings/` (schema/store/effects/templates/SettingsPanel), the
generative surfaces (`ui/Dock.tsx` Rack + GenDrawer, `ui/ExportControls.tsx`,
`ui/PianoRoll.tsx`, `ui/DrumSequencer.tsx`, `ui/AutomationPanel.tsx`, `ui/SampleBrowser.tsx`,
`ui/MultiplayerPanel.tsx`), and `webrtc/`. These are *v2 dependencies*, not classic debt —
they survive any sever untouched.

**Maintenance-cost datapoint.** Classic-only files are still being touched: last commits
`AppLegacy.tsx` 2026-07-25; `Topbar.tsx`, `PluginBrowser.tsx`, `SectionNavigator.tsx`
2026-07-17 (`git log -1 --format=%as`). Classic is not currently free.

---

## 2. Behavior inventory — classic-unique vs v2

Hypotheses from planning were re-verified against the tree; two were **wrong in detail**
(noted inline). Verdicts marked **OWNER** need the owner's call; the rest have a clear
disposition the owner can veto.

| # | Classic-unique behavior | Classic source | v2 equivalent | Verdict |
|---|---|---|---|---|
| 1 | **Mixer view** — all-tracks console (strip per track + master strip), entered via the Arrange/Mixer `ViewToggle` | [`ui/Mixer.tsx`](../../ui/src/ui/Mixer.tsx); toggle `ui/Topbar.tsx:141–152`; mount `AppLegacy.tsx:113–116` | Per-track **superset** in the Inspector Mix tab — rename/vol/pan/output/MIDI-in/input-monitor/mute/solo/sends ([`v2/inspector/Inspector.tsx:78–125`](../../ui/src/v2/inspector/Inspector.tsx)); master vol/pan/meter/rack in `MasterCard` ([`v2/RightRail.tsx:86–116`](../../ui/src/v2/RightRail.tsx)); per-lane M/S (`v2/lanes/TrackLaneList.tsx:404–410`); meters (`TrackMeterBar`). **Missing:** the all-tracks-at-once console *glance* | **OWNER** — is a side-by-side console view a port item, or is per-track disclosure the v2 position? |
| 2 | **DAW layout templates** — `layout` setting restructures the dock to a DAW's resting shape | [`settings/layoutPresets.ts`](../../ui/src/settings/layoutPresets.ts); applied only at `AppLegacy.tsx:61–83` | **None, deliberately** — v2 hides the whole Layout/Interaction/Feel/Keys categories + skin + TemplatePicker (`settings/SettingsPanel.tsx:290–305`): "v2 is a single Mosh-native design with no skin/keymap/gesture/layout axis" | Freeze with classic (consistent with v2's stated design) |
| 3 | **Resizable, persisted panels** — drag dividers, collapse, sizes persisted (`mosh.dockLayout`) | [`ui/dock/DockShell.tsx`](../../ui/src/ui/dock/DockShell.tsx), [`ui/dock/useDockLayout.ts`](../../ui/src/ui/dock/useDockLayout.ts). *Planning called this "drag-dockable panels" — it is not: zones are fixed, only resize/collapse* | Boolean push-docks only — `v2/shellState.ts` has `browserOpen`/`rightOpen`, **no size state**; no divider anywhere in `v2/` | **OWNER** — v2's capped-centered stage is a design position; panel resize is a plausible port item |
| 4 | **Inline take lanes in the arrangement** — stacked, per-take auditionable lanes inside the clip footprint | `ui/Arrange.tsx:507` (`deriveTakeLanes`) | Inspector **Takes tab only** (`v2/inspector/Inspector.tsx:596`); same pure helper ([`ui/takeLanes.ts`](../../ui/src/ui/takeLanes.ts) is shared). Already recorded as "a presentation gap with no unreachable command behind it" — [`agent/commandClassification.ts:204–211`](../../ui/src/agent/commandClassification.ts) | **Port candidate #1** (pre-named by planning; the recorded note agrees) |
| 5 | **Toolbar: modal tool segment (move/split/range)** | `ui/Topbar.tsx:178–183` | **Verified: zero `setTool` call sites in `ui/src/v2/`** (grep; only `menuActions.ts`/`store.ts`/`ui/Topbar.tsx` outside it, and the `tool_*` actions have no native-menu items — they exist only as rebindable *keyboard* actions, `settings/schema.ts:269–270`). v2 is deliberately non-modal (`v2/lanes/ClipView.tsx:8–10`): split = context-menu "Split here" (`ClipView.tsx:281`), range = shift-drag on `BarRuler` | Deliberate rewrite — freeze. (A keyboard user can still switch the shared `tool` state in v2; harmless.) |
| 6 | **Toolbar: snap toggle + snap-division select** | `ui/Topbar.tsx:185–191` | **None. Real gap.** No `setSnap`/`setSnapDivision` call anywhere in `v2/` (grep); v2 only *reads* `snapDivision` for the Clip-tab nudge step (`v2/inspector/Inspector.tsx:326`). v2 drags always snap with the store defaults (`snap: true`, `1/4` — `store.ts:294–295`); a mouse-only v2 user can never disable snap or change the grid | **Port candidate #2** |
| 7 | **Toolbar: continuous zoom slider (20–400 px/s)** | `ui/Topbar.tsx:193–197` | Coarse 3-stop fit only — `ZoomToggle` 8b/16b/Full (`v2/lanes/TrackLaneList.tsx:153`, `fit()` 84–91). *Planning implied "no v2 zoom" — wrong: a coarse affordance exists* | **Port candidate #3** (finer zoom), severity lower than #6 |
| 8 | **MonsterChanges** — modal Keep/Undo review panel for agent batches | [`ui/MonsterChanges.tsx`](../../ui/src/ui/MonsterChanges.tsx) | [`v2/ChangeToast.tsx`](../../ui/src/v2/ChangeToast.tsx) — self-dismissing toast, hover-pauses, auto-dismiss = keep; its header names itself the deliberate replacement (lines 1–5) | Deliberate rewrite — freeze |
| 9 | **SectionNavigator** (redesign-classic minimap) | [`ui/SectionNavigator.tsx`](../../ui/src/ui/SectionNavigator.tsx) | `v2/timeline/SectionRibbon.tsx` (create/rename/remove sections) + SongNav + `sectionZoom` — covered by `v2-sections.spec.ts` | Superseded — freeze |
| 10 | **Classic plugin-browser modal** | [`ui/PluginBrowser.tsx`](../../ui/src/ui/PluginBrowser.tsx) | `v2/PluginBrowser.tsx` `PluginDock` in the left drawer ("no plugin MODAL in v2", header lines 1–11). **Stale-comment finding:** `ui/PluginBrowser.tsx:7–9` claims `PluginBrowserContent` "backs both the classic modal and the v2 left-drawer Plugins tab" — false; v2 imports only `pluginBrowserUtil`, and v2's own header says the classic modal is untouched. The real reuse is the util layer | Superseded — freeze (fix or delete the stale comment with the sever) |
| 11 | **SessionRail / classic Inspector / Participants / PresenceCluster** (redesign-classic right rail) | `ui/SessionRail.tsx`, `ui/Inspector.tsx`, `ui/Participants.tsx`, `ui/PresenceCluster.tsx` | `v2/RightRail.tsx` (MoshCard + Inspector + MasterCard + CollaboratorsCard with camera/video tiles/invite, lines 241–246) + `PresenceMeter` | Superseded — freeze |
| 12 | **AnnotationRuler** | `ui/AnnotationRuler.tsx` (Arrange-only import) | `v2/timeline/AnnotationLane.tsx` (create/edit/move/remove — header lines 1–9), covered by `v2-annotations.spec.ts`. **Stale-comment finding:** `uiReachability.test.ts:40–42` still describes the annotation commands' "only call site" as classic's AnnotationRuler — true when written, false now | Superseded — freeze |
| 13 | **TrackFxDrawer / RemotePlayheads / laneLayout** | Arrange-only imports | FX tab reuses the shared `Rack` (`v2/inspector/Inspector.tsx:66`); collaborator markers live in v2's SongNav | Superseded — freeze |

---

## 3. Settings inventory

| Setting | Definition | Consumers | Recommendation |
|---|---|---|---|
| `uiShell` | [`settings/schema.ts:188–207`](../../ui/src/settings/schema.ts), enum classic/v2, **default `v2`**, category "Layout" | `App.tsx` routes shells on it (line 41); v2's escape hatch is the overflow-menu item "Switch to Classic UI" (`v2/TopBar.tsx:253`) — necessary because v2's SettingsPanel hides the whole "Layout" category *including this setting* (`SettingsPanel.tsx:293`); classic shows the "Interface" row, which is the way back | **Keep** while classic exists. On sever: retire the enum + the TopBar item + `shellQuery/shellFlag` plumbing (own PR) |
| `redesignShell` | `settings/schema.ts:179–187`, bool, default true | Classic-internal variant switch only: `AppLegacy.tsx:50`, `ui/Topbar.tsx:18`, `ui/TopbarTools.tsx:127`, `ui/Dock.tsx:20`, `ui/Moshi.tsx:308`, `ui/Arrange.tsx:83,362` — plus one shared guard, `store.ts:545` (`redesignShell \|\| isV2Active()` gates `webrtc_signal`) | **Freeze-with-classic**; on sever, simplify `store.ts:545` to the v2 check and retire |
| `layout` | `settings/schema.ts:161–178`, enum of 5 DAW presets | Applied only at `AppLegacy.tsx:61–83` via `layoutPresets.ts`; hidden in v2's panel (category "Layout") | **Freeze-with-classic**; retire with classic |
| `skin` | `settings/schema.ts:55–72`, enum of 5 skins | `settings/effects.ts:29–33` — **pinned to `mosh` whenever v2 is active** (persisted non-mosh skins cannot leak into v2); hidden in v2's panel (`SettingsPanel.tsx:294–295`); also bundled by templates (`TemplatePicker` is classic-only, `SettingsPanel.tsx:305`) | **Freeze-with-classic**; retire with classic (with the Interaction/Feel/Keys template axes, same hidden set) |

**Note:** `theme` is NOT classic-coupled (v2 toggles it in the overflow menu) and is out of
scope. The Interaction/Feel/Keys categories are hidden in v2 alongside Layout
(`SettingsPanel.tsx:293`) — the keyboard *rebinding* they configure still functions in v2
via the shared `useKeyboardShortcuts`; only the classic-facing configuration UI is hidden.
A sever pass must decide per-category whether the settings die or get a v2 surface.

---

*Continue to [SPEC-MIGRATION.md](SPEC-MIGRATION.md) (the e2e bill) and
[RECOMMENDATION.md](RECOMMENDATION.md) (the decision memo).*
