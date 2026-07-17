// Producer knowledge base — the "why/when" the command catalog (commands.ts) lacks.
// The catalog tells Moshi's brain WHAT each command does; these cards tell it, in
// plain producer terms, WHY/WHEN to reach for a control and what a param really means.
// A few relevant cards are retrieved per turn and injected next to the catalog by
// buildSystemPrompt() (brainCore.ts).
//
// The store is committed JSONL (one card per line) held as a string constant so it is
// bundle-safe under BOTH Vite (the app) AND tsx (the offline brain scripts) with zero
// bundler magic — no ?raw import, no fs read. Retrieval is deterministic tag/keyword
// match behind a swappable `retrieveCards` seam (mirrors the lyric style_corpus.retrieve
// posture: a lexical scorer now, a real embedding backend a parked upgrade behind the
// same seam). Cards are OWNER/ASSISTANT-authored — never auto-extracted (see
// docs/bench/FX_KB_PILOT.md for why VLM auto-extraction was a NO-GO).
//
// Schema note: `maps_to` is the control/param/command a card explains — the join key a
// future UI can use to surface the same card as an inline hint on the matching control.

export type KnowledgeCard = {
  /** Stable unique id — one card is one fact. */
  readonly id: string;
  /** Short human topic (for authoring/index; not shown to the model). */
  readonly topic: string;
  /** The control/param/command this card is about — the UI-hint join key. */
  readonly maps_to: string;
  /** What it does, in one layman sentence. */
  readonly plain: string;
  /** When to reach for it. */
  readonly when: string;
  /** Keyword tags — the primary retrieval signal. */
  readonly tags: readonly string[];
};

