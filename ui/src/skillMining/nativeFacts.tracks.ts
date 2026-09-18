import type { CommandFact } from './nativeFacts';

const TRACKS = 'src/moshops/MoshOps.Tracks.cpp';
const PLUGINS = 'src/moshops/MoshOps.Plugins.cpp';
const TRACK_TYPES = [
  { value: 'audio', description: 'An ordinary track for audio or an instrument' },
  { value: 'drum', description: 'A drum track with a sampler and bundled kit' },
] as const;

export const TRACK_FACTS = {
  create_track: {
    name: 'Create a track',
    description: 'Add an audio or drum track to the end of the track list.',
    undo: 'per_mutation',
    args: {
      name: { question: 'What should the new track be called?', source: { file: TRACKS, line: 128 }, notes: 'Omission leaves the engine-generated track name; see MoshOps.cpp:3031.' },
      type: { question: 'Should this be an audio track or a drum track?', default: 'audio', options: TRACK_TYPES, source: { file: TRACKS, line: 123 } },
    },
  },
  rename_track: {
    name: 'Name a track',
    description: 'Give an existing audio track or group track a new name.',
    undo: 'per_mutation',
    args: {
      trackId: { question: 'Which track should be renamed?', selector: 'tracks[].id', source: { file: TRACKS, line: 171 }, notes: 'Group tracks are also accepted.' },
      name: { question: 'What should the track be called?', source: { file: TRACKS, line: 177 }, notes: 'The handler accepts an empty name and supplies no meaningful name default.' },
    },
  },
  remove_track: {
    name: 'Remove a track',
    description: 'Remove an audio track and its clips and plugins from the project.',
    undo: 'per_mutation',
    args: { trackId: { question: 'Which track should be removed?', selector: 'tracks[].id', source: { file: TRACKS, line: 319 }, notes: 'Requires an audio track. Native first saves dirty project state as crash protection before plugin teardown.' } },
  },
  set_track_volume: {
    name: 'Set a track’s level',
    description: 'Set the track fader in decibels; linked tracks may follow its change.',
    undo: 'per_mutation',
    args: {
      trackId: { question: 'Which track should change level?', selector: 'tracks[].id', source: { file: TRACKS, line: 864 }, notes: 'An audio track or a group track with a volume plugin is accepted.' },
      db: { question: 'What fader level in decibels should the track use?', unit: 'dB', default: 0, taste: true, source: { file: TRACKS, line: 892 }, notes: 'The selected-track request is passed to the native fader without a handler clamp. Only linked follower values are explicitly clamped to -70..6 dB; that is not an input bound.' },
    },
  },
  set_track_pan: {
    name: 'Place a track in stereo',
    description: 'Set the track’s pan; linked tracks may follow its change.',
    undo: 'per_mutation',
    args: {
      trackId: { question: 'Which track should change stereo position?', selector: 'tracks[].id', source: { file: TRACKS, line: 912 }, notes: 'Requires an audio track.' },
      pan: { question: 'Where should the track sit between left and right?', unit: 'pan', min: -1, max: 1, default: 0, taste: true, source: { file: TRACKS, line: 923 }, notes: '-1 is left, 0 is center, and 1 is right.' },
    },
  },
  set_track_mute: {
    name: 'Set whether a track is heard',
    description: 'Mute or unmute the track and tracks linked to its mute control.',
    undo: 'per_mutation',
    args: {
      trackId: { question: 'Which track should change mute state?', selector: 'tracks[].id', source: { file: TRACKS, line: 942 }, notes: 'Requires an audio track.' },
      mute: { question: 'Should this track be muted?', default: false, taste: true, source: { file: TRACKS, line: 955 } },
    },
  },
  set_track_solo: {
    name: 'Solo a track',
    description: 'Set the track’s solo state, including tracks linked to its solo control.',
    undo: 'per_mutation',
    args: {
      trackId: { question: 'Which track should change solo state?', selector: 'tracks[].id', source: { file: TRACKS, line: 964 }, notes: 'Requires an audio track.' },
      solo: { question: 'Should this track be soloed?', default: false, taste: true, source: { file: TRACKS, line: 970 } },
    },
  },
  arm_track: {
    name: 'Prepare a track to record',
    description: 'Arm or disarm the selected track’s recording input.',
    undo: 'none',
    args: {
      trackId: { question: 'Which track should change record-arm state?', selector: 'tracks[].id', source: { file: TRACKS, line: 996 }, notes: 'Requires an audio track. Check result data.applied: headless or missing-input execution may make no change.' },
      armed: { question: 'Should this track be armed for recording?', default: false, source: { file: TRACKS, line: 998 } },
    },
  },
  set_input_monitor: {
    name: 'Set live input monitoring',
    description: 'Choose whether the selected track’s input is monitored off, automatically, or on.',
    undo: 'none',
    args: {
      trackId: { question: 'Which track’s input should be monitored?', selector: 'tracks[].id', source: { file: TRACKS, line: 1302 }, notes: 'Monitoring belongs to the shared physical input device, so other tracks using it share the change. Check data.applied.' },
      mode: { question: 'When should the live input be heard?', default: 'automatic', options: [{ value: 'off', description: 'Disable input monitoring' }, { value: 'automatic', description: 'Let the native input device manage monitoring automatically' }, { value: 'on', description: 'Enable input monitoring' }], source: { file: TRACKS, line: 1308 }, notes: 'The automatic default applies only when neither mode nor legacy monitor is supplied.' },
      monitor: { question: 'Should live input monitoring be on?', source: { file: TRACKS, line: 1310 }, notes: 'Legacy boolean maps true to on and false to off; an explicit mode takes precedence. Omission alone does not mean false.' },
    },
  },
  set_track_type: {
    name: 'Set a track’s instrument role',
    description: 'Choose audio or drum behavior; drum mode ensures a default drum instrument.',
    undo: 'per_mutation',
    args: {
      trackId: { question: 'Which track should change role?', selector: 'tracks[].id', source: { file: PLUGINS, line: 262 }, notes: 'Requires an audio track.' },
      type: { question: 'Should this be an audio track or a drum track?', default: 'audio', options: TRACK_TYPES, source: { file: PLUGINS, line: 265 }, notes: 'Choosing audio changes the type flag without explicitly removing an existing instrument.' },
    },
  },
  load_drum_kit: {
    name: 'Load a drum kit',
    description: 'Load an available kit into the track’s sampler, creating the sampler when needed.',
    undo: 'per_mutation',
    args: {
      trackId: { question: 'Which track should receive the drum kit?', selector: 'tracks[].id', source: { file: PLUGINS, line: 288 }, notes: 'Requires an audio track.' },
      kit: { question: 'Which available drum kit should be loaded?', selector: 'list_drum_kits:data.kits[].id', taste: true, source: { file: PLUGINS, line: 293 }, notes: 'Resolve only available kits from the native list_drum_kits result. Omission chooses the bundled default identified by data.defaultKit; availability remains environment-dependent.' },
    },
  },
  open_plugin_editor: {
    name: 'Open a plugin’s controls',
    description: 'Open the native editor for a plugin already loaded on a track.',
    undo: 'none',
    args: {
      trackId: { question: 'Which track holds the plugin?', selector: 'tracks[].id', source: { file: PLUGINS, line: 1452 } },
      index: { question: 'Which loaded plugin’s controls should open?', min: 0, integer: true, selector: 'tracks[].plugins[].index', source: { file: PLUGINS, line: 1454 }, notes: 'Use the snapshot plugin.index for the chosen track, not its visible array position. Omission reads -1 and fails plugin lookup; there is no valid static default or maximum.' },
    },
  },
} as const satisfies Record<string, CommandFact>;
