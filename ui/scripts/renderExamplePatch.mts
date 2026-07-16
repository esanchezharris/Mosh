import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderExample, type RawExample, type RenderedExample } from "../src/sft/buildDataset";

type BoundCommand = { command: string; args: Record<string, unknown>; bind?: string };
type ExampleSeed = {
  id: string;
  intent: string;
  utterance: string;
  targetCommands: BoundCommand[];
  goldCommandNames: string[];
};
type ExampleCluster = { name: string; examples: ExampleSeed[] };
type ExamplePatch = {
  sourceId: string;
  commonStartCommands: BoundCommand[];
  clusters: ExampleCluster[];
};

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const inPath = flag("in");
const outPath = flag("out");
if (!inPath || !outPath) throw new Error("--in and --out are required");

const metaPath = flag("meta-out", outPath.replace(/\.jsonl$/, ".meta.jsonl"));
const evalPath = flag("eval-out", outPath.replace(/\.jsonl$/, ".eval.jsonl"));
const patch = JSON.parse(readFileSync(resolve(inPath), "utf8")) as ExamplePatch;

const raws: RawExample[] = patch.clusters.flatMap((cluster) =>
  cluster.examples.map((example) => ({
    id: `${patch.sourceId}#${example.id}`,
    sourceId: `${patch.sourceId}:${cluster.name}`,
    utterance: example.utterance,
    startCommands: patch.commonStartCommands,
    targetCommands: example.targetCommands,
    goldCommandNames: example.goldCommandNames,
    intent: example.intent,
  })));

const rendered: RenderedExample[] = [];
for (const raw of raws) {
  const ex = await renderExample(raw);
  if (!ex) throw new Error(`failed to render ${raw.id}`);
  rendered.push(ex);
}

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), rendered.map((e) => JSON.stringify({ messages: e.messages })).join("\n") + "\n");
writeFileSync(resolve(metaPath), rendered.map((e) => JSON.stringify({ id: e.id, sourceId: e.sourceId, goldCommandNames: e.goldCommandNames })).join("\n") + "\n");
writeFileSync(resolve(evalPath), raws.map((r) => JSON.stringify({ id: r.id, utterance: r.utterance, startCommands: r.startCommands, goldCommandNames: r.goldCommandNames })).join("\n") + "\n");
console.log(`rendered ${rendered.length} example(s) → ${resolve(outPath)}`);
