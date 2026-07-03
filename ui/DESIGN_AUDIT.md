# Mosh AppV2 — Design-System & UX Audit (Phase 1, read-only)

*2026-07-03 · branch `claude/design-audit-phase1` (cut from `main` @ `f1925292`) · scope: `ui/src/v2/*` + the token system in `ui/src/ui/mosh.css` + the shared floating-editor chrome (`ui/src/ui/dock/`). No code was changed in this phase. Every file:line claim below was either grep-verified or read directly; the five most load-bearing claims were re-verified by hand, and the headline bug was confirmed visually in the running app.*

---

## 0. Headline findings

1. **Verified product bug — the playhead is drawn 44 px right of the truth.** `geom.ts` says `HEAD_W = 212 // must match --v2-head-w in shell.css` ([geom.ts:9](src/v2/timeline/geom.ts)), but the cream redesign (#139) changed the token to `--v2-head-w: 168px` ([shell.css:11](src/v2/shell.css)) without updating the JS mirror. The playhead paints at `left: HEAD_W + pos*pxPerSec` inside the `.v2-tl` grid whose header column is the CSS token ([Playhead.tsx:12](src/v2/timeline/Playhead.tsx), [shell.css:295-300](src/v2/shell.css)), so it rides a constant 44 px late at every zoom; zoom-to-fit ([TrackLaneList.tsx:47](src/v2/lanes/TrackLaneList.tsx)) is off by the same delta, and `LANE_H = 92` (CSS: 64px) is a dead-but-misleading constant. Confirmed in a screenshot: at transport 1.1.1 the lime line slices through the first clip instead of sitting on bar 1. *This is exactly the failure mode the "single source of truth" principle exists to prevent — a JS mirror of a CSS token with a "must match" comment is drift by construction.* (Spun off as a background task chip.)
2. **The v2 shell is not on the skin axis at all — by design.** `settings/effects.ts:21` pins `data-skin="mosh"` whenever v2 is active, and shell.css declares "Theme axis only — no skin axis" (shell.css:5-6). The `--v2-*` vocabulary (~38 tokens, [shell.css:9-99](src/v2/shell.css)) is a **fork**, not a bridge: raw hex/rgba definitions with their own `[data-theme="light"] .v2-shell` override block. So today the "works across all 4 skins" bar only reaches the classic shell and the shared components v2 mounts (FloatingWindow, SampleBrowser, Rack/GenDrawer). **A strategic decision is needed before Phase 2** — see §1.3.
3. **The v2 TSX layer is exemplary; the drift is concentrated in CSS.** All of `ui/src/v2/*.tsx` contains exactly **one** hex literal ([SectionRibbon.tsx:19](src/v2/timeline/SectionRibbon.tsx)), zero `rgba(`, and 19 `style={{}}` uses of which all but one carry runtime geometry/data (the exception: a magic `zIndex: 55` backdrop, [TopBar.tsx:151](src/v2/TopBar.tsx)). shell.css routes ~89 % of color decisions through tokens (317 `var()` refs vs ~38 raw color literals in rule bodies) — good, but the raw 11 % includes skin/theme-hazardous duplicates (§4).
4. **mosh.css is genuinely strong on color and weak everywhere else.** A layered palette (primitives → derived tones → semantic accents), five skin blocks (including a **fifth skin, `logic`**, mosh.css:159 — the brief said four), documented cascade math for `[data-skin]×[data-theme]`, and 445 `var()` uses. But there is **no scale** for font-size (121 hardcoded declarations), spacing (13 ad-hoc gap values), radius (62 declarations/17 values), shadows (copy-pasted triplets), durations, or z-index (two hand-managed stacks) — and the only easing tokens are trapped inside `.app[data-redesign="on"]` (mosh.css:569-571) while being consumed globally with a silent fallback (mosh.css:310).
5. **One component ships with no stylesheet at all.** The LyricPanel's `.v2-lyric-*` class family has **zero rules in any CSS file** — the Lyrics tab renders an `<ol>` with default list styling and default white browser inputs on the dark card (confirmed visually). The ghost-line input also hijacks Shift+Tab into a mutating accept ([LyricPanel.tsx:180](src/v2/inspector/LyricPanel.tsx), no `shiftKey` check).
6. **Storybook is installed but empty.** Exactly one story exists (`src/ui/RemotePlayheads.stories.tsx`) — not even a v2 component. The requested "whole system on one page" audit surface doesn't exist yet; seeding it is a Phase-2 roadmap item. This audit's visual pass used the Vite dev app (mock backend) instead.

---

## 1. Architecture: two token systems, one screen

### 1.1 mosh.css (classic + shared) — the real design system

- **Primitives** `--ink/--lime/--bone/--mist` + derived tones (`--ink-raise/-deep/-line/-line-soft`, `--lime-dim/-faint`, `--bone-dim`) at mosh.css:11-23.
- **Semantic layer**: `--rec/--warn/--mute/--danger(-deep/-line)` (:26-31) and `--on-accent` (:32-33, text-on-bright-fill that stays dark in both themes) — genuinely good.
- **Skins**: baseline = mosh; each alternate skin is one ~14-token override block — ableton (:81), fl (:107), protools (:133), **logic (:159)** — with combined `[data-skin][data-theme="light"]` blocks and an in-file explanation of the specificity math (:73-78). A component opts into skin-correctness simply by using `var()` — no registration.
- **Fonts**: `--font-display/--font-body/--font-mono` (:35-37), consumed by both shells; NanumSquareRound base64-inlined for the JUCE WebView (`src/fonts/nanum.css`).
- **Fragilities**: token names are mosh-brand literals (`--lime` is amber under ableton, azure under logic — nothing signals "accent", inviting the raw-lime drift that exists at mosh.css:334/:365/:406); the semantic accents are never remapped per skin; light-theme lime-as-text needs a per-class escape-hatch list (:63-67) because there is no `--accent-text` token.

### 1.2 shell.css (v2) — a deliberate fork

Scoped under `.v2-shell` (never touches `:root`), ~38 `--v2-*` tokens: geometry (:11-18), dark palette (:23-54), light/cream override (:70-99). It consumes exactly **five** mosh.css tokens: the three fonts, `--mute` (with a duplicated hex fallback, :396), and nothing else. Duplications vs mosh.css:

| shell.css | mosh.css | delta |
|---|---|---|
| `--v2-rec: #ff3b5c` (:42) | `--rec: #ff3b5c` (:26) | byte-identical |
| `--v2-accent: #ccff36` (:33) | `--lime: #ccff23` (:12) | two near-identical limes |
| `--v2-accent-ink: #0a0f04` (:34) | `--on-accent: #0b0b0b` (:33) | same role, different value |
| `--v2-head-w/lane-h/ruler-h: 168/64/24px` (:11-14) | `--head-w/lane-h/ruler-h: 208/76/30px` (:39-41) | same names, different values |

The isolation was a sound migration tactic (both bundles coexist; classic untouched; the swappable-seam gate held). The cost is a growing pile of parallel decisions and the geom.ts class of bug.

### 1.3 ⚠️ Decision needed: skins in v2

The stated bar — "every change must work across all 4 skins + light/dark" — is currently **unreachable in v2 by construction** (the pin at effects.ts:21 exists precisely so persisted non-mosh skins can't leak into a shell that has no skin blocks).

- **Option A (recommended for now): keep the pin, declare the contract.** V2's bar = dark × light within `--v2-*`; the 4-skin bar applies to classic + shared components (FloatingWindow, SampleBrowser, Rack/GenDrawer, PianoRoll/DrumWindow — which already ride mosh.css tokens and stay skin-correct). Cheap, honest, matches the shipped behavior. The Phase-2 token work below is designed to be Option-B-compatible later.
- **Option B: bridge the fork.** Redefine `--v2-*` in terms of mosh.css tokens (e.g. `--v2-accent: var(--lime)`) and add per-skin blocks. Real work (the cream light theme is a *design*, not a remap — e.g. dark cards on cream ground), only worth it if multi-skin v2 is a product goal.

Either way, **semantic aliasing** (Phase 2) reduces the fork's cost: introduce role-named tokens (`--accent`, `--accent-ink`, `--status-rec`, `--status-ok`…) that each shell maps onto its palette, so shared/new components can be written against roles.

---

## 2. Component inventory

Verdicts: **clean** = tokens/classes only · **mostly-clean** = isolated drift · **mixed** = real drift, systemic causes · **drifted** = needs a dedicated pass.

| Component | Purpose | Styled by | Verdict |
|---|---|---|---|
| [AppV2.tsx](src/v2/AppV2.tsx) (77) | Shell frame/router: TopBar (gated on snapshot) · errbar · body (nav+stage+Composer ∥ RightRail) · LeftDrawer overlay · floating mounts | shell.css classes only; zero inline styles | **clean** (frame-level UX gaps live here: §5.4, §5.9) |
| [shell.css](src/v2/shell.css) (797) | The entire v2 stylesheet + token fork | — | **mixed** (§4; well-commented, strong focus/reduced-motion coverage) |
| [shellState/Flag/Query .ts](src/v2/shellState.ts) | UI-local view state; shell resolver; dev override | no styling | **clean** — but 3 dead fields (`inspectorOpen`, `railCollapsed`, `activityOpen`: 0 consumers anywhere) and `browserOpen` name-collides with the classic store's unrelated `browserOpen` (store.ts:71) |
| [TopBar.tsx](src/v2/TopBar.tsx) (167) + [MoshMark](src/v2/MoshMark.tsx) | Brand · key/tempo/meter chips · transport · readout · AI pill · invite · tools · overflow | shell.css §TOPBAR; 1 inline `zIndex: 55` (:151) | **mostly-clean** (UX: §5.6, §5.10) |
| [ChangeToast.tsx](src/v2/ChangeToast.tsx) (50) | Transient agent-batch summary + Undo, 4.5 s timer | shell.css :609-638 | **mostly-clean** (UX: §5.7) |
| [Composer.tsx](src/v2/Composer.tsx) (26) | Prompt bar: thin wrapper reusing classic `AgentComposer` + `FileOptions` | shell.css §COMPOSER + compat shims (`.fo-trigger` :554, `.v2-tools .btn` :196) | **clean** (the seam styling lives in CSS shims — see §4.4) |
| [LeftDrawer.tsx](src/v2/LeftDrawer.tsx) (46) | Pull-tab dock: SOUNDS (classic SampleBrowser) / PLUGINS tabs; good ARIA (region/tablist/aria-expanded) | shell.css :566-602 | **mostly-clean** component; **drifted** CSS (magic 92/96/336 px geometry, missing backdrop blur — §4.3, §5.4) |
| [PluginBrowser.tsx](src/v2/PluginBrowser.tsx) (156) | Two-pane windowed plugin dock + favorites | shell.css :640-701; `ROW_H = 48` TS constant hand-synced with CSS row internals (:21) | **mostly-clean** (UX: disabled rows when no track selected are tooltip-only) |
| [RightRail.tsx](src/v2/RightRail.tsx) (114) + [PresenceMeter](src/v2/PresenceMeter.tsx) | Mosh card (Moshi + status) · Inspector · Collaborators (video tiles, invite) | shell.css §RIGHT RAIL; 1 justified inline (`background: p.color` :99) | **mostly-clean** (unconditional LIVE badge :30; PresenceMeter `aria-hidden` with no text equivalent; idle constant 0.18 duplicated JS↔CSS) |
| [TrackLaneList.tsx](src/v2/lanes/TrackLaneList.tsx) (218) | Sticky-header timeline grid; `--lvl` rAF glow feed; shrink-wrap `--v2-stage-h` calc | shell.css §BODY; inline = runtime geometry (good pattern) | **mostly-clean** (magic `+16px` tail in the calc :123; M/S hit targets §5.8) |
| [ClipView.tsx](src/v2/lanes/ClipView.tsx) (197) | Clip: drag/trim/menu; canvas waveform/MIDI via **classic Arrange renderers** | shell.css :406-434 | **mixed** — pointer-only (§5.2); classic canvas hardcodes violet notes `rgba(180,108,255)` (Arrange.tsx:738/:771 — theme/skin-blind, visible in v2); orphaned clip tokens §4.2 |
| [BarRuler.tsx](src/v2/timeline/BarRuler.tsx) (33) | Bar lines/numbers, click-seek | shell.css; inline = positions | **clean** (`.v2-ruler-bar.cur` styled but never rendered — dead affordance) |
| [SectionRibbon.tsx](src/v2/timeline/SectionRibbon.tsx) (193) | Song sections: create/rename/resize | shell.css :304-347 + **hardcoded `SEG_COLORS` hex array :19** (the one TSX hex); `EDGE_PX = 7` local while clips use `liveFeel().edgeGrabPx` | **drifted** (also §5.2, §5.10) |
| [Playhead.tsx](src/v2/timeline/Playhead.tsx) (13) | Transport line | shell.css :438-444 + `HEAD_W` from geom.ts | **drifted** — the §0.1 bug |
| [Inspector.tsx](src/v2/inspector/Inspector.tsx) (116) | Tabbed door: Mix/FX/Gen/Lyrics(+MIDI/Takes); FX/Gen **reuse classic Rack/GenDrawer** | shell.css §RIGHT RAIL (all classes present) | **clean** (returns `null` with no track → §5.5) |
| [LyricPanel.tsx](src/v2/inspector/LyricPanel.tsx) (313) | Lyric sheet: constraints, gap-fill, ghost line, flow-viz, skeleton grid | **`.v2-lyric-*`: no CSS anywhere**; falls back to classic `.btn`/`.rack-empty` + browser defaults | **drifted** — §5.3 |
| [FloatingWindow](../src/ui/dock/FloatingWindow.tsx) + [DockShell](../src/ui/dock/DockShell.tsx) (shared) | Draggable/resizable window chrome for PianoRoll/DrumWindow/AutomationPanel | mosh.css :861-867, all classic tokens → **skin-correct** | **mostly-clean** (hardcoded shadow `0 18px 50px`, ad-hoc 12px radius, magic z-70; `role="dialog"` with **no focus trap and no Escape** — grep: zero focus/escape handling in the dock layer) |

---

## 3. Token-system gaps (axis by axis)

| Axis | Coverage | Evidence | Phase-2 proposal (derived from de-facto values) |
|---|---|---|---|
| Color | **systematic** | §1.1; 445 `var()` in mosh.css, ~89 % token-routed in shell.css | Add semantic roles: `--accent-text` (kills the light-theme escape-hatch list mosh.css:63-67), `--status-ok`, and per-skin remaps for `--rec/--warn/--mute/--danger` |
| Typography | **partial** | Families tokenized (mosh.css:35-37); **no size scale**: 121 hardcoded font-sizes in mosh.css (39×11px, 30×10px, 18×12px, 12×9px, 10×13px, 5×8px), 67 in shell.css | `--text-2xs:9 · xs:10 · sm:11 · md:12 · base:13 · lg:15 · title:17 · time:20px` + `--tracking-caps: 0.14em` for the recurring uppercase-label treatment |
| Layout/sizing | **partial** | Core geometry tokenized in both files; magic cross-component offsets: drawer `top:92px/bottom:96px/336px×2` (shell.css:567-568), toast `bottom:92px` (:610), topbar height bare `64px` (:115) | `--v2-topbar-h`, `--v2-drawer-w`; derive offsets via `calc()` so the conditional errbar (§5.4) stops breaking alignment |
| Spacing | **ad-hoc** | One token (`--v2-gap:14px`, used 2× — and `.v2-topbar` hardcodes `gap:14px` at :114 anyway); gaps cluster identically in both files (8>6>4>5>10px) | `--space-1..8: 2/4/6/8/10/12/14/18px`; stray 5/7/9px round to neighbors invisibly |
| Radius | **ad-hoc** | shell.css defines 2 tokens, consumes them 6×, hardcodes ~43 others (incl. `10px` where `--v2-radius-sm` *is* 10px, :375); mosh.css: 62 declarations/17 values, 0 tokens | `--radius-xs:4 · sm:6 · md:8 · lg:11 · xl:14 · panel:16 · pill:999px` |
| Elevation | **partial** | `--v2-shadow/--v2-glow` exist and are theme-remapped (:43-44/:90-91) but ad-hoc shadows persist beside them (:409,:598,:227); mosh.css has 0 shadow tokens and copy-pastes `0 12px 40px rgba(0,0,0,0.5)` at :312/:758/:962 | `--shadow-lift / --shadow-pop / --shadow-float` (float unifies with `--v2-shadow` and floatwin's :861) |
| Motion | **partial** | `--ease-out/--ease-back` trapped in `.app[data-redesign="on"]` (mosh.css:569-571) with a global consumer falling back silently (:310); house curve `cubic-bezier(0.22,1,0.36,1)` hardcoded 13×+1; shell.css uses 8 duration/easing combos (90ms×8 … 240ms×3 different easings) | Hoist to `:root`: `--ease-house/--ease-out/--ease-spring` + `--dur-instant:90 · fast:120 · base:140 · gentle:160 · enter:240ms` |
| Z-index | **ad-hoc** | Two interleaved hand-managed stacks: mosh 0-6/40/50/60/70/**200**; shell 2-7/30/31/**55 (in JS!, TopBar.tsx:151)**/60/80/85/90; the 31-over-30 dependency is documented in a comment because no token can express it (shell.css:542) | One shared ladder `--z-lane/sticky/corner/overlay/overlay-above/chrome-fx/modal/pop/float/drop/toast/ctxmenu`; retire the 200 |
| Focus ring | **partial** | Both shells hand-build the same 2px/2px ring (mosh.css:896-903, shell.css:703-717) — but **v2 has no light-theme contrast swap**, so the lime ring sits on the cream ground where mosh.css deliberately swaps to `var(--bone)` (:900) | `--focus-ring-color/-w/-offset`, remapped darker under light in **both** shells |

---

## 4. Drift catalog (all grep-verified)

### 4.1 Raw accent/status literals that break theming
- **Lime by value**: `rgba(204,255,54,…)` hardcoded at shell.css:382/:384 (track-level glow), :433 (drum clip border), :645 (search focus) — `--v2-accent` *changes* in the light theme (:81), these don't. Classic twin: raw `rgba(204,255,35,…)` at mosh.css:334/:365/:406 — those stay lime under **every skin**.
- **Two red families**: `rgb(255,71,106)` (armed-record glow :160, errbar palette :605) vs the actual token `--v2-rec: #ff3b5c` (:42, and re-derived by hand at :617). Danger text `#ffb3c1` duplicated :429/:605.
- **Untokenized status colors**: online-dot `#3fe06a` ×2 (:526); slant-rhyme `#ffd45c` (:749, a near-miss of `--mute #ffb454`); offline dot as raw white-alpha instead of the near-identical `--v2-faint` (:527).
- **Surface by value**: `.v2-pb-listhead` `#161618` + light patch `#f4f7fd` (:653-654 — a cool blue-white on the warm cream ground, and immediately overridden for its only stated consumer at :701); avatar ink `#0c0c0c` (:226/:521) doing `--on-accent`'s job.

### 4.2 Orphaned/shadowed tokens (defined, then bypassed)
- `--v2-clip-midi`/`--v2-clip-drum` defined **with light-theme overrides** (:38-39/:86-87) — consumed by nothing; `.v2-clip.midi/.drum` hardcode different values (:432-433), so the light overrides are dead code.
- `--v2-radius-sm: 10px` exists; `border-radius: 10px` hardcoded anyway (:375, :556). A whole ad-hoc radius family (7/8/9/11/12/14px) grew beside the two tokens.
- `HEAD_W/LANE_H` (geom.ts) shadowing `--v2-head-w/--v2-lane-h` — the §0.1 bug. Same disease, different host: `PresenceMeter`'s idle 0.18 duplicated JS↔CSS; `ROW_H = 48` (PluginBrowser.tssx:21) hand-synced with CSS; `EDGE_PX = 7` (SectionRibbon:20) parallel to `liveFeel().edgeGrabPx`.

### 4.3 Systemic inconsistencies
- `.v2-drawer-panel` is a 74 %-alpha surface **without** `backdrop-filter: blur(20px)` while every sibling overlay pairs the two (menu :237, clipmenu :422, toast :613) → the timeline visibly bleeds through the sample list (confirmed in screenshot).
- Destructive hover signals disagree: section-remove ✕ hovers **lime** (:346) while clip-menu Remove hovers **danger red** (:429).
- Menus pop in one frame while toast/drawer animate at 240 ms (no transition on :234-247/:419-423).

### 4.4 The classic-in-v2 seam
Composer/Inspector deliberately reuse classic components (`AgentComposer`, `FileOptions`, `Rack`, `GenDrawer`, `SampleBrowser`) — correct per the command seam, but restyled via descendant-selector compat shims (shell.css:196-220, :592, :554), including a `font-size: 0` + emoji-`::after` relabel hack for the multiplayer popover buttons (:213-216: 👥/✦/📱 as CSS `content`). Tightly coupled to classic markup, screen-reader-hostile, and the SampleBrowser arrives with clashing light rows (screenshot). Needs a declared policy: either a scoped bridge-token block for classic-in-v2 mounts, or v2-native wrappers.

---

## 5. Top 10 UX issues (ranked by daily-producer impact)

1. **Playhead misalignment (44 px)** — §0.1. Critical; visible on every session; already spun off as a fix task.
2. **The arrangement is pointer-only.** Clips ([ClipView.tsx:148-153](src/v2/lanes/ClipView.tsx)) and sections ([SectionRibbon.tsx:153-161](src/v2/timeline/SectionRibbon.tsx)) are plain divs — no tabIndex, no keyboard path to select/move/trim/split/rename, and the context menu opens only via right-click. Track headers *are* keyboard-selectable (nice), which makes the gap feel arbitrary.
3. **Lyrics tab ships unstyled + a focus trap.** `.v2-lyric-*` has no CSS (default `<ol>` numbering, default white inputs on the dark card — confirmed visually); the ghost line intercepts **Shift+Tab as accept** (LyricPanel.tsx:180 — no `shiftKey` check), so reverse-tabbing commits an undoable mutation; `outline: none` on the ghost (:785) fights the shell's own focus policy.
4. **v2 overlays bypass the shared Escape stack.** The app has the AL-001 stack (`hooks/useEscapeToClose.ts`), yet zero uses under `src/v2/`: drawer, overflow menu, clip menu are all Escape-dead; the overflow menu declares `role="menu"` with none of the menu keyboard contract (no focus move, no arrows, invisible click-catcher dismissal, TopBar.tsx:147-152); FloatingWindow is `role="dialog"` with no focus management. Fix once in shared primitives, not per surface.
5. **Loading/empty states are voids.** Cold start: TopBar withheld until the snapshot (AppV2.tsx:44 — top chrome pops in, shifts layout), and the loading state is one bare faint line with no `role="status"`/skeleton (:57). Zero tracks: "ask Mosh to start a beat" with **no add-track affordance** — the New-track button only exists once tracks exist (TrackLaneList.tsx:93-101 vs :143). No track: Inspector `return null` leaves an unexplained hole in the rail (Inspector.tsx:25).
6. **Controls that lie.** Tempo input is uncontrolled (`defaultValue`, TopBar.tsx:51-54) — goes stale when the agent/undo/a collaborator changes tempo (the codebase's own `key={content}` pattern exists in LyricPanel); both invite buttons silently no-op once shared while styled fully active (TopBar.tsx:90-92, RightRail.tsx:108); "To start" ⏮ and "Stop" ⏹ execute the **identical command** (TopBar.tsx:62-70); the AI-status pill looks like a button but is inert (:83); the Mosh card's LIVE badge is unconditional (RightRail.tsx:30).
7. **The undo window is hostile to keyboard users and errors.** ChangeToast pauses its 4.5 s timer on hover only — not on focus (ChangeToast.tsx:42-43) — and **failed** batches auto-dismiss on the same timer as successes (:27), taking the error text and the Undo affordance with them.
8. **Sub-24 px hit targets on daily controls.** M/S 22×20 px (shell.css:392-393), section-remove ✕ 16×16 **and** opacity-0 until hover (:339-345), zoom chips ~20 px. Hover-only reveals are also invisible on the iPhone companion.
9. **No track/clip color identity, and classic canvas colors leak.** Every lane reads identical; MIDI/drum notes render in the classic renderer's hardcoded violet (`Arrange.tsx:738/:771`) — theme/skin-blind and off-palette in v2 (visible in screenshots).
10. **Menu mechanics.** Clip context menu renders at the raw cursor with no viewport clamping (ClipView.tsx:144/:178 — clips offscreen near edges), no focus-on-open, no arrow keys; menus pop unanimated while sibling overlays animate (§4.3); destructive hovers disagree (§4.3).

*Also noted (below the fold): errbar has no dismiss and reflows the layout when it appears/disappears — and the drawer's magic 92 px top doesn't track it (AppV2.tsx:45 + shell.css:567); drawer content unmounts instantly while the 240 ms slide-out runs (LeftDrawer.tsx:22); plugin rows disabled with tooltip-only explanation when no track is selected (PluginBrowser.tsx:112); PresenceMeter is `aria-hidden` with no text equivalent; `.v2-ruler-bar.cur` styled but never rendered; three dead shellState fields.*

---

## 6. Prioritized incremental roadmap

Each step is small, independently shippable, and verifiable (`cd ui && npx tsc -b && npx vitest run && npm run test:e2e`; visual via Storybook once seeded).

### Phase 2 — token foundation (no intentional visual change)
1. ~~Fix the geom.ts mirror~~ → spun off (task chip). Pattern fix: read the CSS custom property at runtime or single-source the constant.
2. **Decide §1.3 (skin strategy)** — 15-minute decision, gates naming below.
3. Hoist motion tokens to `:root` (`--ease-house/out/spring`, `--dur-*`); replace the 14 hardcoded house-curves and shell.css's 8 combos. Fixes the silent-fallback bug at mosh.css:310 for free.
4. Add the z-index ladder; sweep both files + the JS `zIndex:55`; delete the :542 comment-as-token.
5. Add focus-ring tokens + the missing v2 light-theme ring swap.
6. Add spacing/radius/type/shadow scales (values in §3 — derived from de-facto clusters, so sweeps are visually no-op); sweep shell.css first (smaller), mosh.css opportunistically.
7. Re-point orphaned tokens: make `.v2-clip.midi/.drum` consume `--v2-clip-midi/drum` (resurrects the dead light-theme overrides); kill the raw lime/red/status literals (§4.1) with `--v2-accent` derivations (`color-mix`), `--v2-rec`-family, new `--v2-ok`.
8. **Seed Storybook**: one story per shell component × dark/light (+ a token-sheet story). This becomes the standing audit surface; add `test-storybook` or screenshot walkthrough later.

### Phase 3 — shared-component reworks (fix the system, not the page)
9. One **overlay primitive** (or hook set) used by drawer/menus/floating windows: Escape-stack registration, focus-on-open/restore-on-close, viewport clamping, shared enter/exit motion (reduced-motion aware). Retire the per-surface gaps in §5.4/§5.10 at once.
10. Drawer: add the missing `backdrop-filter` (or solid surface); geometry via `calc(var(--v2-topbar-h) …)` so the errbar stops misaligning it; keep content mounted through the slide-out.
11. LyricPanel stylesheet: `.v2-lyric-*` rules + a shared `.v2-input` (search field + topic + rhymes + lyric lines all match); fix the ghost Shift+Tab and drop its `outline:none`.
12. ChangeToast: pause-on-focus, persistent (or much longer) error variant.
13. Classic-in-v2 seam policy (§4.4): bridge-token block or wrappers; replace the emoji-`::after` relabel hack with real labels; restyle SampleBrowser's drawer mount.
14. Shared canvas renderers read their palette from CSS vars (fixes violet notes in v2 **and** makes classic canvas skin-correct — it's currently skin-blind there too).

### Phase 4 — per-screen fixes (now they propagate)
15. Empty/loading states: skeleton lanes + `role="status"` on boot; reserve the TopBar row; add-track CTA in the zero-track state; Inspector empty card instead of `null`.
16. TopBar: controlled/keyed tempo; real return-to-start semantics for ⏮; invite → copy-link state when shared; AI pill → button or plain text; visible undo/redo affordance; playing-state colors.
17. Arrangement keyboard pass: focusable clips/sections (roving tabindex per lane), Enter=select, ContextMenu-key menu, arrow nudge; grow M/S/✕/zoom hit areas to ≥24 px; rest-state opacity for hover-reveals.
18. Track color identity: per-track accent token consumed by header icon, lane glow, clip borders (replaces `SEG_COLORS`-style hardcoding; skins/themes get it via the token).
19. RightRail: conditional LIVE badge, PresenceMeter text equivalent, offline-peer shape (not color-only).

---

## Appendix

- **Method**: 8 parallel read-only auditor agents over component clusters + token system + UX/a11y (two clusters re-read by hand after agent-quota failures); all cited lines grep-verified; 5 load-bearing claims re-verified by hand; visual confirmation via Vite dev app + mock backend (dark + cream themes, Lyrics tab, open drawer). Storybook could not serve as the audit surface (one story total).
- **Numbers**: v2 TSX = 1 hex / 0 rgba / 19 inline-style (18 runtime-data). shell.css = 797 lines, 317 `var()`, ~38 raw color literals in rule bodies, 40 distinct tokens consumed, 8 motion combos. mosh.css = 1157 lines, 445 `var()`, 121 hardcoded font-sizes, 62 radius declarations, 5 skins × 2 themes.
- **Out of scope, noticed**: `[data-skin="logic"]` exists but isn't in the settings UI copy audited here; the `--v2-blue` "track icons only" token (:36) is also used by the FX badge tint via a hand-derived rgba (:671) — wants a `--v2-blue-soft`.
