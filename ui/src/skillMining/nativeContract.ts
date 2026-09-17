import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export interface NativeCommand {
  readonly name: string;
  readonly handler: string;
  readonly args: readonly string[];
  readonly sources: readonly { readonly file: string; readonly line: number }[];
  readonly unresolved: readonly string[];
}

type Token = { readonly text: string; readonly line: number };
type Source = { readonly file: string; readonly line: number };
type NativeFunction = {
  readonly name: string;
  readonly params: readonly string[];
  readonly body: readonly Token[];
  readonly source: Source;
};

export class NativeContractError extends Error {
  constructor(readonly source: string, detail: string) {
    super(`${source}: ${detail}`);
    this.name = "NativeContractError";
  }
}

function tokenize(source: string): readonly Token[] {
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:u8|u|U|L)?R"([^ ()\\\t\r\n]*)\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|\d[\w'.]*|'(?:\\.|[^'\\\n])*'|[A-Za-z_]\w*|::|->|==|[^\s]/g;
  const tokens: Token[] = [];
  let line = 1;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    line += source.slice(offset, match.index).split("\n").length - 1;
    const text = match[0];
    if (!text.startsWith("//") && !text.startsWith("/*")) tokens.push({ text, line });
    line += text.split("\n").length - 1;
    offset = match.index + text.length;
  }
  return tokens;
}

function close(tokens: readonly Token[], start: number): number {
  const opening = tokens[start]?.text;
  const closing = opening === "(" ? ")" : opening === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i]?.text === opening) depth++;
    if (tokens[i]?.text === closing && --depth === 0) return i;
  }
  throw new NativeContractError(`line ${tokens[start]?.line}`, `unclosed ${opening}`);
}

