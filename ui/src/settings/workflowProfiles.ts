export type WorkflowProfileId = "mosh" | "fl";
export type WorkflowMaturity = "native" | "beta";
export type WorkflowCapabilityStatus = "supported" | "divergence" | "deferred";
export type WorkflowCapabilityDelivery = "wired" | "integration-pending" | "deferred";
export type WorkflowBrowserTab = "sounds" | "plugins";
export type WorkflowSectionZoom = "8b" | "16b" | "full";
export type WorkflowCapabilityScope = "safe-default" | "strict-fl-mouse";
export type WorkflowCapabilitySurface =
  | "global"
  | "arrangement"
  | "workspace"
  | "piano-roll"
  | "drum-editor"
  | "product"
  | "project";

export function isWorkflowBrowserTab(value: unknown): value is WorkflowBrowserTab {
  return value === "sounds" || value === "plugins";
}

export function isWorkflowSectionZoom(value: unknown): value is WorkflowSectionZoom {
  return value === "8b" || value === "16b" || value === "full";
}

export interface WorkflowWorkspace {
  browserOpen: boolean;
  browserTab: WorkflowBrowserTab;
  rightOpen: boolean;
  sectionZoom: WorkflowSectionZoom;
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
  delivery: WorkflowCapabilityDelivery;
  surface: WorkflowCapabilitySurface;
  scope: WorkflowCapabilityScope;
  input?: string;
  note: string;
  sourceUrl?: string;
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
  readonly reservedKeyCombos: readonly string[];
  workspaceDefaults: WorkflowWorkspace;
  capabilities: WorkflowCapability[];
}

const COMMON_CAPABILITIES: WorkflowCapability[] = [
  { id: "transport", label: "Transport and timeline", status: "supported", delivery: "wired", surface: "global", scope: "safe-default", note: "Mosh-native transport and timeline behavior." },
  { id: "arrangement", label: "Arrangement editing", status: "supported", delivery: "wired", surface: "arrangement", scope: "safe-default", note: "Mosh-native arrangement editing behavior." },
  { id: "midi", label: "MIDI and piano-roll editing", status: "supported", delivery: "wired", surface: "piano-roll", scope: "safe-default", note: "Mosh-native MIDI and piano-roll behavior." },
  { id: "drums", label: "Drum pattern editing", status: "supported", delivery: "wired", surface: "drum-editor", scope: "safe-default", note: "Mosh-native drum editing behavior." },
  { id: "native-menu", label: "Native menu ownership", status: "deferred", delivery: "deferred", surface: "workspace", scope: "safe-default", note: "Verified only by the later packaged-app integration gate." },
];

const MOSH_CAPABILITIES: WorkflowCapability[] = COMMON_CAPABILITIES.map((row) => ({ ...row }));
const FL_SHORTCUTS = "https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm";
const FL_PLAYLIST = "https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/playlist.htm";
const FL_PIANO_ROLL = "https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm";
const FL_CHANNEL_RACK = "https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/channelrack.htm";

