import { useStore } from "../store";
import type { ProToolsFadePlan } from "./proToolsFades";

export type ProToolsFadeApplyResult = {
  readonly stale: boolean;
  readonly error: string | null;
};

export async function applyProToolsFadePlan(
  label: string,
  plan: ProToolsFadePlan,
  projectEpoch: number,
): Promise<ProToolsFadeApplyResult> {
  let error: string | null = null;
  let stale = false;
  try {
    await useStore.getState().runAtomic(label, async (exec) => {
      const commands: Array<{ command: string; args: Record<string, unknown> }> = [
        ...plan.disableAutoCrossfadeIds.map((clipId) => ({
          command: "set_clip_crossfade",
          args: { clipId, enabled: false },
        })),
        ...plan.edits.map((edit) => ({
          command: "set_clip_fade",
          args: { ...edit },
        })),
      ];
      for (const command of commands) {
        if (useStore.getState().projectEpoch !== projectEpoch) {
          stale = true;
          return;
        }
        const result = await exec(command.command, command.args);
        if (!result.ok) {
          error = result.error ?? "The fade edit was rejected.";
          return;
        }
      }
    });
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "The fade edit could not be completed.";
  }
  if (useStore.getState().projectEpoch !== projectEpoch) stale = true;
  return { stale, error };
}
