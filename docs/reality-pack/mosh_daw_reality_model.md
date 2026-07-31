# Mosh DAW Reality Model + Agent Guardrail
Generated for the Mosh project from the available Ableton Live, FL Studio, Pro Tools, Mosh scope, and browser-audio research materials. This is a practical synthesis of the remaining research prompts: cross-DAW model, user workflow plan, Moshi command reality model, MVP filter, and QA/evaluation suite.
## Source base used

- `Pasted text.txt` — Ableton Live manual extraction for Mosh.
- `Pasted text (2).txt` — FL Studio manual extraction for Mosh.
- `Pasted markdown (3).md` — Pro Tools manual extraction for Mosh.
- `onboarding-chat.txt` — Mosh product scope and day-one build target.
- `audio_github_*` research docs — browser DAW, AudioWorklet/WAM, Tracktion/AI, and web-audio infrastructure research.
## Executive decisions

1. Mosh should not try to clone one DAW. It should normalize the shared DAW reality: source media vs placed clips, tracks as both timeline and mixer objects, a transport, a mixer, a browser/media pool, reversible edits, and explicit render/submission state.
2. The social/battle wedge makes Ableton-like clip launching and scenes unusually valuable, but the MVP still needs Pro Tools-like reliability around recording and FL-like loop/pattern fluency.
3. Moshi should be an operator over typed commands, not a chatbot that mutates UI. Every command must validate against authoritative session state, execute through the DAW core, log the result, and provide undo where applicable.
4. The first convincing demo is not a full DAW. It is a browser-native room where a user imports a beat, records a vocal, moves/edits clips, applies basic effects through Moshi, submits, votes, and reveals a winner.
5. The DAW knowledge base should become tests. A claim like “clips can move” is not complete unless state change, audible result, UI result, log event, and undo behavior are defined.
## 1. Canonical DAW object ontology

| Canonical object | Definition | Aliases / source models | Required fields for Mosh | Common operations | Priority |
| --- | --- | --- | --- | --- | --- |
| Project / Session | Top-level saved musical work containing tracks, clips, mixer, tempo, assets, edit history, battle metadata. | Live Set/Project; FL Project; Pro Tools Session/Project | id, owner/room, tempo, meter, sampleRate, assets, tracks, scenes, arrangement, mixer, history, submissions | Open/save, fork/remix, export, recover missing media | P0 |
| Track | A timeline/mixer container and routing node. Holds clips or instruments depending on type. | Live Track; FL Playlist Track/Mixer Insert/Channel; PT Track | id, type, name, color, mute, solo, arm, input, output, gain, pan, clip lanes, effect chain | Create, rename, reorder, arm, mute/solo, route, add clips/effects | P0 |
| Audio clip | Placed timeline/grid object referencing source audio with its own start/end/offset/loop/gain. | Clip, Region, Item, Audio Clip | id, sourceAssetId, trackId, startBeat, durationBeat, sourceOffsetSec, gainDb, fadeIn/out, warpMode, loop | Import, record, move, trim, split, duplicate, loop, mute | P0 |
| MIDI / Pattern clip | Placed musical note/pattern object that triggers an instrument or channel. | MIDI Clip, Pattern, Part | id, notes, targetInstrumentId, startBeat, durationBeat, loop, quantize, scale | Draw notes, record MIDI, quantize, duplicate, loop | P1 |
| Automation | Time-varying control data for track, clip, effect, send, or instrument parameters. | Automation lane, envelope, automation clip, event automation | targetId, parameterId, points, interpolation, ownerClipOrTrack, mode | Draw, record, edit, delete, override, re-enable | P1 |
| Scene / Section | Coordinated launch or arrangement section marker for groups of clips. | Live Scene; FL Time Marker; PT Memory Location/Marker | id, name, color, startBeat, lengthBeat, clipSlotIds, launchQuantize | Launch, rename, reorder, duplicate, mark intro/verse/hook/outro | P0 |
| Transport | Playback and recording state machine. | Transport, Control Bar | state, playheadBeat, loopRange, bpm, meter, metronome, countIn, recordMode | Play, stop, seek, loop, record, count-in, tap tempo | P0 |
| Mixer channel | Audible signal path for a track or bus. | Mixer strip, Insert, Channel Strip | gain, pan, mute, solo, meter, inserts, sends, outputBus | Adjust level/pan, meter, add FX, route sends | P0 |
| Effect / Device | Signal processor or instrument in an ordered chain. | Device, FX slot, Plugin, Insert | id, kind, name, parameters, enabled, order, latencySamples | Add, remove, reorder, bypass, automate parameters | P0/P1 |
| Send / Return / Bus | Shared routing path, usually for reverb/delay or submixing. | Return, Aux, Bus, Send, Group | busId, sourceTrackIds, sendLevels, prePost, returnTrackId | Create send, change level, route outputs | P1 |
| Browser / Media pool | Searchable area for samples, loops, devices, uploaded assets, project media. | Browser, Workspace, Clip List, Current Project | assetId, name, tags, duration, bpm, key, waveform, owner, license | Search, preview, drag to track/slot, relink missing media | P0 |
| Submission / Render | Exported or locked battle artifact for voting/publishing. | Bounce, Render, Export, Submission | submissionId, sessionId, mixUrl, stems, creatorIds, timestamp, roundId | Render full mix, render stems, submit, lock, vote | P0 |

