# RunPod on-demand LoRA training — owner runbook (Lane C)

Train a type-beat LoRA on a rented RunPod GPU straight from Mosh: register your own /
cleared audio → build a corpus → submit a training job → the finished `.safetensors` is
pulled back, `install.py` enrolls it into the **LoRA rack**, and it's instantly playable
(including **Live** render-ahead). No new app commands — the 11 training commands +
`trainer_job._remote_train` already drive the whole round-trip; this doc is just the
server-side bring-up.

> **Cost + rights.** A real run is minutes of GPU time and real $ per run. The corpus is
> gated by the rights registry — **only your own or explicitly-cleared material.** Pull
> artifacts eagerly and **terminate the pod when done** (a negative RunPod balance kills
> pods and can lose in-flight work).

The whole client⇄server contract is proven hermetically (no GPU) by
`service/training/runpod_server_test.py` — run it first if you change anything.

---

## Architecture (one glance)

```
Mosh app  ──/training/submit──▶  local mosh service  ──trainer_job._remote_train──▶  POST http://localhost:8799/training/jobs
                                                                                          │  (SSH tunnel)
                                                                                          ▼
                                                                        RunPod pod: runpod_server.py
                                                                        pre_encode → train_lora (medium-base,
                                                                        rank16, dora-rows) → .ckpt → .safetensors
                                          artifact_b64 ◀──GET /training/jobs/<id>──────────┘
     install.py enrolls → LoRA rack → apply_loras (Live)
```

`runpod_server.py` auto-selects the **real** SA3 trainer when `stable_audio_3` imports (i.e.
on the pod), else a hermetic **fake** trainer. Force with `MOSH_TRAINER_IMPL=real|fake`.

---

## 1. Prereqs (Mac)

- RunPod API key at `~/.runpod_api_key`, SSH key `~/.ssh/id_ed25519(.pub)` (same as the r1–r5 runs).
- The pod lifecycle helper `~/mosh-loras/work/pod.sh` (`create|status|endpoint|terminate|list`).
- The uploads the proven runs used: the SA3 code tree, the `medium-base` + `same-l` weights,
  and the gated `t5gemma-b-b-ul2` + `patch_t5gemma.py` (see `~/mosh-loras/work/pod_run_sa3.sh`).

## 2. Bring up the pod

```bash
cd ~/mosh-loras/work
./pod.sh train create                 # rents a GPU pod (RTX 4090 / L40S / A6000 …)
./pod.sh train status                 # wait for RUNNING
POD=$(./pod.sh train endpoint)        # → user@host -p <port>  (SSH target)
```

Upload the code + weights + this repo's `service/` tree:

```bash
# from the repo root
scp -r ~/AI/stable-audio-3            $POD:/workspace/stable-audio-3
scp -r service                        $POD:/workspace/mosh-service
scp -r ~/AI/…/t5gemma-b-b-ul2         $POD:/workspace/       # gated encoder (optional but needed for real training)
scp ~/mosh-loras/work/patch_t5gemma.py $POD:/workspace/
# plus the model weights exactly as pod_run_sa3.sh expects them
```

Launch the training server on the pod:

```bash
ssh $POD 'nohup bash /workspace/mosh-service/training/runpod_serve.sh \
            > /workspace/train-server.log 2>&1 &'
ssh $POD 'tail -f /workspace/train-server.log'   # wait for: listening on 0.0.0.0:8799
```

`runpod_serve.sh` installs deps once (`.s0-serve-deps` marker), patches T5Gemma, then serves.

## 3. Point Mosh at the pod (Mac)

Tunnel the port (keeps the trainer private — no public exposure):

```bash
ssh -N -L 8799:localhost:8799 $POD &        # leave running
```

Tell Mosh's service to dispatch remotely, then (re)launch the app so it inherits the env:

```bash
launchctl setenv MOSH_TRAINING_BACKEND remote_http
launchctl setenv MOSH_TRAINING_REMOTE_URL http://localhost:8799
open /Applications/Mosh.app
```

Sanity-check the tunnel: `curl -s localhost:8799/health` → `{"ok":true,"backend":"real",…}`.

## 4. Train from the app

Register a source (your own/cleared audio) → approve it (rights gate) → build the corpus →
submit the training job. The local service bundles the corpus, POSTs it to the pod, polls,
and on completion writes the artifact; `install.py` enrolls it as `<name>.safetensors` in
`~/Library/Mosh/loras/sa3/`. Reopen the re-imagine drawer → the new LoRA is in the rack →
drag the strength slider, arm **Live**, play.

**Dry-run without spending a training run:** launch the server with `MOSH_TRAINER_IMPL=fake`
— it returns a valid (silent) dora-rows adapter so you can prove the whole wiring
(submit → pull → enroll → rack) before committing GPU time.

## 5. Teardown (do this!)

```bash
# confirm the artifact enrolled locally FIRST, then:
./pod.sh train terminate            # stops the $ spend
# kill the tunnel; clear the env so normal Mosh launches are local again:
launchctl unsetenv MOSH_TRAINING_BACKEND
launchctl unsetenv MOSH_TRAINING_REMOTE_URL
```

---

## Alternative: local PC trainer (FIT-013 — $0 small runs)

The same server runs on the owner's Windows/CUDA box instead of a pod — no rental, no
tunnel, plain LAN HTTP. On the PC (needs the SA3 code tree + the CUDA venv):

```powershell
.\service\training\serve-trainer.ps1 -Sa3TrainDir E:\stable-audio-3 -BindHost <pc-lan-ip>
```

Mac side — same env contract as the pod, just the LAN URL, no SSH tunnel:

```bash
launchctl setenv MOSH_TRAINING_BACKEND remote_http
launchctl setenv MOSH_TRAINING_REMOTE_URL http://<pc-lan-ip>:8799
open /Applications/Mosh.app          # sanity: curl -s <url>/health → "backend":"real"
```

**Security (read this):** the trainer server is unauthenticated and executes training
subprocesses on submitted bundles. Bind the LAN IPv4 (not 0.0.0.0), allow inbound TCP 8799
only on the Private firewall profile scoped to the local subnet, never port-forward it, and
stop the server when not training. Teardown is the same `launchctl unsetenv` pair as §5
(there is no pod to terminate). Pick the pod for big runs (the 4070 is 12 GB); pick the PC
for small/iterative ones.

---

## Contract reference (for maintainers)

`runpod_server.py` honors exactly what `trainer_job._remote_train` sends/expects:

- `POST /training/jobs` — `{config:{rank,steps,lr,base_model,backend}, bundle:{archive_b64 (zip
  of the corpus dir), bundle_hash, …}, output_dir}` → `{job_id, status_url}`.
- `GET /training/jobs/<id>` — `{status: queued|running|ready|error, result:{artifact_b64,
  manifest_json, adapter_id, quality}, error}`.
- The client accepts many artifact forms (b64 / json / url / path); this server returns
  `artifact_b64` (the `.safetensors` bytes) + `manifest_json`.
- Real trainer = the proven `pod_run_sa3.sh` recipe (pre_encode → `train_lora.py --model
  medium-base --rank 16 --adapter_type dora-rows` → `.ckpt` → `.safetensors` via
  `install._ckpt_to_safetensors`).

Serverless vs pod: this is the **pod** shape (a plain HTTP server the client speaks to
directly over an SSH tunnel). A RunPod *serverless* worker would need a thin adapter from the
serverless request envelope to these two routes — deferred; the pod path is simpler and the
tunnel keeps it private.