function argumentsOf(tokens: readonly Token[]): readonly (readonly Token[])[] {
  const args: Token[][] = [];
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (["(", "{", "["].includes(tokens[i]?.text ?? "")) i = close(tokens, i);
    else if (i === tokens.length || tokens[i]?.text === ",") {
      if (i > start) args.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

function functionsIn(tokens: readonly Token[], file: string): readonly NativeFunction[] {
  const functions: NativeFunction[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const name = tokens[i - 1]?.text ?? "";
    if (tokens[i]?.text !== "(" || !/^[A-Za-z_]\w*$/.test(name)) continue;
    const end = close(tokens, i);
    const parameters = tokens.slice(i + 1, end);
    if (!parameters.some((token) => token.text === "var")) continue;
    let opening = end + 1;
    while (["const", "noexcept", "override"].includes(tokens[opening]?.text ?? "")) opening++;
    if (tokens[opening]?.text !== "{") continue;
    const closing = close(tokens, opening);
    const params = argumentsOf(parameters).map((param) => {
      const defaultAt = param.findIndex((token) => token.text === "=");
      const last = param[(defaultAt < 0 ? param.length : defaultAt) - 1]?.text ?? "";
      return /^[A-Za-z_]\w*$/.test(last) && last !== "var" ? last : "";
    });
    functions.push({ name, params, body: tokens.slice(opening + 1, closing), source: { file, line: tokens[i - 1]?.line ?? 1 } });
    i = closing;
  }
  return functions;
}

function readSources(root: string): ReadonlyMap<string, readonly Token[]> {
  const dir = resolve(root, "src/moshops");
  const pending = readdirSync(dir).filter((file) => /^MoshOps.*\.cpp$/.test(file)).sort().map((file) => resolve(dir, file));
  const sources = new Map<string, readonly Token[]>();
  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    if (file === undefined || sources.has(relative(root, file))) continue;
    const tokens = tokenize(readFileSync(file, "utf8"));
    sources.set(relative(root, file), tokens);
    for (let j = 0; j < tokens.length; j++) {
      if (tokens[j]?.text !== "include" || tokens[j - 1]?.text !== "#") continue;
      const include = tokens[j + 1]?.text.match(/^"(.+\.h)"$/)?.[1];
      if (!include) continue;
      const header = [resolve(dirname(file), include), resolve(root, "src", include)].find(existsSync);
      if (header) pending.push(header);
    }
  }
  return sources;
}

function extract(fn: NativeFunction, parameter: string, index: ReadonlyMap<string, readonly NativeFunction[]>): Pick<NativeCommand, "args" | "sources" | "unresolved"> {
  const keys = new Set<string>();
  const sources = new Map<string, Source>();
  const unresolved = new Set<string>();
  const visited = new Set<string>();
  const walk = (current: NativeFunction, input: string): void => {
    const identity = `${current.source.file}:${current.source.line}:${input}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    sources.set(identity, current.source);
    if (!input) return;
    const tokens = current.body;
    const consumed = new Set<Token>();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      if (token.text === input && tokens[i + 1]?.text === ".") {
        consumed.add(token);
        const method = tokens[i + 2]?.text ?? "";
        if (["getProperty", "hasProperty"].includes(method)) {
          const key = tokens[i + 4]?.text.match(/^"([A-Za-z0-9_]+)"$/)?.[1];
          if (key && [",", ")"].includes(tokens[i + 5]?.text ?? "")) keys.add(key);
          else unresolved.add(`${identity}: dynamic property key at line ${token.line}`);
        } else if (!["isObject", "isVoid", "isUndefined", "isArray", "isString"].includes(method)) {
          unresolved.add(`${identity}: unsupported ${input}.${method} at line ${token.line}`);
        }
      }
      if (!/^[A-Za-z_]\w*$/.test(token.text) || tokens[i + 1]?.text !== "(") continue;
      const end = close(tokens, i + 1);
      const callArgs = argumentsOf(tokens.slice(i + 2, end));
      callArgs.forEach((arg, position) => {
        const forwarded = arg[0];
        if (arg.length !== 1 || forwarded?.text !== input) return;
        consumed.add(forwarded);
        const access = tokens[i - 1]?.text ?? "";
        const qualified = ["::", ".", "->"].includes(access);
        const juceUnused = token.text === "ignoreUnused" && access === "::"
          && tokens[i - 2]?.text === "juce" && !["::", ".", "->"].includes(tokens[i - 3]?.text ?? "");
        if (juceUnused || (token.text === "logLine" && !qualified)) return;
        if (qualified) {
          unresolved.add(`${identity}: unresolved qualified helper ${tokens[i - 2]?.text}${access}${token.text} at line ${token.line}`);
          return;
        }
        const candidates = (index.get(token.text) ?? []).filter((candidate) => candidate.params.length === callArgs.length);
        const helper = candidates.length === 1 ? candidates[0] : undefined;
        if (helper) walk(helper, helper.params[position] ?? "");
        else unresolved.add(`${identity}: unresolved helper ${token.text} at line ${token.line}`);
      });
    }
    for (const token of tokens) {
      if (token.text === input && !consumed.has(token)) unresolved.add(`${identity}: unsupported argument use at line ${token.line}`);
    }
  };
  walk(fn, parameter);
  return { args: [...keys].sort(), sources: [...sources.values()], unresolved: [...unresolved].sort() };
}

export function readNativeContract(root: string): Map<string, NativeCommand> {
  const sources = readSources(root);
  const dispatch = sources.get("src/moshops/MoshOps.cpp");
  if (!dispatch) throw new NativeContractError(root, "MoshOps.cpp dispatch source missing");
  const index = new Map<string, NativeFunction[]>();
  for (const [file, tokens] of sources) {
    for (const fn of functionsIn(tokens, file)) index.set(fn.name, [...(index.get(fn.name) ?? []), fn]);
  }
  const catalog = new Map<string, NativeCommand>();
  for (let i = 0; i < dispatch.length; i++) {
    if (dispatch[i]?.text !== "if" || dispatch[i + 1]?.text !== "(" || dispatch[i + 2]?.text !== "name" || dispatch[i + 3]?.text !== "==") continue;
    const name = dispatch[i + 4]?.text.match(/^"([a-z0-9_]+)"$/)?.[1];
    if (!name || dispatch[i + 5]?.text !== ")") continue;
    let start = i + 6;
    if (dispatch[start]?.text === "{") start++;
    if (dispatch[start]?.text !== "return") continue;
    let end = start;
    while (end < dispatch.length && dispatch[end]?.text !== ";") end++;
    const handlers = dispatch.slice(start, end).filter((token, j, statement) => /^cmd\w+$/.test(token.text) && statement[j + 1]?.text === "(" && statement[j + 2]?.text === "args" && statement[j + 3]?.text === ")");
    const handler = handlers.length === 1 ? handlers[0]?.text : undefined;
    if (!handler) throw new NativeContractError(name, "dispatch handler could not be resolved");
    if (catalog.has(name)) throw new NativeContractError(name, "duplicate dispatch entry");
    const matches = index.get(handler) ?? [];
    const fn = matches.length === 1 ? matches[0] : undefined;
    const extracted = fn ? extract(fn, fn.params[0] ?? "", index) : { args: [], sources: [], unresolved: [`handler ${handler} missing or ambiguous`] };
    catalog.set(name, { name, handler, ...extracted });
  }
  if (catalog.size === 0) throw new NativeContractError(root, "no native dispatch entries extracted");
  return catalog;
}

export function checkNativeCommand(
  command: { readonly command: string; readonly args: Record<string, unknown> },
  catalog: Map<string, NativeCommand>,
): readonly string[] {
  const native = catalog.get(command.command);
  if (!native) return [`Unknown native command: ${command.command}`];
  return [
    ...native.unresolved.map((reason) => `${command.command}: unresolved native contract: ${reason}`),
    ...Object.keys(command.args).filter((key) => !native.args.includes(key)).map((key) => `${command.command}: unknown native argument: ${key}`),
  ];
}