## 2. Cross-DAW behavior matrix

| Behavior area | Ableton Live reality | FL Studio reality | Pro Tools reality | Mosh interpretation |
| --- | --- | --- | --- | --- |
| Timeline arrangement | Arrangement View rows by track | Playlist clips on flexible clip tracks | Edit Window with tracks + rulers | One timeline with tracks, clips, section markers, snap grid |
| Nonlinear loop surface | Session View clip grid + scenes | Pattern mode / Playlist loop focus; no full Live equivalent | Classic sessions linear; Sketch adds clip grid | P0 clip grid or room-loop surface; scenes for sections |
| Audio recording | Arm track, choose input, monitor In/Auto/Off, record clip | Mixer input + arm disk icon, record into Playlist Audio Clip | Audio track input + record enable + transport record | P0 mic permission, selected track, count-in, create recorded clip |
| MIDI/pattern recording | MIDI clips on MIDI tracks | Patterns contain notes per Channel Rack instrument | MIDI/Instrument tracks with MIDI clips | P1 simple pattern/piano roll; scale-lock |
| Comping/takes | Take lanes auto-created in Arrangement | Manual stacking/Edison region workflow | Playlists and lanes, promote to main | P2 simplified take stack; not MVP |
| Snap/grid | Adaptive/fixed grid, bypass modifier | Playlist/Piano Roll snap with Alt bypass | Grid/Slip/Nudge modes | P0 snap-to-grid + fine-adjust bypass |
| Automation | Arrangement envelopes; Session clip envelopes | Automation clips and event automation | Automation lanes/modes | P1 simple parameter automation; P0 only for internal state readiness |
| Routing/mixer | Tracks, returns, groups, Main | Channels route to Mixer Inserts; any Insert can be send/bus | Tracks, buses, aux, master, sends | P0 fader/pan/mute/solo/inserts; P1 one shared send; P2 deeper routing |
| Media management | Browser + Collect All and Save + missing file repair | Browser + Current Project + ZIP export embeds samples | Workspace + Clip List + relink | P0 uploaded assets stored by stable asset ID; preview; missing state |
| Export/render | Export Audio/Video, stems, tails matter | Song/Pattern mode export, split mixer tracks | Bounce Mix or Export; time selection | P0 render submitted mix; P1 stems; respect loop/section |
| AI operation | Not native, but Live behaviors map to commands | Not native, but workflow objects are commandable | Not native, but strong state model | Moshi emits typed commands; never manipulates React directly |

## 3. Universal DAW invariants

These are written as implementation-testable statements. They should be converted into automated tests as the DAW core stabilizes.

