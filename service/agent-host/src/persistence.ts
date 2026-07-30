import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentInputItem, Session } from "@openai/agents-core";
import {
  AuditEventSchema,
  PlaytestReportSchema,
  PlaytestSessionSchema,
  RepairJobSchema,
  type AuditEvent,
  type PlaytestReport,
  type PlaytestSession,
  type RepairJob,
} from "./contracts.js";

export function defaultDataDirectory(home = process.env.HOME): string {
  if (!home) {
    throw new Error("HOME is required when MOSH_AGENT_HOST_DATA_DIR is unset");
  }
  return path.join(home, "Library", "Application Support", "Mosh", "playtests");
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export class PlaytestStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  sessionDirectory(playtestId: string): string {
    return path.join(this.root, "sessions", playtestId);
  }

  async initialize(): Promise<void> {
    await mkdir(path.join(this.root, "sessions"), { recursive: true, mode: 0o700 });
  }

  async saveSession(session: PlaytestSession): Promise<void> {
    await atomicWrite(
      path.join(this.sessionDirectory(session.id), "session.json"),
      PlaytestSessionSchema.parse(session),
    );
  }

  async loadSession(playtestId: string): Promise<PlaytestSession> {
    return PlaytestSessionSchema.parse(
      await readJson(path.join(this.sessionDirectory(playtestId), "session.json")),
    );
  }

  async saveTranscript(playtestId: string, transcript: unknown[]): Promise<void> {
    await atomicWrite(path.join(this.sessionDirectory(playtestId), "transcript.json"), transcript);
  }

  async loadTranscript(playtestId: string): Promise<unknown[]> {
    try {
      const value = await readJson(path.join(this.sessionDirectory(playtestId), "transcript.json"));
      if (!Array.isArray(value)) {
        throw new Error("Invalid transcript");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async purgeTranscript(playtestId: string): Promise<void> {
    await rm(path.join(this.sessionDirectory(playtestId), "transcript.json"), { force: true });
    await rm(path.join(this.sessionDirectory(playtestId), "sdk-session.json"), { force: true });
  }

  async appendEvent(event: AuditEvent): Promise<void> {
    const valid = AuditEventSchema.parse(event);
    const eventPath = path.join(this.sessionDirectory(valid.playtestId), "events.jsonl");
    await mkdir(path.dirname(eventPath), { recursive: true });
    await appendFile(eventPath, `${JSON.stringify(valid)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async loadEvents(playtestId: string): Promise<AuditEvent[]> {
    try {
      const contents = await readFile(
        path.join(this.sessionDirectory(playtestId), "events.jsonl"),
        "utf8",
      );
      return contents
        .split("\n")
        .filter(Boolean)
        .map((line) => AuditEventSchema.parse(JSON.parse(line) as unknown));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async saveReport(report: PlaytestReport): Promise<void> {
    await atomicWrite(
      path.join(this.sessionDirectory(report.playtestId), "reports", `${report.id}.json`),
      PlaytestReportSchema.parse(report),
    );
  }

  async loadReport(reportId: string): Promise<PlaytestReport> {
    for (const playtestId of await this.listSessionIds()) {
      try {
        return PlaytestReportSchema.parse(
          await readJson(path.join(this.sessionDirectory(playtestId), "reports", `${reportId}.json`)),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw Object.assign(new Error("Report not found"), { code: "ENOENT" });
  }

  async saveRepair(repair: RepairJob): Promise<void> {
    await atomicWrite(
      path.join(this.sessionDirectory(repair.playtestId), "repairs", `${repair.id}.json`),
      RepairJobSchema.parse(repair),
    );
  }

  private async listSessionIds(): Promise<string[]> {
    try {
      return await readdir(path.join(this.root, "sessions"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export class FileAgentSession implements Session {
  readonly sessionId: string;
  private readonly filePath: string;

  constructor(store: PlaytestStore, playtestId: string) {
    this.sessionId = playtestId;
    this.filePath = path.join(store.sessionDirectory(playtestId), "sdk-session.json");
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    let items: AgentInputItem[];
    try {
      const parsed = await readJson(this.filePath);
      items = Array.isArray(parsed) ? parsed as AgentInputItem[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      items = [];
    }
    const selected = limit === undefined ? items : items.slice(Math.max(0, items.length - limit));
    return structuredClone(selected);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) return;
    await atomicWrite(this.filePath, [...await this.getItems(), ...structuredClone(items)]);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const items = await this.getItems();
    const item = items.pop();
    await atomicWrite(this.filePath, items);
    return item;
  }

  async clearSession(): Promise<void> {
    await atomicWrite(this.filePath, []);
  }
}
