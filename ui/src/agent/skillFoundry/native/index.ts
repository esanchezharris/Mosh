// Skill Foundry Slice B, Task 6 — the closed native handler map + payload list, in one
// place so `runtime.ts` never has to know the four handler modules individually.

import type { NativeSkillHandlerV1, NativeSkillPayloadV1 } from "../contracts";
import { sessionControlV1 } from "./sessionControl";
import { takeCycleV1 } from "./takeCycle";
import { explicitBalanceV1 } from "./explicitBalance";
import { loadNamedPluginV1 } from "./loadNamedPlugin";

export { NATIVE_PAYLOADS_V1, NATIVE_SOURCE_PATHS_V1, materializeNativePayloadArtifactsV1 } from "./payloads";
export type {
  MaterializeNativePayloadArtifactsInputV1,
  MaterializeNativePayloadArtifactsResultV1,
  MaterializedNativePayloadV1,
} from "./payloads";

/** The closed `handlerKey -> handler` map every `NativeSkillPayloadV1.handlerKey` must
 *  resolve through (spec 8.1: "`handlerKey` resolves through a closed compile-time map;
 *  data cannot add native code"). */
export const NATIVE_HANDLERS_V1: Readonly<Record<NativeSkillPayloadV1["handlerKey"], NativeSkillHandlerV1>> = {
  sessionControlV1,
  takeCycleV1,
  explicitBalanceV1,
  loadNamedPluginV1,
};

export { sessionControlV1, takeCycleV1, explicitBalanceV1, loadNamedPluginV1 };