### Transport
1. Pressing Play starts audio from the visible playhead position.
2. Pressing Stop halts playback without deleting clips or changing mix state.
3. Changing the loop range changes the repeated playback region.
4. The playhead position displayed in the UI matches scheduled audio time within the accepted tolerance.
5. A count-in delays recording start and audibly/visually indicates the pre-roll.
6. Changing BPM updates the grid and tempo-aware clips/patterns consistently.
7. Toggling metronome changes only click output, not session content.
8. Seeking while stopped changes the next playback start position.
9. Seeking during playback reschedules clips from the new position.
10. The transport cannot enter contradictory states such as playing=false and recording=true.
### Tracks
11. Creating an audio track creates a corresponding mixer channel.
12. Renaming a track updates all track labels and command references.
13. Reordering tracks changes visual order without changing clip timing.
14. Muting a track silences every audible clip routed through that track.
15. Soloing a track audibly isolates it according to the defined solo rules.
16. Arming a track determines where new recording clips are placed.
17. Deleting a track removes its clips from playback but does not delete source assets without explicit destructive confirmation.
18. A track meter reflects post-clip, post-effect, or specified metering point consistently.
19. A track output points to exactly one default output bus unless explicit send/bus routing is configured.
20. Track selection is unambiguous before applying track-level Moshi commands.
### Clips
21. Moving a clip later on the timeline makes it play later.
22. Moving a clip to another track changes its routing to that track.
23. Trimming a clip changes its start/end boundaries without changing the source asset.
24. Splitting a clip creates two placed clips that reference the same source asset.
25. Duplicating a clip creates a new clip instance, not a new audio asset by default.
26. Deleting a clip removes it from the arrangement but preserves source media unless explicitly purged.
27. A muted clip is silent even if its track is unmuted.
28. A looped clip repeats only within its defined loop region.
29. Clip gain affects that clip without moving the track fader.
30. Clip fades affect edges without moving clip boundaries.
31. Clip selection is visually distinct from track selection.
32. Multiple clips can reference the same uploaded file with different offsets, trims, and gains.
### Clip grid / scenes
33. Launching a clip slot starts that clip at the next quantization boundary unless quantization is disabled.
34. Launching a clip on a track stops the previously playing clip on that same track.
35. Launching a scene launches the eligible clips in that row together.
36. Scene launch does not launch empty slots as silent audio unless explicitly represented as stop slots.
37. Global launch quantization is applied consistently across users in the same room.
38. A clip grid launch is logged as an edit/play event with user or Moshi source.
39. The UI exposes which clip slots are playing, queued, stopped, and recording.
40. Returning from clip grid playback to arrangement playback is explicit and visible.
### Recording
41. Recording requires microphone permission or a valid audio input source.
42. Recording creates a source asset and at least one placed clip.
43. The recorded clip is playable immediately after recording finishes.
44. The recorded clip lands on the armed/selected track.
45. A failed mic permission flow creates no silent fake clip.
46. Recording start and stop are logged with timestamps and track IDs.
47. Input monitoring state is visible while a track is armed.
48. Recording while playback is running aligns the new clip to the expected playhead time within tolerance.
49. Recording failure reports a recoverable error and preserves existing session state.
50. Undo after recording removes the placed clip and optionally preserves the raw asset according to the retention rule.
### Mixer / FX
51. Increasing track gain makes that track louder unless it is muted or routed away from output.
52. Pan changes left/right balance without changing the clip object.
53. Insert effect order affects the audible output.
54. Bypassing an effect stops that effect from altering audio.
55. Removing an effect removes its automation or marks it orphaned according to policy.
56. A delay/reverb tail is heard after source audio ends unless render/loop range cuts it off.
57. Meters show clipping/overload states when levels exceed defined thresholds.
58. Solo/mute interactions are deterministic and documented.
59. Adding a send increases the signal reaching the return channel.
60. Effect parameters changed by Moshi update UI and audio state together.
### Automation
61. Automation changes a target parameter over time according to its points/curve.
62. Deleting automation returns the parameter to its static value or last valid value by policy.
63. Overlapping automation on the same target is prevented or resolved deterministically.
64. Manual parameter moves during automation show an override or write behavior according to mode.
65. Automation target IDs remain stable across save/load.
66. Automation is included in render/export.
67. Automation edits are undoable.
68. Automation clips/lanes remain visibly associated with their target parameter.
### Browser / media
69. Importing media creates a stable asset ID independent of local filename.
70. A browser preview plays without adding the file to the arrangement unless dropped/confirmed.
71. Missing media is represented visibly and plays silence or an error placeholder, not random audio.
72. Assets used by collaborators are server-hosted or otherwise accessible to all required clients.
73. Replacing a missing asset preserves clip positions, trims, and gains.
74. Search/filter results update without breaking playback.
75. Dragging a sample to a track creates an audio clip at the drop time.
76. Dragging a sample to a pad/sampler creates an instrument/sample mapping, not a timeline clip.
### Export / submission
77. Submitting a battle render locks or snapshots the audible state used for voting.
78. Render captures the intended range: full arrangement, selected section, or battle loop.
79. Render includes mute/solo, gains, effects, and automation exactly as specified.
80. Render does not accidentally export only pattern/loop mode when full song is selected.
81. Reverb/delay tails are included or cut according to an explicit tail policy.
82. A failed render does not create a valid submission.
83. Exported files have playable duration and expected loudness bounds.
84. Stem export names and aligns each stem from the same zero point.
### Patterns / instruments
85. Creating a pattern clip creates or references a target instrument or channel.
86. Pattern playback triggers notes only during the pattern clip range.
87. Quantizing notes changes note start times but not source audio assets.
88. Scale-lock constrains newly added notes without rewriting existing notes unless requested.
89. Changing an instrument preset changes future playback through that instrument track.
90. Muting an instrument track silences all pattern clips routed through it.
91. A pattern duplicated as linked references the same note data; duplicated as unique creates independent note data.
92. A sampler pad trigger is distinct from placing an audio clip on the timeline.
93. Previewing a synth/instrument does not alter the arrangement.
94. Deleting an instrument with active clips creates a clear silent/missing-instrument state or blocks the deletion.
### Undo / history
95. Every state-changing command records enough previous state to undo.
96. Undoing a clip move restores both time and track routing.
97. Undoing a gain edit restores the exact previous numeric gain value.
98. Undoing an effect add removes the effect and its parameter state.
99. Redo reapplies an undone edit without reparsing natural language.
100. Undo history distinguishes user edits from Moshi edits.
101. Undoing a batch command restores every changed target or reports partial undo failure.
102. Non-undoable actions are explicitly marked before execution or treated as transient transport actions.
103. Saving/loading preserves the command history needed for visible edit audit, even if not the full undo stack.
104. History log order matches the actual order that state mutations were applied.
### Latency / performance
105. Audio scheduling uses audio-clock time rather than relying only on UI timers.
106. UI frame drops do not alter scheduled audio timing once clips are scheduled.
107. The engine reports overload/underrun conditions instead of silently drifting.
108. Input latency compensation policy is consistent across recordings in the same session.
109. Heavy effects can be bypassed or degraded without corrupting session state.
110. Waveform generation can complete asynchronously without blocking playback.
111. A suspended AudioContext is resumed through a user gesture before playback is claimed to start.
112. Autoplay/browser permission failures produce visible recoverable errors.
113. A disconnected output/input device produces a clear error and does not delete routing state.
114. Rendered/exported audio is not affected by UI rendering performance.
### Save / load / persistence
115. Saving a session preserves tempo, meter, tracks, clips, assets, effects, mixer, automation, and battle metadata.
116. Loading a session restores visible state before allowing destructive edits.
117. Missing assets on load are represented as missing, not silently replaced.
118. Stable IDs survive save/load and are used by Moshi commands.
119. Forking/remixing creates a new session ID while preserving source lineage.
120. Submitted renders remain accessible even if the live session changes later.
121. Autosave does not interrupt recording or playback.
122. A failed save reports error and preserves local unsaved changes for retry.
123. Version conflicts are resolved by command order, merge policy, or user-visible fork.
124. Deleting a session is separate from deleting user-uploaded reusable assets unless policy says otherwise.
### Security / permissions
125. A spectator cannot execute DAW mutation commands without explicit role permission.
126. A user cannot submit another creator’s entry unless authorized by room rules.
127. Uploaded assets store ownership, room visibility, and reuse permissions.
128. Private room assets are not exposed to public browser search unless published.
129. Moshi cannot bypass permission checks by emitting lower-level commands.
130. Commands that affect all users in a room require host/creator authorization.
131. Exported submissions contain only assets the session is authorized to render.
132. Deleted or hidden assets cannot be resurrected into public sessions without authorization.
133. Audit logs record actor identity for every state-changing command.
134. External URLs used as assets are validated/proxied before playback in a shared room.
### Moshi / agent control
135. Moshi never claims an edit happened unless command execution returns success.
136. Moshi emits typed commands against DAW state, not DOM or React component mutations.
137. Every Moshi edit is logged with raw user text, resolved targets, parameters, result, and undo token.
138. Ambiguous commands resolve using selected track/clip, recent context, or ask a clarification.
139. Moshi cannot invent tracks, clips, effects, or plugins that are not present or installable.
140. Moshi exposes safe defaults for vague requests such as louder, softer, more reverb, or loop this.
141. Moshi refuses or redirects commands that would erase destructive data without confirmation.
142. Moshi distinguishes advice from applied changes.
143. Moshi can undo its own last successful command.
144. Moshi can summarize the current DAW state from authoritative session state.
### Arena / collaboration
145. Room phase controls which actions are allowed: lobby, build, submit, vote, reveal.
146. Submission deadline locks or rejects late edits according to the phase machine.
147. Votes reference immutable submitted renders, not live-changing sessions.
148. Participant presence changes do not corrupt DAW state.
149. Remote edit conflicts resolve deterministically or are serialized through commands.
150. Spectators cannot mutate DAW state unless promoted/authorized.
151. Every battle result is traceable to submissions and votes.
152. A remix/fork preserves lineage to the source session.

