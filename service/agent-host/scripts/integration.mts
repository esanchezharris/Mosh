import { runOwnerCockpitIntegration } from "../src/integration-harness.js";

process.stdout.write(`${JSON.stringify(await runOwnerCockpitIntegration(), null, 2)}\n`);
