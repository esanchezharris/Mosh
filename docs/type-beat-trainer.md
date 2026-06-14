# Type-Beat LoRA Trainer

This workflow is for rights-cleared beat references only.

## Policy

- YouTube is discovery/reference only unless the user separately has the right to download and train on the audio.
- The registry stores user-provided rights metadata, but it is not legal proof.
- `user_claimed_license` is a user claim, not an automatic guarantee.
- Training requires an approved source with a local file path and a non-empty proof-of-rights record.

## Flow

1. Import a source into the rights registry.
2. Add or attach the local audio file for that source.
3. Approve the source for training.
4. Build a deterministic corpus bundle.
5. Submit the bundle to the remote trainer.
6. Import the finished adapter back into Mosh and activate it.

## Files

- `service/training/rights_registry.json` stores the source registry.
- `service/training/corpus.manifest.json` stores the deterministic corpus bundle manifest.
- `service/training/training_state.json` stores active adapters, jobs, and the latest corpus.

## Failure modes

- Missing rights proof: the source is blocked until the field is filled in.
- Missing local file: the source stays in the registry, but it is not eligible for training.
- Expired approval: the corpus builder rejects the source.