## 4. Mosh MVP filter

| Capability | Priority | Minimal acceptable implementation | Why |
| --- | --- | --- | --- |
| DAW shell / layout | P0 | Transport, track list, timeline/clip grid, mixer strip, browser, Moshi panel | Must feel like a real creation surface immediately |
| Transport play/stop/seek/loop | P0 | Playhead, BPM, bars/beats, loop range, count-in | Every workflow depends on it |
| Audio import/upload | P0 | Upload/drag file, decode, create source asset, place audio clip | Battle flow starts from a beat/sample |
| Mic recording | P0 | Permission, choose track, count-in, record blob, create clip, playback | Vocal/rap flow needs this |
| Clip move/trim/split/duplicate | P0 | Drag clips, snap grid, edge resize, duplicate, undo | This is the DAW feel |
| Mixer gain/pan/mute/solo/meters | P0 | Per-track fader, mute, solo, meter, basic pan | Moshi must be able to mix audibly |
| Basic effects | P0 | Reverb, delay, EQ preset, compressor preset, bypass/order | Moshi needs visible/audible wins |
| Moshi typed command execution | P0 | Natural language → command → validate → apply → log → undo | Core interaction layer |
| Battle room/timer/submit/vote/reveal | P0 | Room state, phases, submission lock, playback/voting | This is the wedge |
| Browser preview/search | P0 | Uploaded assets + starter library + preview at room BPM if possible | Sample selection without preview is friction |
| Undo/redo/history | P0 | Every edit command reversible; Moshi edits show applied cards | Prevents fear and agent mistrust |
| Clip grid/scenes | P0/P1 | Grid slots + scene launch for loop battles; P0 if battle mode is jam-first | Ableton-like social sync is a differentiator |
| Pattern/piano roll | P1 | Simple notes, draw, quantize, scale-lock, one synth/sampler | Beatmakers expect it; but upload/recording can carry MVP |
| Automation clips/lanes | P1 | Volume/effect parameter points; record knob move later | Needed for dynamic mix, but not day-one blocker |
| Send/return routing | P1 | One room reverb/delay send; hidden bus model | Useful for CPU and cohesion |
| Stem export | P1 | Render mix plus per-track stems | Needed for creator value beyond battles |
| Comping/take lanes | P2 | Simplified take stack with choose/promote | Important for serious vocals, but scope-heavy |
| Advanced time-stretch/pitch correction | Punt/P2 | Server pre-warp and crude client modes first | Tempting but high risk |
| Full plugin host | Punt | Use built-ins and licensed WAM/WASM later | Licensing/performance trap |
| Real-time remote jamming | Punt | Quantized async multiplayer, not sub-20ms jamming | Network physics trap |

