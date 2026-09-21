import type { CSSProperties, MouseEventHandler, ReactElement } from "react";
import type { AgentState, ColorwayId } from "../index";

export interface SplatAgentProps {
  colorway?: ColorwayId | string;
  state?: AgentState | string;
  seed?: number;
  size?: number;
  className?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLCanvasElement>;
  title?: string;
  reducedMotion?: boolean;
}

export function SplatAgent(props: SplatAgentProps): ReactElement;
export default SplatAgent;
