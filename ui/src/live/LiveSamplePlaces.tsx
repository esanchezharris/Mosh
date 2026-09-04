import { addSampleFolder } from "../bridge";
import type { DirListing } from "../types";

type Props = {
  listing: DirListing | null;
  navigate: (path?: string) => Promise<void>;
};

export function LiveSamplePlaces({ listing, navigate }: Props) {
  const add = async () => {
    const result = await addSampleFolder();
    if (result.ok && result.path) await navigate(result.path);
  };
  return (
    <>
      <div className="live-bnav">
        <button className="live-bnav-up" disabled={!listing?.parent}
          onClick={() => void navigate(listing?.parent ?? undefined)}>Up</button>
        <span className="live-bnav-path" title={listing?.path}>{listing?.path ?? "…"}</span>
        <button className="live-bnav-up" data-testid="live-add-sample-folder"
          onClick={() => void add()}>Add folder…</button>
      </div>
      <div className="live-bplaces" aria-label="Places">
        {listing?.roots.map((root) => (
          <button key={root.path} className="live-bplace"
            onClick={() => void navigate(root.path)}>{root.name}</button>
        ))}
      </div>
    </>
  );
}