### Non-goals / dangerous traps

- Full third-party plugin host in the first demo. Use built-ins and license-safe components first.
- Real-time remote jamming below human-perceptible latency. Prefer quantized multiplayer state and server/client-rendered playback.
- Advanced time-stretching, pitch correction, stem separation, and mastering. Each can eat the project.
- Mobile parity. Mobile can spectate/vote first; creation can remain desktop-browser-first.
- “AI writes the whole song” as the main demo. Moshi is the engineer/operator, not the ghostwriter.

## 5. First battle session workflow

| Step | User action | Required UI | Required backend/audio | Moshi command | Log event |
| --- | --- | --- | --- | --- | --- |
| Enter room | Create/join room, choose battle type | RoomHeader, participant list | room state, presence | none | event.room.join |
| Import beat | Drag/upload beat or choose sample | BrowserPanel, timeline | asset store, clip create | IMPORT_AUDIO | event.asset.imported |
| Record vocal | Arm track, count-in, record | Transport, recorder, track header | MediaRecorder/Web Audio, asset store | START_RECORDING/STOP_RECORDING | event.record.* |
| Arrange clip | Move/trim/duplicate to hook | Timeline, clip handles | Session IR clip edit | MOVE_CLIP/TRIM_CLIP | event.clip.* |
| Mix with Moshi | “Add reverb and turn my vocal up” | Moshi panel, mixer, effects rack | command executor, mixer state | ADD_EFFECT + SET_TRACK_GAIN | event.command.executed |
| Submit | Render battle range and lock entry | SubmitPanel | render/export worker, submission table | RENDER_MIX + SUBMIT_MIX | event.submission.created |
| Vote | Spectators listen and vote | SubmissionPlayer, VotingPanel | immutable render refs, vote records | CAST_VOTE | event.vote.cast |
| Reveal | Show winner and lineage/fork options | WinnerReveal | battle phase machine | REVEAL_WINNER | event.battle.reveal |

