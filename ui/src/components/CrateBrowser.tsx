import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

// The crate browser (Stage 18): browse the sample library (MOSH_SAMPLE_LIBRARY)
// without leaving Mosh. Click a file to audition it through the ENGINE's
// device (audition_file); → trk imports onto the selected track; → pad loads
// it as the next drum-rack pad. Search is recursive across the whole crate.

type DirEntry = { dirs: string[]; files: { name: string; path: string }[] };

export function CrateBrowser({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const setCrateOpen = useStore((s) => s.setCrateOpen);
  const selectedTrackId = useStore((s) => s.selectedTrackId);

  const [cache, setCache] = useState<Record<string, DirEntry>>({});
  const [rootPath, setRootPath] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ name: string; path: string }[] | null>(null);

  const loadDir = async (path: string) => {
    const res = (await exec("list_dir", path ? { path } : {})) as CommandResult<
      DirEntry & { root: string }
    >;
    if (res.ok && res.data) {
      setCache((c) => ({ ...c, [path]: { dirs: res.data!.dirs, files: res.data!.files } }));
      if (!path && res.data.root) setRootPath(res.data.root);
    }
  };

  useEffect(() => {
    void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDir = (path: string) => {
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!cache[path]) void loadDir(path);
      }
      return next;
    });
  };

  const audition = (path: string) => {
    if (playing === path) {
      void exec("stop_audition", {});
      setPlaying(null);
    } else {
      void exec("audition_file", { path });
      setPlaying(path);
    }
  };

  const absPath = (rel: string) => `${rootPath}/${rel}`;

  const toTrack = (rel: string) =>
    void exec("import_clip", selectedTrackId
      ? { file: absPath(rel), trackId: selectedTrackId }
      : { file: absPath(rel) });

  const toPad = (rel: string) => {
    const track = snapshot.tracks.find((t) => t.id === selectedTrackId);
    const sampler = (track?.plugins ?? []).find((p) => p.type === "sampler");
    if (!track || !sampler) return;
    const key = sampler.sounds?.length
      ? Math.max(...sampler.sounds.map((s) => s.keyNote)) + 2
      : 24;
    void exec("add_sampler_sound", {
      trackId: track.id,
      index: sampler.index,
      file: absPath(rel),
      keyNote: key,
      minNote: key,
      maxNote: key,
      openEnded: true,
    });
  };

  const hasSampler = (snapshot.tracks.find((t) => t.id === selectedTrackId)?.plugins ?? [])
    .some((p) => p.type === "sampler");

  const runSearch = async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const res = (await exec("list_dir", { query: q.trim() })) as CommandResult<DirEntry>;
    if (res.ok && res.data) setResults(res.data.files);
  };

  const FileRow = ({ f }: { f: { name: string; path: string } }) => (
    <div className={`cb-file ${playing === f.path ? "playing" : ""}`}>
      <span className="cb-fname" title={f.path} onClick={() => audition(f.path)}>
        {playing === f.path ? "■ " : "▸ "}
        {f.name}
      </span>
      <button className="cb-act" title="Import to the selected track" onClick={() => toTrack(f.path)}>
        →trk
      </button>
      {hasSampler && (
        <button className="cb-act" title="Add as the next drum-rack pad" onClick={() => toPad(f.path)}>
          →pad
        </button>
      )}
    </div>
  );

  const Dir = ({ path, name, depth }: { path: string; name: string; depth: number }) => {
    const open = expanded.has(path);
    const entry = cache[path];
    return (
      <div>
        <div className="cb-dir" style={{ paddingLeft: depth * 12 }} onClick={() => toggleDir(path)}>
          {open ? "▾" : "▸"} {name}
        </div>
        {open && entry && (
          <div>
            {entry.dirs.map((d) => (
              <Dir key={d} path={path ? `${path}/${d}` : d} name={d} depth={depth + 1} />
            ))}
            {entry.files.map((f) => (
              <div key={f.path} style={{ paddingLeft: (depth + 1) * 12 }}>
                <FileRow f={f} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const root = cache[""];
  return (
    <div className="crate">
      <div className="cb-head">
        <span className="cb-title">crate</span>
        <button className="mini" onClick={() => setCrateOpen(false)}>✕</button>
      </div>
      <input
        className="cb-search"
        placeholder="search the crate…"
        value={query}
        onChange={(e) => void runSearch(e.target.value)}
      />
      <div className="cb-list">
        {results !== null ? (
          results.length ? (
            results.map((f) => <FileRow key={f.path} f={f} />)
          ) : (
            <div className="cb-empty">no matches</div>
          )
        ) : root ? (
          <>
            {root.dirs.map((d) => (
              <Dir key={d} path={d} name={d} depth={0} />
            ))}
            {root.files.map((f) => (
              <FileRow key={f.path} f={f} />
            ))}
          </>
        ) : (
          <div className="cb-empty">loading…</div>
        )}
      </div>
      <div className="cb-foot">click = audition · →trk import · →pad rack</div>
    </div>
  );
}
