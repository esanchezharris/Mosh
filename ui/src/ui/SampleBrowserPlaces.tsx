import { addSampleFolder } from "../bridge";
import type { DirListing } from "../types";
import { IconFolder } from "./icons";

type Props = {
  listing: DirListing | null;
  loading: boolean;
  navigate: (path: string) => Promise<void>;
};

export function AddSampleFolderButton({ navigate }: Pick<Props, "navigate">) {
  const add = async () => {
    const result = await addSampleFolder();
    if (result.ok && result.path) await navigate(result.path);
  };
  return (
    <button className="btn" type="button" data-testid="sample-browser-add-folder"
      onClick={() => void add()}>Add Sample Folder…</button>
  );
}

export function SamplePlaces({ listing, loading, navigate }: Props) {
  if ((listing?.roots.length ?? 0) === 0) return null;
  return (
    <section className="plugin-group sb-section" aria-label="Places">
      <div className="pg-label"><span>Places</span></div>
      {listing?.roots.map((root) => (
        <button key={root.path} className="plugin-row" disabled={loading}
          onClick={() => void navigate(root.path)} title={root.path}>
          <span className="sb-row-icon" aria-hidden><IconFolder size={14} /></span>
          <span className="pr-name sb-row-title">{root.name}</span>
        </button>
      ))}
    </section>
  );
}