## 6. User workflow research agent output

No actual user interviews were conducted here. This section is the research plan and synthesis template to run with real producers, vocalists, engineers, beatmakers, and casual users.

### Interview questions

1. Which DAWs have you used in the last 30 days, and for what kind of sessions?
2. Walk me through the last session you actually finished, minute by minute for the first 10 minutes.
3. What was the first sound or file you brought into the session?
4. What did you record first, and how did you set up the input?
5. What do you always do before pressing record?
6. How do you decide whether to redo a take or edit the one you have?
7. How do you usually make a hook, loop, or section repeat?
8. What edits do you do without thinking: split, trim, duplicate, mute, move, quantize, etc.?
9. What keyboard shortcuts or gestures would you feel lost without?
10. How do you balance vocal/beat/instruments in a rough mix?
11. What effects do you add almost automatically?
12. What do you ask an engineer or friend to do for you?
13. Where does your current DAW slow you down?
14. What mistakes do you undo most often?
15. When do you use automation, if ever?
16. How do you manage samples, loops, and missing files?
17. How do you export/share rough versions?
18. What has to be real audio behavior versus acceptable visual fake?
19. Would you trust an AI to change your levels? Why or why not?
20. Would you trust an AI to edit timing or pitch? Why or why not?
21. What AI action would feel magical but safe?
22. What AI action would feel invasive or fake?
23. How much latency is tolerable when recording?
24. What would make you quit a browser DAW in the first minute?
25. What would make you believe a browser DAW is real?
26. How would a timed battle change your workflow?
27. Would you rather compete with stems, loops, vocals, or full arrangements?
28. What should spectators be able to hear or see while you work?
29. What should be private until submission?
30. What would make you share/remix someone else’s session?

### Task-based observation protocol

| Task | What to observe | Mosh implication |
| --- | --- | --- |
| Import a beat | Observe source, drag/drop, preview, tempo behavior, where clip lands | P0 browser/import/timeline |
| Record a vocal | Observe permissions/input selection/count-in/monitoring/latency | P0 recording |
| Do a second take | Observe redo/stacking/naming/muting | P2 take stack; P0 redo flow |
| Trim and move a clip | Observe snap, edge handles, selection model, undo | P0 clip editing |
| Split and duplicate a hook | Observe section thinking and keyboard shortcuts | P0 clip operations |
| Add reverb/delay | Observe insert vs send mental model and presets | P0 FX; P1 sends |
| Turn vocal up | Observe track identification and gain staging | P0 mixer + Moshi target resolution |
| Loop 8 bars | Observe loop range, pattern mode, scene thinking | P0/P1 loop range/scenes |
| Export rough mix | Observe render range, tails, file format, share destination | P0 submission render |
| Use an AI helper | Observe trust boundaries, confirmation expectations, undo use | Moshi schema + ambiguity rules |

### Persona / workflow clusters

| Persona | First-5-min needs | Will not forgive | Mosh requirement |
| --- | --- | --- | --- |
| Rapper over beats | Import beat, record vocal, punch/redo, add reverb/delay, submit rough mix | Latency, count-in, vocal level, quick redo | Mic recording, monitoring, gain, reverb, submit |
| Beatmaker/producer | Drum pattern, sample chop/loop, bass/melody, arrange hook/verse | Pattern grid, piano roll, sampler, quantize | P1 pattern/piano roll, sampler, scale-lock |
| Singer-songwriter | Record voice/instrument, comp takes, arrange sections, balance rough mix | Takes, monitoring, timing, export | P0 recording; P2 comping |
| Engineer/mixer | Gain stage, EQ/compress, sends, automation, render stems | Routing, metering, plugin depth, automation | P0 basic mixer; P1 sends/stems |
| Casual browser creator | Use template, drag loops, record one line, ask Moshi | Too much DAW complexity | Guided layouts, Moshi safe defaults |
| Battle spectator | Listen quickly, vote, react, see winner | No friction, fair voting, clear playback | Submission player, vote UI, reveal |
| Power DAW veteran | Keyboard shortcuts, precise edit, undo, routing | Missing fundamentals | Snap, clip model, mixer, undo, non-destructive assets |

