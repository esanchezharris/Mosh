// One-process batch: FLP/ALS/RPP files → IR JSONs (for the owner-catalog scrape).
//   npx tsx scripts/batchImportIR.mts <src-dir> <out-dir>
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { importPath } from "../src/import/importFile";
const [,, src, out] = process.argv;
mkdirSync(out, { recursive: true });
const files: string[] = [];
(function walk(d: string) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(flp|als|rpp)$/i.test(n)) files.push(p);
  }
})(src);
let i = 0, ok = 0;
for (const f of files) {
  i++;
  const slug = basename(f, extname(f)).replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40);
  try {
    const ir = importPath(f);
    writeFileSync(join(out, `${String(i).padStart(2, "0")}_${slug}.json`), JSON.stringify({ ir }));
    ok++;
  } catch (e) {
    console.error(`FAIL ${slug}: ${(e as Error).message.slice(0, 80)}`);
  }
}
console.log(`batch-import: ${ok}/${files.length} → ${out}`);
