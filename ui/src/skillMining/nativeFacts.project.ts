import type { CommandFact } from './nativeFacts';

const TEMPO = 'src/moshops/MoshOps.TempoProject.cpp';
const MIXER = 'src/moshops/MoshOps.Mixer.cpp';

export const PROJECT_FACTS = {
  set_tempo: {
    name: 'Set the song tempo',
    description: 'Set the pace of the song in beats per minute.',
    undo: 'per_mutation',
    args: { bpm: { question: 'What tempo in beats per minute should the song use?', unit: 'BPM', min: 20, max: 999, default: 120, taste: true, source: { file: TEMPO, line: 180 } } },
  },
  set_time_signature: {
    name: 'Set the song’s time signature',
    description: 'Choose how the beats are grouped into bars, such as four quarter-note beats or six eighth-note beats.',
    undo: 'per_mutation',
    args: {
      numerator: { question: 'How many beats should each bar contain?', unit: 'beats per bar', min: 1, max: 32, integer: true, default: 4, taste: true, source: { file: TEMPO, line: 195 } },
      denominator: { question: 'Which note value should count as one beat?', unit: 'note-value denominator', min: 1, max: 32, integer: true, default: 4, taste: true, source: { file: TEMPO, line: 196 }, options: [
        { value: 1, description: 'A whole note' }, { value: 2, description: 'A half note' },
        { value: 4, description: 'A quarter note' }, { value: 8, description: 'An eighth note' },
        { value: 16, description: 'A sixteenth note' }, { value: 32, description: 'A thirty-second note' },
      ], notes: 'Native accepts only 1, 2, 4, 8, 16, or 32; enumerated at MoshOps.TempoProject.cpp:198.' },
    },
  },
  set_key: {
    name: 'Set the song’s musical key',
    description: 'Choose the song’s home note and scale so the project reflects its musical key.',
    undo: 'none',
    args: {
      tonic: {
        question: 'Which tonic should the song use?', taste: true, source: { file: TEMPO, line: 681 },
        options: [
          { value: 'C', description: 'C natural' }, { value: 'C#', description: 'C sharp' },
          { value: 'Db', description: 'D flat' }, { value: 'D', description: 'D natural' },
          { value: 'D#', description: 'D sharp' }, { value: 'Eb', description: 'E flat' },
          { value: 'E', description: 'E natural' }, { value: 'F', description: 'F natural' },
          { value: 'F#', description: 'F sharp' }, { value: 'Gb', description: 'G flat' },
          { value: 'G', description: 'G natural' }, { value: 'G#', description: 'G sharp' },
          { value: 'Ab', description: 'A flat' }, { value: 'A', description: 'A natural' },
          { value: 'A#', description: 'A sharp' }, { value: 'Bb', description: 'B flat' },
          { value: 'B', description: 'B natural' },
        ],
        notes: 'Omission preserves the stored tonic. Accepted spellings are defined at MoshOps.TempoProject.cpp:525; the snapshot fallback A is not a command default.',
      },
      mode: {
        question: 'Which scale or mode should the song use?', taste: true, source: { file: TEMPO, line: 687 },
        options: [
          { value: 'major', description: 'Major scale' }, { value: 'minor', description: 'Minor scale' },
          { value: 'dorian', description: 'Dorian mode' }, { value: 'mixolydian', description: 'Mixolydian mode' },
          { value: 'pentatonic', description: 'Pentatonic scale' }, { value: 'chromatic', description: 'Chromatic scale' },
        ],
        notes: 'Omission preserves the stored mode. Accepted modes are defined at MoshOps.TempoProject.cpp:530; the snapshot fallback minor is not a command default.',
      },
    },
  },
  set_master_volume: {
    name: 'Set the master output level',
    description: 'Adjust the master fader in decibels.',
    undo: 'per_mutation',
    args: { db: { question: 'What master output level in decibels should be used?', unit: 'dB', min: -48, max: 6, default: 0, taste: true, source: { file: MIXER, line: 381 } } },
  },
  set_master_pan: {
    name: 'Set the master stereo position',
    description: 'Adjust the master pan from left through center to right.',
    undo: 'per_mutation',
    args: { pan: { question: 'Where should the master output sit between left and right?', unit: 'pan', min: -1, max: 1, default: 0, taste: true, source: { file: MIXER, line: 394 }, notes: '-1 is left, 0 is center, and 1 is right.' } },
  },
  save: {
    name: 'Save the project',
    description: 'Save the current project to its existing location.',
    undo: 'none',
    args: {},
  },
  undo: {
    name: 'Undo the last edit',
    description: 'Move one step back through the native edit history.',
    undo: 'history',
    args: {},
  },
  redo: {
    name: 'Redo the last undone edit',
    description: 'Move one step forward through the native edit history.',
    undo: 'history',
    args: {},
  },
  set_transport: {
    name: 'Control playback and recording',
    description: 'Start, stop, continue, or reposition playback and set the transport loop.',
    undo: 'none',
    args: {
      action: {
        question: 'What should playback or recording do?', source: { file: TEMPO, line: 42 },
        options: [
          { value: 'play', description: 'Start playback from the current or supplied position' },
          { value: 'stop', description: 'Stop playback or finish recording' },
          { value: 'toggle', description: 'Start or stop playback according to the current state' },
          { value: 'continue', description: 'Continue playback, or stop while retaining the stopped position' },
          { value: 'record', description: 'Begin recording using armed, usable inputs' },
          { value: 'to_start', description: 'Move to the start of the arrangement' },
          { value: 'to_end', description: 'Move to the end of the arrangement' },
        ],
        notes: 'Omission leaves the action empty, allowing position or loop patches. Playback and recording depend on live audio readiness; headless execution is not proof of playback.',
      },
      position: { question: 'Where should the playhead move in seconds?', unit: 'seconds', taste: true, source: { file: TEMPO, line: 158 }, notes: 'Omission does not explicitly seek; the handler declares no numeric range.' },
      loop: { question: 'Should transport looping be enabled?', source: { file: TEMPO, line: 163 }, notes: 'Omission preserves the current loop setting.' },
      loopStart: { question: 'Where should the playback loop begin in seconds?', unit: 'seconds', taste: true, source: { file: TEMPO, line: 166 }, notes: 'Applied only when loopStart and loopEnd are both supplied. Native declares no numeric range.' },
      loopEnd: { question: 'Where should the playback loop end in seconds?', unit: 'seconds', taste: true, source: { file: TEMPO, line: 167 }, notes: 'Applied only when loopStart and loopEnd are both supplied. Native declares no numeric range.' },
    },
  },
  set_metronome: {
    name: 'Set the recording click',
    description: 'Change the metronome’s playback preferences, level, or sounds.',
    undo: 'none',
    args: {
      enabled: { question: 'Should the metronome be enabled?', source: { file: TEMPO, line: 491 }, notes: 'Omission preserves the current setting. At least one recognized click field is required.' },
      emphasizeBars: { question: 'Should the first beat of each bar be accented?', taste: true, source: { file: TEMPO, line: 492 }, notes: 'Omission preserves the current setting.' },
      recordingOnly: { question: 'Should the click play only while recording?', source: { file: TEMPO, line: 493 }, notes: 'Omission preserves the current setting.' },
      level: { question: 'What linear volume should the metronome use?', unit: 'linear gain', min: 0, max: 1, taste: true, source: { file: TEMPO, line: 425 }, notes: 'Omission preserves the current level. The handler accepts 0..1, while the engine clamps the resulting level to 0.2..1.' },
      midiNoteBig: { question: 'Which MIDI note should mark the accented beat?', unit: 'MIDI note number', min: 0, max: 127, integer: true, taste: true, source: { file: TEMPO, line: 432 }, notes: 'Omission preserves the current accented note.' },
      midiNoteSmall: { question: 'Which MIDI note should mark the other beats?', unit: 'MIDI note number', min: 0, max: 127, integer: true, taste: true, source: { file: TEMPO, line: 437 }, notes: 'Omission preserves the current unaccented note.' },
      soundBig: { question: 'Which WAV file should play on the accented beat?', taste: true, source: { file: TEMPO, line: 445 }, notes: 'Requires an existing WAV file; an empty string restores the built-in sound. Omission preserves the current sound.' },
      soundSmall: { question: 'Which WAV file should play on the other beats?', taste: true, source: { file: TEMPO, line: 452 }, notes: 'Requires an existing WAV file; an empty string restores the built-in sound. Omission preserves the current sound.' },
      outputDevice: { question: 'Which output device should play the click?', source: { file: TEMPO, line: 462 }, notes: 'Omission preserves the current output. An empty string or default selects the engine default; live names must resolve through the device manager.' },
    },
  },
} as const satisfies Record<string, CommandFact>;