### Interview synthesis template

For each participant, capture: DAW used, skill level, common session type, first 10 actions, top repeated commands, biggest pain points, AI trust boundaries, browser DAW concerns, battle-mode reaction, P0/P1/P2 requirement implications, and confidence level.

## 7. Moshi command reality model

### Command families

Transport, track creation/selection, recording, import/browser, clip editing, timeline/scene launching, mixer, effects, routing, automation, render/submission, arena/voting, undo/history, and explanatory assistant state.

### Command execution contract

1. Parse natural language into candidate command(s).
2. Resolve target IDs from current selection, recent context, names, roles, and room ownership.
3. Validate preconditions against authoritative Session IR.
4. Execute through DAW core only.
5. Return structured result: success, partial, failure, undo token, changed IDs, user-visible explanation.
6. UI reflects state; Moshi does not directly mutate React components.
7. Event logger records raw text, parsed command, execution result, and timing.

### Ambiguity rules

| Mode | Use when | Example |
| --- | --- | --- |
| Act immediately | Selected target is clear, operation is reversible, and magnitude can use safe default. | “turn this vocal up” while vocal track is selected → +2 dB |
| Ask clarification | Multiple plausible targets and wrong target would be annoying or destructive. | “delete that” with no selected clip and several recent clips |
| Suggest options | Creative direction is underspecified and multiple useful routes exist. | “make this sound better” → offer vocal clarity / louder / reverb / tighter timing |
| Preview first | Operation changes timing, pitch, destructive cleanup, or large arrangement structure. | “fix my timing” or “cut all silence” |
| Refuse/descope | Request depends on unavailable plugin/model, copyrighted copying, or impossible browser behavior. | “load Auto-Tune Pro” when not installed |
| Apply + explain | Command is safe but non-obvious. | “add room reverb” → creates/uses Room Reverb send and sets vocal send level |

### Top command schema sample

The machine-readable command schema is in `mosh_moshi_command_schema.json`. Representative commands:

| Command | Family | Example | Precondition | Undo |
| --- | --- | --- | --- | --- |
| PLAY | transport | play | audio engine ready | not undoable; transport action logged |
| STOP | transport | stop | session loaded | not undoable |
| SEEK | transport | go to bar 9 | position valid | not undoable |
| SET_LOOP_RANGE | transport | loop these 8 bars | range valid | undoable |
| SET_TEMPO | transport | set bpm to 140 | bpm in range | undoable |
| CREATE_TRACK | track | add a vocal track | track limit not exceeded | delete created track |
| RENAME_TRACK | track | rename this lead vocal | track exists | restore old name |
| ARM_TRACK | recording | arm my mic | track can record | restore armed state |
| START_RECORDING | recording | record me | mic permission and track armed/recordable | not until clip committed |
| STOP_RECORDING | recording | stop recording | recording active | remove placed clip; preserve/discard asset by policy |
| IMPORT_AUDIO | browser/import | import this beat | asset decodable and accessible | remove clip; preserve asset if user library item |
| MOVE_CLIP | clip | move that to the hook | clip exists; target valid | restore previous position |
| TRIM_CLIP | clip | trim the front | boundary valid | restore previous boundaries |
| SPLIT_CLIP | clip | split here | position inside clip | merge back to original clip state |
| DUPLICATE_CLIP | clip | duplicate the hook | clip exists | delete duplicate(s) |
| SET_CLIP_MUTE | clip | mute that take | clip exists | restore previous |
| SET_CLIP_GAIN | clip | turn that clip down | clip exists | restore previous |
| SET_TRACK_GAIN | mixer | turn my vocal up | track exists | restore previous |
| SET_TRACK_PAN | mixer | pan the guitar left | track exists | restore previous |
| SET_TRACK_MUTE | mixer | mute drums | track exists | restore previous |

