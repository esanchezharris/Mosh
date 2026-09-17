import type { CommandFact } from './nativeFacts';

const NOTES = 'src/moshops/MoshOps.Notes.cpp';
const CORE = 'src/moshops/MoshOps.cpp';

export const NOTE_FACTS = {
  add_note: {
    name: 'Add a MIDI note',
    description: 'Place a note in a MIDI clip using beat positions within its note sequence.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which MIDI clip should receive the note?', selector: 'tracks[].clips[].id', source: { file: CORE, line: 2452 }, notes: 'Requires a MIDI clip.' },
      pitch: { question: 'Which MIDI pitch should the note play?', unit: 'MIDI note number', min: 0, max: 127, integer: true, default: 60, taste: true, source: { file: CORE, line: 2475 } },
      start: { question: 'At which beat within the clip should the note begin?', unit: 'beats', min: 0, default: 0, taste: true, source: { file: CORE, line: 2476 } },
      length: { question: 'How many beats should the note last?', unit: 'beats', min: 0.0625, default: 1, taste: true, source: { file: CORE, line: 2477 }, notes: 'The minimum kMinMidiNoteBeats is defined at MoshOps.cpp:40.' },
      velocity: { question: 'How strongly should the note be played?', unit: 'MIDI velocity', min: 1, max: 127, integer: true, default: 100, taste: true, source: { file: CORE, line: 2478 } },
    },
  },
  remove_note: {
    name: 'Remove a MIDI note',
    description: 'Delete a chosen note from an existing MIDI clip while keeping the rest of the phrase.',
    undo: 'per_mutation',
    args: {
      clipId: { question: 'Which MIDI clip contains the note?', selector: 'tracks[].clips[].id', source: { file: CORE, line: 2513 }, notes: 'Requires a MIDI clip.' },
      noteIndex: { question: 'Which note in that MIDI clip should be removed?', min: 0, integer: true, selector: 'tracks[].clips[].notes[].i', source: { file: CORE, line: 2516 }, notes: 'Use the current snapshot note.i. The maximum depends on the current sequence length; omission reads -1 and is invalid.' },
    },
  },
  create_section: {
    name: 'Mark a song section',
    description: 'Add a named section such as an intro, verse, or chorus over a beat range.',
    undo: 'per_mutation',
    args: {
      name: { question: 'What should the section be called?', source: { file: NOTES, line: 120 }, notes: 'The handler accepts an empty name and supplies no meaningful name default.' },
      startBeat: { question: 'At which beat should the section begin?', unit: 'beats', default: 0, taste: true, source: { file: NOTES, line: 121 }, notes: 'The handler declares no numeric range or ordering constraint.' },
      endBeat: { question: 'At which beat should the section end?', unit: 'beats', taste: true, source: { file: NOTES, line: 122 }, notes: 'Omission uses the supplied startBeat plus 16 beats. The handler declares no numeric range or ordering constraint.' },
      color: { question: 'What color should identify the section?', source: { file: NOTES, line: 123 }, notes: 'The handler accepts a string without declaring a finite color domain; an empty value leaves section color unset.' },
    },
  },
  rename_section: {
    name: 'Name a song section',
    description: 'Change the name of an existing song section.',
    undo: 'per_mutation',
    args: {
      sectionId: { question: 'Which song section should be renamed?', selector: 'sections[].id', source: { file: NOTES, line: 144 } },
      name: { question: 'What should the song section be called?', source: { file: NOTES, line: 145 }, notes: 'The handler accepts an empty name and supplies no meaningful name default.' },
    },
  },
  move_section: {
    name: 'Change a song section’s range',
    description: 'Set the beginning and end of a section marker without moving its clips.',
    undo: 'per_mutation',
    args: {
      sectionId: { question: 'Which song section should change range?', selector: 'sections[].id', source: { file: NOTES, line: 159 } },
      startBeat: { question: 'At which beat should the section begin?', unit: 'beats', default: 0, taste: true, source: { file: NOTES, line: 160 }, notes: 'Omission writes zero; it does not retain the existing start. The handler declares no numeric range.' },
      endBeat: { question: 'At which beat should the section end?', unit: 'beats', default: 0, taste: true, source: { file: NOTES, line: 161 }, notes: 'Omission writes zero; it does not retain the existing end. The handler declares no numeric range or ordering constraint.' },
    },
  },
  remove_section: {
    name: 'Remove a song-section marker',
    description: 'Remove the named section marker while leaving arrangement clips in place.',
    undo: 'per_mutation',
    args: { sectionId: { question: 'Which song-section marker should be removed?', selector: 'sections[].id', source: { file: NOTES, line: 176 } } },
  },
  create_annotation: {
    name: 'Leave an arrangement note',
    description: 'Add a written note at a beat position in the arrangement.',
    undo: 'per_mutation',
    args: {
      text: { question: 'What should the arrangement note say?', source: { file: NOTES, line: 575 }, notes: 'The handler accepts empty text and supplies no meaningful text default.' },
      beat: { question: 'At which beat should the arrangement note appear?', unit: 'beats', default: 0, taste: true, source: { file: NOTES, line: 576 }, notes: 'The handler declares no numeric range.' },
      color: { question: 'What color should identify the arrangement note?', source: { file: NOTES, line: 577 }, notes: 'The handler accepts a string without declaring a finite color domain.' },
      author: { question: 'Who should be credited for this arrangement note?', source: { file: NOTES, line: 578 }, notes: 'Omission leaves the author empty.' },
      annotationId: { question: 'What stable identifier should this new arrangement note use?', source: { file: NOTES, line: 582 }, notes: 'This is a caller-provided creation identity, not a selector for an existing note. Omission generates a new UUID. Reusing an existing ID does not append another annotation.' },
    },
  },
} as const satisfies Record<string, CommandFact>;