// ── the committed store (JSONL, one card per line) ────────────────────────────────
// Append a card = add a line. Keep it valid JSON with double-quoted keys/strings.
export const PRODUCER_KNOWLEDGE_JSONL = `
{"id":"sa3-onset-steering","topic":"Opening energy fades across the clip","maps_to":"colors / neural steering","plain":"SA3 makes a stronger statement in the first ~1 second then settles; the steering/colors nudge the model's 'brain' in a direction, and a time-scheduled steer can KEEP that opening energy going across the whole clip instead of letting it fade.","when":"the generation starts strong then thins out and you want it to stay full.","tags":["energy","intro","opening","arrangement","steering","colors","fade","settles"]}
{"id":"reimagine-noise-amount","topic":"How far a re-imagine departs from your beat","maps_to":"nl / init_noise_level (re-imagine)","plain":"The re-imagine 'noise' is how much of YOUR original beat to keep vs how much Moshi reinvents — low (<=0.5) keeps your groove and stays clean over long clips, high (>=0.7) reinvents more but can make each section restart its intro.","when":"deciding how far to push a re-imagine, or if a long re-imagine pulses every few bars.","tags":["reimagine","noise","amount","nl","init_noise_level","whole-clip","groove","pulse"]}
{"id":"warp-stretch-clip-bars","topic":"Fitting an imported loop to the grid","maps_to":"stretch_clip","plain":"stretch_clip time-stretches a wave clip (warp) to a target length in seconds or a bar count, so an imported loop locks to your project tempo instead of drifting out of sync.","when":"an imported loop doesn't line up with the grid, or you want it to fill an exact number of bars.","tags":["warp","stretch","stretch_clip","fit","bars","loop","tempo","grid","imported"]}
{"id":"warp-detect-clip-bpm-confidence","topic":"How sure the BPM detector is","maps_to":"detect_clip_bpm","plain":"detect_clip_bpm estimates a wave clip's tempo (read-only) and comes back with a confidence alongside the BPM guess — low confidence usually means the take has a loose or ambiguous groove, so treat the number as a starting point, not gospel.","when":"you don't know a sample or loop's original tempo before warping it to the grid.","tags":["warp","bpm","detect","detect_clip_bpm","confidence","tempo","estimate"]}
{"id":"warp-drag-to-stretch","topic":"Dragging a loop's edge to fit bars","maps_to":"warp / drag-to-stretch (Inspector)","plain":"Holding Cmd and dragging a wave clip's edge, or using the Inspector's Fit-bars / 1/2x / 2x buttons, is the hands-on version of stretch_clip — it drives the same warp engine under the hood (the set_clip_warp toggle, which is UI-only and not agent-callable), and Detect can auto-lock a loop to the grid the instant warp turns on.","when":"you're eyeballing a loop against the grid instead of typing an exact bar count.","tags":["warp","drag","stretch","fit","bars","grid","inspector","detect","auto-lock","set_clip_warp"]}
{"id":"drum-pattern-lane-syntax","topic":"Writing a drum pattern in one shot","maps_to":"add_drum_pattern","plain":"add_drum_pattern lays a whole grid from lane strings in one undoable step — 'x' is a hit, 'X' is an accent (louder), '.' or '-' is a rest, and '|' is just a cosmetic bar divider; lanes are kick/snare/clap/hat/openhat/lowtom/midtom/crash, or a raw MIDI pitch for a custom pad.","when":"you want a whole pattern laid down from a description like kick on 1 and 3, snare on 2 and 4, instead of adding notes one at a time.","tags":["drums","drum_pattern","add_drum_pattern","pattern","kick","snare","hat","accent","rest","lane","syntax"]}
{"id":"drum-pattern-tiling","topic":"Short lanes repeating to fill the bar","maps_to":"add_drum_pattern (tiling)","plain":"a lane string shorter than the full step count tiles to fill it — writing a short dot-x pattern for hats gives steady 8ths across the whole bar without typing every step, as long as the short lane divides evenly into stepsPerBar times bars.","when":"you want a busier lane, like hats, without spelling out every repeat by hand.","tags":["drums","add_drum_pattern","tile","tiling","hat","repeat","pattern","shorthand","stepsperbar"]}
{"id":"drum-sketch-beatbox","topic":"Turning a beatboxed take into an editable drum clip","maps_to":"sketch_beatbox","plain":"sketch_beatbox transduces a recorded beatbox WAV into an editable drum clip at a known BPM, snapping kick/snare/hat hits onto a 16th grid so you get real MIDI drum notes instead of raw audio.","when":"you beatboxed a rough drum idea and want it as editable notes instead of manually programming the grid.","tags":["drums","sketch_beatbox","beatbox","transduce","record","voice","kick","snare","hat","16th"]}
{"id":"lyrics-build-skeleton-from-clip","topic":"Turning a mumbled take into a syllable grid","maps_to":"build_skeleton_from_clip","plain":"build_skeleton_from_clip listens to a hummed or mumbled wave take and turns it into an editable rhythmic flow skeleton — a syllable grid plus stress pattern, no words yet — on the clip's track; you confirm the grid, then finishing the gaps writes the actual words.","when":"you've hummed or mumbled a vocal flow before you have lyrics, and want the rhythm captured before writing to it.","tags":["lyrics","skeleton","build_skeleton_from_clip","mumble","flow","syllable","grid","stress","rhythm"]}
{"id":"lyrics-complete-lyrics","topic":"Filling every gap in a lyric sheet at once","maps_to":"complete_lyrics","plain":"complete_lyrics fills every remaining gap across a track's whole lyric sheet in one call, returning ranked proposals per line that are already syllable- and rhyme-checked against your grid.","when":"most of the sheet is still gaps and you want a full first pass instead of filling line by line.","tags":["lyrics","complete_lyrics","gap","fill","proposals","syllable","rhyme","sheet"]}
{"id":"lyrics-fill-lyric-gap","topic":"Filling just one line's gaps","maps_to":"fill_lyric_gap","plain":"fill_lyric_gap generates ranked proposals for a single lyric line's gaps without touching the rest of the sheet — useful once most lines are written and only one still has a hole.","when":"one specific line needs finishing and you don't want complete_lyrics to touch lines you already like.","tags":["lyrics","fill_lyric_gap","gap","line","proposals","one-line"]}
{"id":"lyrics-suggest-next-line","topic":"Getting a ghost line to continue the flow","maps_to":"suggest_next_line","plain":"suggest_next_line proposes a brand-new line after a given index — a ghost line for when you've run out of ideas, rather than a gap-fill of something you already typed.","when":"you're stuck for what comes next after a line, not fixing a specific gap.","tags":["lyrics","suggest_next_line","ghost","next","line","suggestion","stuck"]}
{"id":"lyrics-analyze-lyrics","topic":"Checking a written line's flow without generating","maps_to":"analyze_lyrics","plain":"analyze_lyrics is read-only — it grades every finalized line's syllable count, stress contour and rhyme match against its group anchor with no LLM call, the same check the generator itself uses to pass or fail a line.","when":"you typed a line by hand and want to know if it actually hits the syllable and rhyme target before moving on.","tags":["lyrics","analyze_lyrics","syllable","stress","rhyme","flow","check","phonology"]}
{"id":"lyrics-get-rhymes","topic":"Looking up rhymes for a specific word","maps_to":"get_rhymes","plain":"get_rhymes runs a phoneme-based rhyme search, perfect or slant, filterable by syllable count, with no LLM involved — it's a dictionary and phonology lookup, so it's instant and exact rather than a generated guess.","when":"you already have the line and just need rhyme options for one word to fit the count.","tags":["lyrics","get_rhymes","rhyme","phonology","perfect","slant","word","dictionary"]}
{"id":"generative-create-render-layer-modes","topic":"Re-imagine vs transform on a render layer","maps_to":"create_render_layer","plain":"create_render_layer attaches a generative layer to any clip — wave, MIDI, or drum, with MIDI/drum auto-bounced to audio first; the adapter picks the mode — re-imagine keeps roughly your version and reinvents around it, transform pushes the sound toward a different target instrument or timbre.","when":"deciding whether to reshape what's already there (re-imagine) or turn it into something else entirely (transform).","tags":["generative","create_render_layer","reimagine","transform","adapter","layer","clip"]}
{"id":"generative-compile-render","topic":"Turning a loose instruction into a real render","maps_to":"compile_render","plain":"compile_render takes a loose instruction like \\"make it lo-fi\\" or \\"as a violin\\" and auto-picks re-imagine vs transform, filling in prompt, colours and noise or target and strength for you — it honestly declines corrective asks like fix or tune, or vocal requests it can't actually do.","when":"you'd rather describe the vibe in plain language than manually set render params.","tags":["generative","compile_render","instruction","auto","prompt","colours","target","strength"]}
{"id":"generative-set-render-param","topic":"Dialing in a render layer's parameters","maps_to":"set_render_param","plain":"set_render_param tunes a render layer directly — prompt, noise level and seed for re-imagine; target and strength for transform; or coverage for how a long clip gets covered, tiling a short loop versus stitching separate windows.","when":"you already have a layer and want to adjust it rather than re-describe it from scratch.","tags":["generative","set_render_param","prompt","noise","seed","target","strength","coverage"]}
{"id":"generative-keep-reimagine-dial","topic":"The 0-100 keep-vs-re-imagine dial versus raw noise","maps_to":"nl (0-100 keep <-> re-imagine dial)","plain":"the re-imagine drawer's 0-100 keep-to-re-imagine dial is the friendly face of set_render_param's raw nl noise level (0-1) — it's ASTD-clamped below the point where a render collapses into mush, and Lab mode is the only way to push nl past that clamp into the raw, un-clamped range.","when":"explaining why the dial tops out before it feels totally wild, or why Lab mode unlocks a higher setting.","tags":["generative","nl","dial","keep","reimagine","astd","clamp","lab","noise"]}
{"id":"mixer-track-volume-pan","topic":"Balancing a track in the mix","maps_to":"set_track_volume / set_track_pan","plain":"set_track_volume sets a track's fader in dB and set_track_pan moves it left or right, from -1 full left to 1 full right — the most basic mix moves before reaching for any plugin.","when":"one track is too loud, too quiet, or sits too centered against the others.","tags":["mixer","volume","pan","set_track_volume","set_track_pan","fader","balance","mix"]}
{"id":"mixer-sends-returns","topic":"Sharing one reverb or delay across several tracks","maps_to":"create_bus / add_send / set_send_level","plain":"create_bus makes an aux or return track, like a shared reverb or delay; add_send routes a post-fader send from any track into it at a level in dB, and set_send_level adjusts that amount later — cheaper and more cohesive than loading the same effect on every track.","when":"several tracks need the same space or ambience and duplicating the plugin per-track would be wasteful and inconsistent.","tags":["mixer","sends","returns","bus","create_bus","add_send","set_send_level","reverb","delay","aux"]}
{"id":"mixer-master-and-remove-send","topic":"The master bus and pulling a track out of a send","maps_to":"set_master_volume / set_master_pan / remove_send","plain":"set_master_volume and set_master_pan control the final master fader and pan the whole mix passes through, separate from any single track; remove_send takes a track back out of a bus if it no longer needs that shared reverb or delay.","when":"the overall mix is too loud or quiet, or one track was sent to a bus by mistake.","tags":["mixer","master","set_master_volume","set_master_pan","remove_send","bus"]}
{"id":"vst3-load-plugin","topic":"Adding a hosted VST3/AU plugin to a track","maps_to":"load_plugin","plain":"load_plugin adds a scanned VST3 or AU plugin, by pluginId from list_plugins, onto a track's chain at a given position — this is how a real hosted synth or effect, not one of Mosh's built-ins, gets onto a track.","when":"you want a specific third-party synth or effect rather than one of Mosh's built-ins.","tags":["vst3","au","plugin","load_plugin","host","chain"]}
{"id":"vst3-chain-order","topic":"Why plugin order in the chain matters","maps_to":"reorder_plugin","plain":"reorder_plugin moves a plugin to a new position in a track's signal chain — order matters, since an EQ before a compressor reacts differently than one placed after it, so reordering is how you fix a chain that's right in concept but wrong in sequence.","when":"the same plugins are loaded but the sound isn't right until you change what processes first.","tags":["vst3","plugin","reorder_plugin","chain","order","signal","sequence"]}
{"id":"vst3-open-editor","topic":"Opening a plugin's real interface","maps_to":"open_plugin_editor","plain":"open_plugin_editor pops out a plugin's native editor window — set_plugin_param only reaches raw 0-1 parameter values, so for anything with a real interface, like browsing presets or drawing an envelope, you open the editor instead.","when":"a plugin's actual window, presets, or visual controls are needed, not just nudging one parameter number.","tags":["vst3","plugin","open_plugin_editor","editor","gui","preset","native"]}
{"id":"recording-arm-track","topic":"Arming a track before you record","maps_to":"arm_track","plain":"arm_track arms or disarms a track's input for recording — a track has to be armed before set_transport's record action actually captures anything onto it.","when":"you're about to record and nothing is being captured, or you want to make sure only the right track picks up input.","tags":["recording","arm_track","armed","input","record","takes"]}
{"id":"recording-input-monitor","topic":"Hearing your input while armed","maps_to":"set_input_monitor","plain":"set_input_monitor controls whether an armed track's live input is audible through the mix — off, automatic, or on — so you can hear yourself while recording without it depending on playback state alone.","when":"you can't hear what you're about to record, or you're hearing it doubled during playback.","tags":["recording","set_input_monitor","monitor","input","armed","hear"]}
{"id":"recording-take-lanes","topic":"Multiple takes stacked on one clip","maps_to":"list_takes / set_current_take","plain":"recording over an existing clip stacks a new take lane instead of overwriting it; list_takes shows what's stacked and set_current_take switches which lane actually plays — nothing is lost until you commit to one.","when":"you recorded several passes at the same spot and want to compare or switch between them.","tags":["recording","takes","list_takes","set_current_take","lane","stack","compare"]}
{"id":"recording-keep-take","topic":"Committing to one take and discarding the rest","maps_to":"keep_take","plain":"keep_take keeps the currently-selected take lane on a clip and permanently removes the other stacked takes — the cleanup step once you've picked a favorite via set_current_take.","when":"you're done comparing takes and want to stop carrying the unused ones around.","tags":["recording","keep_take","take","commit","cleanup","lane"]}
{"id":"recording-stop-recording","topic":"Stopping a recording and landing the take","maps_to":"stop_recording","plain":"stop_recording ends the current recording and lands the take as a clip, or with discardRecordings throws it away — the explicit stop for when you're not just relying on the transport's own stop.","when":"you want to end a take, or discard it, without necessarily stopping the whole transport by other means.","tags":["recording","stop_recording","stop","land","take","discard"]}
{"id":"generative-render-vs-accept","topic":"Running a render vs landing it","maps_to":"render_layer / accept_render","plain":"render_layer actually runs the generative job on a clip's layer; accept_render commits a finished render — for wave clips it auto-applies in place already so accept is a no-op there, but for MIDI/drum clips accept_render is the step that lands the hidden render as a real clip.","when":"confused why a MIDI re-imagine needs an extra accept step that a wave clip doesn't.","tags":["generative","render_layer","accept_render","commit","apply","midi","wave"]}
`.trim();