### Anti-hallucination rules

- Moshi must not say “done” unless the command executor returns success.
- Moshi must not infer nonexistent tracks, clips, samples, plugins, or collaborators.
- Moshi must use stable track/clip IDs internally; display names are only labels.
- Moshi must include an undo affordance for every edit command that changes session state.
- Moshi must distinguish “I suggest” from “I applied.”
- Moshi must not promise latency-free recording in a browser.
- Moshi must not claim professional plugin hosting unless the effect actually exists in the runtime.
- Moshi must validate render/submission range before submitting.
- Moshi must preserve source assets when doing non-destructive edits.
- Moshi must report partial failure when a batch command succeeds on some targets and fails on others.

## 8. QA / evaluation suite

The full CSV regression seed is in `mosh_daw_eval_suite.csv`; Moshi natural-language evals are in `mosh_moshi_eval_prompts.csv`.

### Product spec lint rules

- Mentions recording but does not define input source, arm state, monitoring, count-in, or failure behavior.
- Mentions clips but does not distinguish source media from placed clip instances.
- Mentions moving clips but does not define grid/snap/bypass behavior.
- Mentions effects but does not define insert order and bypass behavior.
- Mentions automation but does not define target parameter identity and conflict resolution.
- Mentions export/submit but does not define render range, tails, mute/solo inclusion, or immutable submission snapshot.
- Mentions collaboration but does not define command serialization/conflict resolution.
- Mentions Moshi actions but does not require typed commands and execution success before “done.”
- Mentions plugin support but does not define available plugin inventory and license constraints.
- Mentions browser audio but does not handle permission, latency, autoplay, or AudioContext resume behavior.

### UI design review checklist

- [ ] Transport visible with play/stop/record, BPM, loop, playhead.
- [ ] Track selection and clip selection are visually distinct.
- [ ] Armed, muted, soloed, and monitored states are visible.
- [ ] Clip boundaries, start, end, and looped state are visible.
- [ ] Snap/grid state and section markers are visible.
- [ ] Browser can preview and drag assets into timeline/grid.
- [ ] Mixer levels, meters, gain, pan, mute, solo are visible.
- [ ] Effects chain order and enabled/bypassed states are visible.
- [ ] Moshi applied edits show target, command, result, and undo.
- [ ] Submit/vote/winner phase state is visible and cannot be confused with editing state.

### Implementation PR checklist

- [ ] Session IR updated and migration considered.
- [ ] Command schema updated if feature is agent-controllable.
- [ ] Undo/redo implemented for state-changing edits.
- [ ] Audio behavior tested, not just UI state.
- [ ] Event logging implemented.
- [ ] Save/load serialization covered.
- [ ] Failure states handled and visible.
- [ ] Browser permissions/latency/performance noted when relevant.
- [ ] No unreviewed license-risk code copied from GitHub.
- [ ] QA cases added to regression suite.

### First automated regression targets

1. Session IR save/load roundtrip.
2. Audio clip import/move/trim/split/duplicate.
3. Transport schedule of two clips on two tracks.
4. Mic recording success and permission failure.
5. Mixer gain/mute/solo and effect bypass.
6. Moshi SET_TRACK_GAIN, ADD_EFFECT, MOVE_CLIP, START_RECORDING, SUBMIT_MIX success/failure.
7. Render range captures audible state and submission immutability.
8. Undo/redo for every edit command.

## 9. Build-order recommendation

### Milestone 1 — DAW Core + Shell
Session IR, tracks, clips, transport, timeline layout, browser stub, mixer stub, undo/logging. Demo: import an audio file and move it on a grid.

### Milestone 2 — Audio engine + Recording
Web Audio engine, scheduling, meters, mic recording, clip creation, count-in, basic render. Demo: record a vocal over an imported beat and play it back.

### Milestone 3 — Moshi operator
Typed command schema, command executor, target resolution, applied-edit cards, undo. Demo: “turn my vocal up,” “add reverb,” “move this to hook,” “submit this.”

### Milestone 4 — Arena loop
Room creation, timer, submissions, spectator player, voting, winner reveal, lineage/fork placeholder. Demo: complete 60-second Mosh battle flow.

## 10. Practical working rule

Every future agent output for Mosh should pass this check: **Does this specify the DAW object, state change, audible result, UI result, failure mode, log event, and undo behavior?** If not, it is still theory.
