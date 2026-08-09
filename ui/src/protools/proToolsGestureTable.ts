import { EditorAction as A } from "../interaction/actions";
import type { GestureRule, GestureTable } from "../interaction/gestures";
import type { ProToolsMedia, ProToolsTool } from "./smartTool";

const COMMON: GestureRule[] = [
  { region: "clip", gesture: "click", action: A.SELECT },
  { region: "clip", gesture: "dblclick", action: A.OPEN },
  { region: "clip", gesture: "contextmenu", action: A.CONTEXT_MENU },
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
];

export function proToolsGestureTable(
  media: ProToolsMedia,
  smartToolEnabled: boolean,
  activeTool: ProToolsTool,
): GestureTable {
  if (smartToolEnabled) return [
    ...COMMON,
    ...(media === "audio"
      ? [
          { region: "clip.header", gesture: "drag", action: A.TIME_SELECT },
          { region: "clip.body", gesture: "drag", action: A.MOVE },
        ] satisfies GestureRule[]
      : [{ region: "clip", gesture: "drag", action: A.MOVE }] satisfies GestureRule[]),
    { region: "clip.edge", gesture: "drag", action: A.TRIM },
  ];

  const dragRule: GestureRule | null = activeTool === "selector"
    ? { region: "clip", gesture: "drag", action: A.TIME_SELECT }
    : activeTool === "grabber"
      ? { region: "clip", gesture: "drag", action: A.MOVE }
      : activeTool === "trimmer"
        ? { region: "clip.edge", gesture: "drag", action: A.TRIM }
        : null;
  return dragRule ? [...COMMON, dragRule] : COMMON;
}
