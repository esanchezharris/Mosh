export type WorkflowProfileId = "mosh" | "fl";
export type WorkflowMaturity = "native" | "beta";
export type WorkflowCapabilityStatus = "supported" | "divergence" | "deferred";

export interface WorkflowWorkspace {
  browserOpen: boolean;
  browserTab: string;
  rightOpen: boolean;
  sectionZoom: string;
  drumWindowOpen: boolean;
}

export type WorkflowWorkspaceOverride = Partial<WorkflowWorkspace>;

export interface WorkflowVisualPolicy {
  skin: "mosh";
  branding: "mosh";
  theme: "preserve";
}

export interface WorkflowCapability {
  id: string;
  label: string;
  status: WorkflowCapabilityStatus;
  note?: string;
}

export interface WorkflowProfile {
  id: WorkflowProfileId;
  label: string;
  maturity: WorkflowMaturity;
  v2Available: true;
  keymapId: string;
  gestureTableId: string;
  visualPolicy: WorkflowVisualPolicy;
  strictMouseSupported: boolean;
  workspaceDefaults: WorkflowWorkspace;
  capabilities: WorkflowCapability[];
}

const COMMON_CAPABILITIES: WorkflowCapability[] = [
  { id: "transport", label: "Transport and timeline", status: "supported" },
  { id: "arrangement", label: "Arrangement editing", status: "supported" },
  { id: "midi", label: "MIDI and piano-roll editing", status: "supported" },
  { id: "drums", label: "Drum pattern editing", status: "supported" },
  { id: "native-menu", label: "Native menu ownership", status: "deferred" },
];

const MOSH_CAPABILITIES: WorkflowCapability[] = COMMON_CAPABILITIES.map((row) => ({ ...row }));
const FL_CAPABILITIES: WorkflowCapability[] = [
  { id: "transport", label: "Transport and timeline", status: "supported" },
  { id: "arrangement", label: "Arrangement editing", status: "divergence", note: "FL keeps its own behavioral vocabulary." },
  { id: "midi", label: "MIDI and piano-roll editing", status: "divergence", note: "FL gesture and keymap behavior is selected without changing visual identity." },
  { id: "drums", label: "Drum pattern editing", status: "divergence", note: "The channel-rack/drum-window intent starts on." },
  { id: "native-menu", label: "Native menu ownership", status: "deferred" },
];

export const WORKFLOW_PROFILES: Record<WorkflowProfileId, WorkflowProfile> = {
  mosh: {
    id: "mosh",
    label: "Mosh",
    maturity: "native",
    v2Available: true,
    keymapId: "mosh",
    gestureTableId: "mosh",
    visualPolicy: { skin: "mosh", branding: "mosh", theme: "preserve" },
    strictMouseSupported: false,
    workspaceDefaults: {
      browserOpen: false,
      browserTab: "sounds",
      rightOpen: true,
      sectionZoom: "16b",
      drumWindowOpen: false,
    },
    capabilities: MOSH_CAPABILITIES,
  },
  fl: {
    id: "fl",
    label: "FL",
    maturity: "beta",
    v2Available: true,
    keymapId: "fl",
    gestureTableId: "fl",
    visualPolicy: { skin: "mosh", branding: "mosh", theme: "preserve" },
    strictMouseSupported: true,
    workspaceDefaults: {
      browserOpen: true,
      browserTab: "sounds",
      rightOpen: true,
      sectionZoom: "16b",
      drumWindowOpen: true,
    },
    capabilities: FL_CAPABILITIES,
  },
};

export const WORKFLOW_PROFILE_IDS: WorkflowProfileId[] = ["mosh", "fl"];
export const DEFAULT_WORKFLOW_PROFILE_ID: WorkflowProfileId = "mosh";

export function getWorkflowProfile(id: unknown): WorkflowProfile {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(WORKFLOW_PROFILES, id)
    ? WORKFLOW_PROFILES[id as WorkflowProfileId]
    : WORKFLOW_PROFILES[DEFAULT_WORKFLOW_PROFILE_ID];
}

export const workflowProfiles = WORKFLOW_PROFILES;
export const workflowProfile = getWorkflowProfile;
