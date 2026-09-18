import { CLIP_FACTS } from './nativeFacts.clips';
import { NOTE_FACTS } from './nativeFacts.notes';
import { PROJECT_FACTS } from './nativeFacts.project';
import { TRACK_FACTS } from './nativeFacts.tracks';

export type ArgumentFact = {
  readonly question: string;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly default?: string | number | boolean;
  readonly options?: readonly { readonly value: string | number; readonly description: string }[];
  readonly selector?: string;
  readonly taste?: boolean;
  readonly source: { readonly file: string; readonly line: number };
  readonly notes?: string;
};

export type CommandFact = {
  readonly name: string;
  readonly description: string;
  readonly undo: 'per_mutation' | 'none' | 'history';
  readonly args: Readonly<Record<string, ArgumentFact>>;
};

export const COMMAND_FACTS: Record<string, CommandFact> = {
  ...CLIP_FACTS,
  ...NOTE_FACTS,
  ...PROJECT_FACTS,
  ...TRACK_FACTS,
};