function parseKnowledge(jsonl: string): KnowledgeCard[] {
  const out: KnowledgeCard[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const o = JSON.parse(line) as KnowledgeCard;
    out.push({
      id: String(o.id),
      topic: String(o.topic),
      maps_to: String(o.maps_to),
      plain: String(o.plain),
      when: String(o.when),
      tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    });
  }
  return out;
}

/** The parsed producer-knowledge store. */
export const PRODUCER_KNOWLEDGE: readonly KnowledgeCard[] = parseKnowledge(PRODUCER_KNOWLEDGE_JSONL);

// ── deterministic tag/keyword retrieval (swappable seam) ──────────────────────────

const TOKEN_RE = /[a-z0-9]+/g;
// Very common / low-signal words carry no "which control" signal — exclude them.
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for", "with",
  "i", "me", "my", "you", "your", "it", "its", "is", "are", "be", "am", "as", "so",
  "that", "this", "do", "does", "did", "how", "should", "can", "could", "would",
  "will", "if", "then", "than", "out", "up", "down", "more", "less", "not", "no",
  "yes", "just", "now", "when", "why", "what", "some", "any", "get", "got",
]);

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of (text || "").toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (t.length >= 2 && !STOP.has(t)) out.push(t);
  }
  return out;
}

// A card's token → weight bag. Tags are the primary signal (3); topic/maps_to next
// (2); the prose (plain/when) lowest (1) so a producer's natural phrasing still hits.
function cardWeights(card: KnowledgeCard): Map<string, number> {
  const w = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const t of tokenize(text)) if ((w.get(t) ?? 0) < weight) w.set(t, weight);
  };
  add(`${card.plain} ${card.when}`, 1);
  add(`${card.topic} ${card.maps_to}`, 2);
  add(card.tags.join(" "), 3);
  return w;
}

