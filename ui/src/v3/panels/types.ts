import type { ComponentType } from "react";
import type { Plugin } from "../../types";

/** What every native plugin panel is given. Panels never call `exec` themselves: every
 *  change goes through setParam / setState, so the row decides how commands are sent. */
export type PanelProps = {
  plugin: Plugin;
  trackId: string;
  /** The session's sample rate (the rate the plugin runs at during playback); 48000 when
   *  there is no audio device. Curves that depend on it (filters near Nyquist) use it. */
  sampleRate: number;
  /** set_plugin_param with a normalised 0-1 value. Pass the same `gesture` for every step
   *  of one drag so the whole drag is one undo step. */
  setParam: (paramIndex: number, norm: number, opts?: { gesture?: string }) => void;
  /** set_plugin_state for a setting in `plugin.state`. */
  setState: (key: string, value: number | string, opts?: { gesture?: string }) => void;
};

export type PanelDef = {
  Panel: ComponentType<PanelProps>;
  /** One line of text for the minimized row, e.g. "Lo +3.0 dB · 3.0k -2.0 dB". */
  summary: (plugin: Plugin) => string;
  /** An optional tiny element for the minimized row (at most about 72×16 px), e.g. a live
   *  gain-reduction bar or a curve thumbnail. */
  Mini?: ComponentType<PanelProps>;
};
