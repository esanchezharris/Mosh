import { describe, expect, it } from "vitest";
import { AGENT_COMMAND_MAP } from "../agent/commands";
import { extractSessionNames } from "./negatives";
import { SETUP_PROFILES, TRAINING_PROFILE_NAMES, taskgenHint } from "./synthProfiles";

// Entity names a profile introduces (the literal strings the model could learn).
function profileNames(profile: { command: string; args: Record<string, unknown> }[]): string[] {
  return extractSessionNames(profile.map((c) => ({ name: c.args.name, text: c.args.text })));
}

describe("SETUP_PROFILES", () => {
  it("every profile command is agent-callable with all required args present", () => {
    for (const [profile, cmds] of Object.entries(SETUP_PROFILES)) {
      for (const c of cmds) {
        const spec = AGENT_COMMAND_MAP.get(c.command);
        expect(spec, `${profile}: ${c.command} not an agent command`).toBeTruthy();
        for (const a of spec!.args.filter((a) => a.required)) {
          expect(c.args[a.name], `${profile}: ${c.command} missing required arg ${a.name}`).toBeDefined();
        }
      }
    }
  });

  it("training profiles are supersets of basic (grading stays comparable)", () => {
    const basic = JSON.stringify(SETUP_PROFILES.basic);
    for (const name of TRAINING_PROFILE_NAMES) {
      expect(JSON.stringify(SETUP_PROFILES[name].slice(0, SETUP_PROFILES.basic.length)), name).toBe(basic);
    }
  });

  it("PRE-REGISTERED: the eval profile shares no entity names with training profiles", () => {
    const evalNames = new Set(profileNames(SETUP_PROFILES.eval));
    for (const name of TRAINING_PROFILE_NAMES) {
      for (const n of profileNames(SETUP_PROFILES[name])) {
        expect(evalNames.has(n), `entity name "${n}" appears in both ${name} and eval`).toBe(false);
      }
    }
  });
});

describe("taskgenHint", () => {
  const assets = { loop: "/A/loop.wav", kick: "/A/kick.wav", beatbox: "/A/bb.wav" };
  it("file commands get real asset paths", () => {
    expect(taskgenHint("import_clip", assets)).toContain("/A/loop.wav");
    expect(taskgenHint("sketch_beatbox", assets)).toContain("/A/bb.wav");
    expect(taskgenHint("assign_sample", assets)).toContain("/A/kick.wav");
  });
  it("non-hinted commands get undefined", () => {
    expect(taskgenHint("set_tempo", assets)).toBeUndefined();
  });
  it("state hints fire only when the SETUP profile provides the state", () => {
    expect(taskgenHint("accept_render", assets, "rendered")).toContain("COMPLETED re-imagine render");
    expect(taskgenHint("accept_render", assets, "rich")).toBeUndefined();
    expect(taskgenHint("accept_render", assets)).toBeUndefined();
    expect(taskgenHint("fill_lyric_gap", assets, "rich")).toContain("gap line");
    expect(taskgenHint("accept_lyric_proposal", assets, "proposals")).toContain("AI-proposed lines");
  });
});