const FL_CAPABILITIES: WorkflowCapability[] = [
  { id: "shortcut.play-pause", label: "Play / pause", status: "supported", delivery: "wired", surface: "global", scope: "safe-default", input: "Space", note: "Toggles transport playback.", sourceUrl: FL_SHORTCUTS },
  { id: "shortcut.record", label: "Record", status: "supported", delivery: "wired", surface: "global", scope: "safe-default", input: "R", note: "Starts or stops recording.", sourceUrl: FL_SHORTCUTS },
  { id: "shortcut.open", label: "Open project", status: "supported", delivery: "wired", surface: "global", scope: "safe-default", input: "Mod+O", note: "Opens a Mosh project.", sourceUrl: FL_SHORTCUTS },
  { id: "shortcut.save", label: "Save project", status: "supported", delivery: "wired", surface: "global", scope: "safe-default", input: "Mod+S", note: "Saves the current Mosh project.", sourceUrl: FL_SHORTCUTS },
  { id: "shortcut.save-as", label: "Save project as", status: "supported", delivery: "wired", surface: "global", scope: "safe-default", input: "Mod+Shift+S", note: "Saves the Mosh project to a new file.", sourceUrl: FL_SHORTCUTS },
  { id: "shortcut.export-audio", label: "Export audio", status: "supported", delivery: "wired", surface: "global", scope: "safe-default", input: "Mod+R", note: "Opens Mosh audio export.", sourceUrl: FL_SHORTCUTS },

  { id: "arrangement.block-tool", label: "Duplicate selection", status: "supported", delivery: "wired", surface: "arrangement", scope: "safe-default", input: "Mod+B", note: "Duplicates the selected arrangement content.", sourceUrl: FL_SHORTCUTS },
  { id: "arrangement.split-tool", label: "Split tool", status: "supported", delivery: "wired", surface: "arrangement", scope: "safe-default", input: "C", note: "Selects the Mosh Split tool.", sourceUrl: FL_SHORTCUTS },
  { id: "arrangement.select-tool", label: "Select tool", status: "supported", delivery: "wired", surface: "arrangement", scope: "safe-default", input: "E", note: "Selects the arrangement range tool.", sourceUrl: FL_SHORTCUTS },
  { id: "arrangement.snap-bypass", label: "Snap bypass", status: "supported", delivery: "integration-pending", surface: "arrangement", scope: "safe-default", input: "Option-drag", note: "FL contract target for temporary snap bypass; hot v2 drag integration is pending.", sourceUrl: FL_PLAYLIST },

  { id: "view.playlist", label: "Arrangement", status: "supported", delivery: "integration-pending", surface: "workspace", scope: "safe-default", input: "F5", note: "FL binding targets the Mosh Arrangement action; hot v2 workspace integration is pending.", sourceUrl: FL_SHORTCUTS },
  { id: "view.channel-rack", label: "Drum window", status: "supported", delivery: "integration-pending", surface: "workspace", scope: "safe-default", input: "F6", note: "FL binding targets the Mosh Drum window action; hot v2 workspace integration is pending.", sourceUrl: FL_SHORTCUTS },
  { id: "view.piano-roll", label: "Piano Roll", status: "supported", delivery: "integration-pending", surface: "workspace", scope: "safe-default", input: "F7", note: "FL binding targets the Mosh Piano Roll action; hot v2 workspace integration is pending.", sourceUrl: FL_SHORTCUTS },
  { id: "view.mixer", label: "Mixer", status: "supported", delivery: "integration-pending", surface: "workspace", scope: "safe-default", input: "F9", note: "FL binding targets the Mosh Mixer action; hot v2 workspace integration is pending.", sourceUrl: FL_SHORTCUTS },
  { id: "view.browser", label: "Browser / Sample Browser", status: "supported", delivery: "integration-pending", surface: "workspace", scope: "safe-default", input: "Alt/Opt+F8", note: "FL Sample Browser binding targets the generic Mosh Browser action; hot v2 workspace integration is pending.", sourceUrl: FL_SHORTCUTS },

  { id: "mouse.arrangement-clip-context", label: "Erase clip or open menu", status: "supported", delivery: "integration-pending", surface: "arrangement", scope: "strict-fl-mouse", input: "Right-click / Shift+Right-click", note: "Strict FL contract target for clip erase and Shift-menu; hot v2 mouse integration is pending.", sourceUrl: FL_PLAYLIST },
  { id: "mouse.arrangement-empty-deselect", label: "Deselect arrangement", status: "supported", delivery: "integration-pending", surface: "arrangement", scope: "strict-fl-mouse", input: "Right-click empty", note: "Strict FL contract target for empty-space deselection; hot v2 mouse integration is pending.", sourceUrl: FL_PLAYLIST },
  { id: "mouse.piano-note-erase", label: "Erase piano note", status: "supported", delivery: "integration-pending", surface: "piano-roll", scope: "strict-fl-mouse", input: "Right-click note", note: "Strict FL contract target for note erase; hot v2 mouse integration is pending.", sourceUrl: FL_PIANO_ROLL },
  { id: "mouse.piano-empty-deselect", label: "Deselect piano notes", status: "supported", delivery: "integration-pending", surface: "piano-roll", scope: "strict-fl-mouse", input: "Right-click empty", note: "Strict FL contract target for empty-space deselection; hot v2 mouse integration is pending.", sourceUrl: FL_PIANO_ROLL },
  { id: "mouse.drum-step-toggle", label: "Toggle drum step", status: "supported", delivery: "integration-pending", surface: "drum-editor", scope: "strict-fl-mouse", input: "Left-click / Right-click", note: "Strict FL contract target for left-activate/right-deactivate; hot v2 mouse integration is pending.", sourceUrl: FL_CHANNEL_RACK },

  { id: "divergence.undo-redo", label: "Conventional undo / redo", status: "divergence", delivery: "wired", surface: "global", scope: "safe-default", input: "Mod+Z / Mod+Shift+Z", note: "Mosh keeps conventional undo and redo instead of FL's last-edit toggle.", sourceUrl: FL_SHORTCUTS },
  { id: "divergence.visual-identity", label: "Mosh visual identity", status: "divergence", delivery: "wired", surface: "product", scope: "safe-default", note: "The FL profile changes behavior only; Mosh branding, skin, and theme remain active." },
  { id: "divergence.project-model", label: "Mosh project model", status: "divergence", delivery: "wired", surface: "project", scope: "safe-default", note: "Projects remain Mosh projects and use Mosh's project model." },

  { id: "deferred.step-edit", label: "Step Edit", status: "deferred", delivery: "deferred", surface: "piano-roll", scope: "safe-default", input: "Mod+E", note: "Reserved for a future Step Edit implementation and intentionally unbound.", sourceUrl: FL_SHORTCUTS },
  { id: "deferred.paint-tool", label: "Paint tool", status: "deferred", delivery: "deferred", surface: "arrangement", scope: "safe-default", input: "B", note: "Paint tool is not in FL v1.", sourceUrl: FL_PLAYLIST },
  { id: "deferred.draw-tool", label: "Draw tool", status: "deferred", delivery: "deferred", surface: "arrangement", scope: "safe-default", input: "P", note: "Draw tool is not in FL v1.", sourceUrl: FL_PLAYLIST },
  { id: "deferred.delete-tool", label: "Delete tool", status: "deferred", delivery: "deferred", surface: "arrangement", scope: "safe-default", input: "D", note: "Delete tool is not in FL v1.", sourceUrl: FL_PLAYLIST },
  { id: "deferred.slip-tool", label: "Slip tool", status: "deferred", delivery: "deferred", surface: "arrangement", scope: "safe-default", input: "S", note: "Slip tool is not in FL v1.", sourceUrl: FL_PLAYLIST },
  { id: "deferred.mute-tool", label: "Mute tool", status: "deferred", delivery: "deferred", surface: "arrangement", scope: "safe-default", input: "T", note: "Mute tool is not in FL v1.", sourceUrl: FL_PLAYLIST },
  { id: "deferred.pattern-song-mode", label: "Pattern / Song mode", status: "deferred", delivery: "deferred", surface: "global", scope: "safe-default", input: "L", note: "FL Pattern and Song transport modes are not in FL v1.", sourceUrl: FL_SHORTCUTS },
  { id: "deferred.right-drag-multi-erase", label: "Right-drag multi-erase", status: "deferred", delivery: "deferred", surface: "arrangement", scope: "safe-default", input: "Right-drag", note: "Continuous erase by right-drag is not in FL v1.", sourceUrl: FL_PLAYLIST },
  { id: "deferred.flp-import", label: "User-facing FLP import", status: "deferred", delivery: "deferred", surface: "project", scope: "safe-default", note: "The workflow profile does not expose an FLP importer." },
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
    reservedKeyCombos: [],
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
    reservedKeyCombos: ["Mod+E"],
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
