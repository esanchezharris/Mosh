// ─────────────────────────────────────────────────────────────────────────────
// ARG-TYPE CONTRACT — a UI call site must pass the type the command declares.
//
// Why this exists. `commands.contract.test.ts` already asserts that every arg a
// command DECLARES is READ by its native handler. Nothing asserted the other
// direction: that a call site PASSES the declared type. That gap shipped a real,
// user-visible, four-times-wrong bug.
//
// The bug: v2's Inspector sent `quantize_notes {division: "1/16"}` — a string —
// where the catalog declares `N("division", …, "beats: 1=1/4, 0.5=1/8, 0.25=1/16")`,
// a NUMBER OF BEATS. JUCE's `var` coerces a string via `String::getDoubleValue()`,
// which parses the leading numeral and yields 1.0. So a button reading
// "Quantize 1/16" quantized to WHOLE BEATS.
//
// Proven against the real engine (Release build, `--run-script`), notes at
// 0.30 / 1.18 / 2.07 / 3.42 beats:
//     division: "1/16"  ->  0.0  1.0  2.0  3.0     (quarter-note grid — wrong)
//     division: 0.25    ->  0.25 1.25 2.0  3.5     (true 16th grid)
//
// Why NOTHING caught it, which is the part worth remembering:
//   • Playwright could not: `ui/src/bridge.mock.ts` coerces with
//     `num = (v,d) => typeof v === "number" && isFinite(v) ? v : d`, so the mock
//     silently produced 1 for "1/16" — the SAME wrong answer as JUCE, from a
//     different mechanism. The mock reproduced the bug faithfully and passed.
//   • `--selftest` could not: it only ever calls quantize_notes with numeric
//     divisions — values the UI never sends.
//   • `tsc` could not: `exec(command: string, args?: Record<string, unknown>)`
//     is untyped by construction, because the catalog is data, not types.
//
// So the check has to be exactly this: read the call sites as syntax, read the
// catalog as data, and compare. That is what the AST walk below does.
//
// SCOPE: every `.ts`/`.tsx` under `ui/src` except tests and the mock backend.
// Deliberately NOT scoped to the v2 module graph — passing a string where beats
// are declared is a bug in the classic shell too, and this file has no reason to
// duplicate `uiReachability.test.ts`'s graph walk (it is also the file PR #500
// edits; keeping them independent avoids a pointless conflict).
//
// ONLY LITERAL arguments are checked. `{ division: someVar }` is invisible here
// and always will be — that is the honest limit of a syntactic check, not an
// oversight. The bug class it does close is the one that actually shipped.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { AGENT_COMMANDS, type ArgType } from "./commands";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Declared arg types, by command then arg name. */
const DECLARED = new Map<string, Map<string, ArgType>>(
  AGENT_COMMANDS.map((c) => [c.command, new Map(c.args.map((a) => [a.name, a.type]))]),
);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "node_modules" && entry !== "vendor") sourceFiles(p, out);
    } else if (/\.tsx?$/.test(entry)
      && !/\.(test|spec)\.tsx?$/.test(entry)
      && entry !== "bridge.mock.ts") {
      out.push(p);
    }
  }
  return out;
}

type Literal = { kind: ArgType; text: string };

/** The literal value of an object-literal property, or null when it is dynamic. */
function literalOf(node: ts.Expression): Literal | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { kind: "string", text: JSON.stringify(node.text) };
  if (ts.isNumericLiteral(node)) return { kind: "number", text: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", text: "true" };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", text: "false" };
  // -1, -0.5 — a prefix minus wrapping a numeric literal is still a number literal.
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(node.operand))
    return { kind: "number", text: `-${node.operand.text}` };
  return null;
}

/** `exec(...)`, `.exec(...)`, `execute(...)`, `.execute(...)` — the seam's call shapes. */
function isExecCallee(expr: ts.Expression): boolean {
  const name = ts.isPropertyAccessExpression(expr) ? expr.name.text
    : ts.isIdentifier(expr) ? expr.text
      : null;
  return name === "exec" || name === "execute";
}

export interface Mismatch {
  file: string; line: number; command: string; arg: string;
  declared: ArgType; passed: ArgType; value: string;
}

function scan(): { mismatches: Mismatch[]; callSites: number; literalArgs: number } {
  const mismatches: Mismatch[] = [];
  let callSites = 0, literalArgs = 0;

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isExecCallee(node.expression)) {
        const [nameArg, argsArg] = node.arguments;
        if (nameArg && ts.isStringLiteral(nameArg)) {
          const declared = DECLARED.get(nameArg.text);
          if (declared && argsArg && ts.isObjectLiteralExpression(argsArg)) {
            callSites++;
            for (const prop of argsArg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue; // spread / shorthand: dynamic
              const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
                ? prop.name.text : null;
              if (key == null) continue;
              const want = declared.get(key);
              if (want == null) continue; // undeclared arg — a different check, not this one
              const lit = literalOf(prop.initializer);
              if (lit == null) continue; // dynamic value — invisible to a syntactic check
              literalArgs++;
              if (lit.kind !== want) {
                mismatches.push({
                  file: relative(SRC, file), command: nameArg.text, arg: key,
                  declared: want, passed: lit.kind, value: lit.text,
                  line: sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1,
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { mismatches, callSites, literalArgs };
}

describe("arg-type contract — a call site passes the type the catalog declares (ARG-TYPE)", () => {
  const { mismatches, callSites, literalArgs } = scan();

  // Anti-vacuity floor, in the shape uiReachability.test.ts:128 established. A probe that
  // resolves nothing looks EXACTLY like a probe that finds nothing wrong, and this repo's
  // documented recurring failure is tests that cannot fail. If these floors trip, every
  // assertion below is meaningless and the suite says so instead of going quietly green.
  it("the scan found real call sites (guards against a silently-empty probe)", () => {
    expect(DECLARED.size).toBeGreaterThan(100);
    expect(callSites).toBeGreaterThan(50);
    expect(literalArgs).toBeGreaterThan(30);
  });

  it("every literal argument matches its declared type", () => {
    const report = mismatches.map((m) =>
      `${m.file}:${m.line}  ${m.command}{${m.arg}: ${m.value}} — declared ${m.declared}, passed ${m.passed}`);
    expect(report,
      "A UI call site passes a literal of the wrong type. JUCE's `var` coerces silently — a "
      + "string where a number is declared becomes String::getDoubleValue(), so \"1/16\" "
      + "arrives as 1.0 and the command does something four times coarser than the label "
      + "says. Fix the call site to pass the declared type (see this file's header for the "
      + "shipped example), or correct the declaration in commands.ts if the catalog is wrong.",
    ).toEqual([]);
  });
});
