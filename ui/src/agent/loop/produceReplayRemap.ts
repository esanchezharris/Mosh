/**
 * produceReplayRemap — rewrite a replayed produce program's trackIds by ROLE.
 *
 * A produce program (the note commands the model emitted against the laid
 * template) addresses tracks by the numeric ids the ORIGINAL run's preflight
 * produced. Those ids are only stable while the preflight itself is stable:
 * round 3 (2026-09-02) added a highpass per synth track, every later id shifted
 * by one, and the replay's verbatim ids sent five melodic parts onto
 * auto-created "Track N" tracks (MoshOps add_midi_clip creates a missing track
 * and gives it a default 4OSC — a naked sine at 0 dB). The owner heard it as
 * "the presets in the melody sound like naked sine waves".
 *
 * The durable identity of a template track is its ROLE (drums, 808, lead,
 * chords_pad, …), which both template.json files record. So: original id →
 * role → replay id, and anything that cannot be mapped throws — a replay must
 * never silently create tracks.
 */

export type RoleTrackMap = Record<string, string>;

type TemplateLike = {
  drums?: { trackId?: string };
  bass?: { trackId?: string };
  synths?: Array<{ role?: string; trackId?: string }>;
};

export type ProgramLineLike = { command: string; args?: Record<string, unknown> };

/** role → trackId for a produce template (drums, "808", and each synth role). */
export function templateRoleMap(template: TemplateLike): RoleTrackMap {
  const map: RoleTrackMap = {};
  if (template.drums?.trackId) map.drums = template.drums.trackId;
  if (template.bass?.trackId) map["808"] = template.bass.trackId;
  for (const s of template.synths ?? []) if (s.role && s.trackId) map[s.role] = s.trackId;
  return map;
}

export function remapProgramTrackIds<L extends ProgramLineLike>(
  lines: readonly L[],
  fromTemplate: TemplateLike,
  toTemplate: TemplateLike,
): { lines: L[]; remapped: Record<string, string> } {
  const fromRoles = templateRoleMap(fromTemplate);
  const toRoles = templateRoleMap(toTemplate);
  const roleById = new Map<string, string>();
  for (const [role, id] of Object.entries(fromRoles)) roleById.set(id, role);

  const remapped: Record<string, string> = {};
  const out = lines.map((line) => {
    const id = line.args?.trackId;
    if (typeof id !== "string") return line;
    const role = roleById.get(id);
    if (role === undefined)
      throw new Error(`produceReplay: program trackId ${id} (${line.command}) is not a track of the original template — refusing to replay it (Mosh would auto-create a track)`);
    const next = toRoles[role];
    if (next === undefined)
      throw new Error(`produceReplay: replay template has no "${role}" track for original trackId ${id} (${line.command})`);
    if (next === id) return line;
    remapped[id] = next;
    return { ...line, args: { ...line.args, trackId: next } } as L;
  });
  return { lines: out, remapped };
}
