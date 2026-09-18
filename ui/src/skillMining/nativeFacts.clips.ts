import type { CommandFact } from './nativeFacts';

const CLIPS = 'src/moshops/MoshOps.Clips.cpp';
const CORE = 'src/moshops/MoshOps.cpp';
const LYRICS = 'src/moshops/MoshOps.Lyrics.cpp';

export const CLIP_FACTS = {
  add_midi_clip: {
    name: 'Create a MIDI clip',
    description: 'Place a MIDI clip on a track; an omitted note list leaves the clip empty.',
    undo: 'per_mutation',
    args: {
      trackId: { question: 'Which track should hold the MIDI clip?', selector: 'tracks[].id', source: { file: CORE, line: 1824 }, notes: 'An absent or unresolved track creates a new audio track. Native may add a default instrument in the same transaction.' },
      start: { question: 'Where should the clip begin in seconds?', unit: 'seconds', default: 0, taste: true, source: { file: CORE, line: 1846 }, notes: 'The handler does not declare a numeric range.' },
      length: { question: 'How many seconds should the clip last?', unit: 'seconds', default: 2, taste: true, source: { file: CORE, line: 1847 }, notes: 'The handler does not declare a numeric range. This is seconds; note lengths inside the clip use beats.' },
      name: { question: 'What should the MIDI clip be called?', default: 'MIDI', source: { file: CORE, line: 1848 } },
    },
  },
  move_clip: {
    name: 'Move a clip',
    description: 'Reposition a clip while keeping its length, optionally moving it to another track.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which clip should move?', selector: 'tracks[].clips[].id', source: { file: CLIPS, line: 340 } },
      start: { question: 'Where should the clip begin in seconds?', unit: 'seconds', min: 0, taste: true, source: { file: CLIPS, line: 374 }, notes: 'Omission retains the current clip start. Active clip-group members move together.' },
      trackId: { question: 'Which track should receive the clip?', selector: 'tracks[].id', source: { file: CLIPS, line: 390 }, notes: 'Omission keeps the current track. A cross-track move cannot use ripple or move a multitrack clip group.' },
      ripple: { question: 'Should later clips on this track move by the same amount?', default: false, source: { file: CLIPS, line: 348 } },
    },
  },
  trim_clip: {
    name: 'Trim a clip',
    description: 'Change a clip’s start, duration, or source offset, with optional movement of later clips.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which clip should be trimmed?', selector: 'tracks[].clips[].id', source: { file: CLIPS, line: 410 } },
      start: { question: 'Where should the trimmed clip begin in seconds?', unit: 'seconds', taste: true, source: { file: CLIPS, line: 415 }, notes: 'Omission retains the current start; the handler declares no numeric range.' },
      length: { question: 'How many seconds should the trimmed clip last?', unit: 'seconds', min: 0.01, taste: true, source: { file: CLIPS, line: 416 }, notes: 'Omission retains the current length.' },
      offset: { question: 'How many seconds into the source should playback begin?', unit: 'seconds', taste: true, source: { file: CLIPS, line: 417 }, notes: 'Omission retains the current source offset; the handler declares no numeric range.' },
      ripple: { question: 'Should later clips follow the change to this clip’s end?', default: false, source: { file: CLIPS, line: 422 } },
    },
  },
  split_clip: {
    name: 'Split a clip',
    description: 'Divide a clip into two clips at a point strictly inside its bounds.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which clip should be split?', selector: 'tracks[].clips[].id', source: { file: CLIPS, line: 448 } },
      time: { question: 'At what time in seconds should the clip split?', unit: 'seconds', taste: true, source: { file: CLIPS, line: 460 }, notes: 'Must resolve strictly inside the current clip, excluding a 0.000001-second edge margin. Native tries absolute time first, then clip-relative time. Omission reads zero, which is not a usable split default.' },
    },
  },
  remove_clip: {
    name: 'Remove a clip',
    description: 'Remove a clip from the arrangement, including its owned hidden render when present.',
    undo: 'per_mutation',
    args: { clipId: { question: 'Which clip should be removed?', selector: 'tracks[].clips[].id', source: { file: CLIPS, line: 702 } } },
  },
  rename_clip: {
    name: 'Name a clip',
    description: 'Give an existing clip a new name.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which clip should be renamed?', selector: 'tracks[].clips[].id', source: { file: CLIPS, line: 720 } },
      name: { question: 'What should the clip be called?', source: { file: CLIPS, line: 723 }, notes: 'The handler accepts an empty name and supplies no meaningful name default.' },
    },
  },
  set_clip_mute: {
    name: 'Set whether a clip is heard',
    description: 'Mute or unmute a clip without removing it.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which clip should change?', selector: 'tracks[].clips[].id', source: { file: CLIPS, line: 731 } },
      mute: { question: 'Should this clip be muted?', default: false, taste: true, source: { file: CLIPS, line: 734 } },
    },
  },
  set_clip_gain: {
    name: 'Set an audio clip’s gain',
    description: 'Adjust an audio clip’s gain in decibels.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which audio clip should change gain?', selector: 'tracks[].clips[].id', source: { file: CLIPS, line: 742 }, notes: 'The selected clip must be an audio clip.' },
      gainDb: { question: 'What gain in decibels should the audio clip use?', unit: 'dB', min: -48, max: 24, default: 0, taste: true, source: { file: CLIPS, line: 745 } },
    },
  },
  duplicate_clip: {
    name: 'Repeat a clip once',
    description: 'Create one copy immediately after the source clip on the same track.',
    undo: 'per_mutation',
    args: { clipId: { question: 'Which clip should be repeated?', selector: 'tracks[].clips[].id', source: { file: CLIPS, line: 1261 }, notes: 'The native command derives the new start from the source end; it has no count or destination argument.' } },
  },
  add_test_tone_clip: {
    name: 'Create a test-tone clip',
    description: 'Generate a stereo sine-wave test tone and import it at the start of the arrangement.',
    undo: 'per_mutation',
    args: {
      seconds: { question: 'How many seconds should the test tone last?', unit: 'seconds', default: 2, taste: true, source: { file: CLIPS, line: 320 }, notes: 'The handler declares no numeric range.' },
      freq: { question: 'What frequency in hertz should the test tone use?', unit: 'Hz', default: 220, taste: true, source: { file: CLIPS, line: 321 }, notes: 'The handler declares no numeric range.' },
      name: { question: 'What should the test-tone clip be called?', source: { file: CLIPS, line: 322 }, notes: 'Omission derives a name from the frequency. Tone-file generation is outside the import undo transaction.' },
      trackId: { question: 'Which track should hold the test tone?', selector: 'tracks[].id', source: { file: CLIPS, line: 330 }, notes: 'Import falls back to the first audio track, or creates one if necessary; see MoshOps.Clips.cpp:213.' },
    },
  },
  build_skeleton_from_clip: {
    name: 'Build a lyric structure from a take',
    description: 'Extract a proposed lyric structure from an audio take onto its track; a successful result lands in one undo transaction.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which audio take should supply the lyric structure?', selector: 'tracks[].clips[].id', source: { file: LYRICS, line: 774 }, notes: 'Requires readable source audio and a track without an existing lyric sheet. Undo begins when the result lands, at line 816, not when asynchronous work starts.' },
      grid: { question: 'What rhythmic grid should guide the lyric structure?', default: '1/16', taste: true, source: { file: LYRICS, line: 775 }, notes: 'Native forwards the grid to the skeleton service without declaring a finite domain.' },
      wait: { question: 'Should this call wait for the lyric structure to finish?', default: false, source: { file: LYRICS, line: 894 } },
    },
  },
} as const satisfies Record<string, CommandFact>;