export type RetrieveOptions = {
  /** Max cards to return (default 3). */
  readonly limit?: number;
  /** The pool to score against (default: the committed store). */
  readonly cards?: readonly KnowledgeCard[];
};

/** The few cards most relevant to `query`, by weighted tag/keyword overlap.
 *  Deterministic: rank by score, ties break by id. Zero-overlap cards are dropped
 *  (an irrelevant card in the prompt is worse than none — the style_corpus principle). */
export function retrieveCards(query: string, opts: RetrieveOptions = {}): KnowledgeCard[] {
  const cards = opts.cards ?? PRODUCER_KNOWLEDGE;
  const limit = opts.limit ?? 3;
  const qTokens = Array.from(new Set(tokenize(query)));
  if (qTokens.length === 0) return [];
  const scored = cards
    .map((card) => {
      const w = cardWeights(card);
      let score = 0;
      for (const t of qTokens) score += w.get(t) ?? 0;
      return { card, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
  return scored.slice(0, limit).map((s) => s.card);
}

/** Render retrieved cards into a compact system-prompt block. Empty ⇒ "" (so the
 *  prompt is byte-unchanged when nothing is relevant). */
export function knowledgePromptSection(cards: readonly KnowledgeCard[]): string {
  if (cards.length === 0) return "";
  return [
    "Producer knowledge — plain-language notes on the controls this request may touch. Use them to choose and explain moves; speak them in your own voice, never quote verbatim.",
    ...cards.map((c) => `- ${c.maps_to}: ${c.plain} (when: ${c.when})`),
  ].join("\n");
}
