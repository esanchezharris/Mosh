// Project-file importer CLI (run via tsx — see package.json `import` script).
//
//   npm run import -- <file.rpp|.als> [--json out.json]
//
// Parses a DAW project file → MoshIR → agent-callable MoshOps commands, replays
// them through the deterministic mock verifier, and reports the clean-apply rate
// and the unmappable-feature log. This is the Phase-1 demo: a real project file
// reconstructed as a Tracktion Edit purely through the agent command surface.

import { writeFileSync } from "node:fs";
import { importPath } from "./importFile";
import { emitCommands } from "./emit";
import { replayProgram } from "./bindReplay";

async function main(): Promise<number> {
  const [, , file, ...rest] = process.argv;
  if (!file) {
    console.error("usage: import <file.rpp|.als> [--json out.json]");
    return 2;
  }

  let ir;
  try {
    ir = importPath(file);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const program = emitCommands(ir);
  const r = await replayProgram(program);
  const clips = ir.session.tracks.reduce((a, t) => a + t.clips.length, 0);

  console.log(file);
  console.log(`  format=${ir.format}  tracks=${ir.session.tracks.length}  clips=${clips}  tempo=${ir.session.tempo ?? "—"}`);
  console.log(
    `  commands=${program.commands.length}  cleanValidate=${r.cleanValidate}  cleanApply=${r.cleanApply}` +
      `  applied=${r.applied}/${r.total}  reconstructedTracks=${r.finalSnapshot.tracks.length}`,
  );
  console.log(`  unmappable=${program.unmappable.length}`);
  for (const u of program.unmappable.slice(0, 8)) console.log(`    - ${u}`);
  if (program.unmappable.length > 8) console.log(`    … +${program.unmappable.length - 8} more`);

  const jsonIdx = rest.indexOf("--json");
  if (jsonIdx >= 0 && rest[jsonIdx + 1]) {
    writeFileSync(rest[jsonIdx + 1], JSON.stringify({ ir, commands: program.commands, unmappable: program.unmappable }, null, 2));
    console.log(`  wrote ${rest[jsonIdx + 1]}`);
  }

  return r.cleanApply ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
