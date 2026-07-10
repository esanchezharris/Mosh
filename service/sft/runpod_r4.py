#!/usr/bin/env python3
import argparse
import datetime
import json
import os
import pathlib
import posixpath
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time


GPU_PRIORITY = [
    "NVIDIA A100 80GB PCIe",
    "NVIDIA A100-SXM4-80GB",
    "NVIDIA H100 PCIe",
    "NVIDIA H100 80GB HBM3",
]
DEFAULT_IMAGE = "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04"
DEFAULT_NAME = "codex-a3b-r4-cuda"
DEFAULT_REMOTE_ROOT = "/workspace/ClaudeMosh"
DEFAULT_ALLOWED_CUDA_VERSIONS = ["11.8"]
DEFAULT_TOTAL_STEPS = 12889
BUNDLE_PATHS = [
    "service/sft/setup-sft-cuda.sh",
    "service/sft/sft_cuda_train.py",
    "service/sft/launch-r4-cuda.sh",
    "service/sft/serve_openai.py",
    "service/sft/README.md",
    "service/sft/RUNPOD_a3b-r4.md",
    "service/sft/CUDA_PROVIDER_PORTABLE_a3b-r4.md",
    "service/sft/.sft-data/s2-mix-v4",
    "ui/package.json",
    "ui/scripts/evalSft.mts",
    "ui/scripts/evalV2Grounded.mts",
    "ui/scripts/lib/realEngine.mts",
]
FALLBACK_SOURCES = {
    "service/sft/.sft-data/s2-mix-v4": pathlib.Path(
        "/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft/.sft-data/s2-mix-v4"
    ),
}


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def require_api_key():
    api_key = os.environ.get("RUNPOD_API_KEY")
    if not api_key:
        fail("set RUNPOD_API_KEY in the environment before using this command")
    return api_key


def repo_root():
    return pathlib.Path(__file__).resolve().parents[2]


def sft_root():
    return pathlib.Path(__file__).resolve().parent


def detect_public_key():
    ssh_dir = pathlib.Path.home() / ".ssh"
    for name in ("id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"):
        path = ssh_dir / name
        if path.exists():
            return path.read_text().strip()
    fail("no SSH public key found in ~/.ssh; create one before provisioning the pod")


def graphql(api_key, query):
    try:
        proc = subprocess.run(
            [
                "curl",
                "-sS",
                "-X",
                "POST",
                f"https://api.runpod.io/graphql?api_key={api_key}",
                "-H",
                "content-type: application/json",
                "--data",
                json.dumps({"query": query}),
            ],
            check=True,
            text=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        fail(f"RunPod GraphQL request failed: {exc.stderr.strip() or exc.stdout.strip()}")
    return json.loads(proc.stdout)


def rest(api_key, method, path):
    try:
        proc = subprocess.run(
            [
                "curl",
                "-sS",
                "-X",
                method,
                "-H",
                f"Authorization: Bearer {api_key}",
                f"https://rest.runpod.io{path}",
            ],
            check=True,
            text=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        fail(f"RunPod REST request failed: {exc.stderr.strip() or exc.stdout.strip()}")
    return json.loads(proc.stdout)


def list_pods(api_key):
    return rest(api_key, "GET", "/v1/pods")


def find_pod(api_key, pod_id=None, name=None):
    pods = list_pods(api_key)
    for pod in pods:
        if pod_id and pod.get("id") == pod_id:
            return pod
        if name and pod.get("name") == name:
            return pod
    return None


def summarize_pod(pod):
    port_mappings = pod.get("portMappings") or {}
    ssh_port = port_mappings.get("22") or port_mappings.get(22)
    return {
        "id": pod.get("id"),
        "name": pod.get("name"),
        "desiredStatus": pod.get("desiredStatus"),
        "image": pod.get("image") or pod.get("imageName"),
        "gpu": ((pod.get("machine") or {}).get("gpuDisplayName") or (pod.get("gpu") or {}).get("displayName")),
        "costPerHr": pod.get("costPerHr"),
        "publicIp": pod.get("publicIp"),
        "sshPort": ssh_port,
        "ports": pod.get("ports"),
        "portMappings": port_mappings,
        "volumeInGb": pod.get("volumeInGb"),
        "containerDiskInGb": pod.get("containerDiskInGb"),
    }


def ssh_target(pod):
    port = summarize_pod(pod)["sshPort"]
    ip = pod.get("publicIp")
    if not ip or not port:
        fail("pod does not yet have a public IP and SSH port mapping")
    return str(ip), str(port)


def run_local(cmd, **kwargs):
    return subprocess.run(cmd, check=True, text=True, **kwargs)


def ssh_command(pod, remote_cmd):
    ip, port = ssh_target(pod)
    return ["ssh", "-o", "StrictHostKeyChecking=no", "-p", port, f"root@{ip}", remote_cmd]


def remote_sft_dir(remote_root):
    return posixpath.join(remote_root, "service/sft")


def parse_etime(value):
    text = value.strip()
    if not text:
        return None
    days = 0
    if "-" in text:
        day_part, text = text.split("-", 1)
        days = int(day_part)
    parts = [int(part) for part in text.split(":")]
    if len(parts) == 2:
        hours = 0
        minutes, seconds = parts
    elif len(parts) == 3:
        hours, minutes, seconds = parts
    else:
        return None
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def format_seconds(value):
    if value is None:
        return "n/a"
    seconds = int(round(value))
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}h {minutes}m {secs}s"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def remote_monitor_snapshot(pod, remote_root):
    sft_dir = shlex.quote(remote_sft_dir(remote_root))
    remote_cmd = (
        f"cd {sft_dir} && "
        "python3 - <<'PY'\n"
        "import glob, json, os, re, subprocess\n"
        "total = 12889\n"
        "log_path = '.adapters/a3b-r4-cuda.train.log'\n"
        "adapter_dir = '.adapters/a3b-r4-cuda'\n"
        "script_path = os.path.abspath('sft_cuda_train.py')\n"
        "pid = ''\n"
        "try:\n"
        "    pids = subprocess.check_output(['pgrep', '-f', script_path], text=True).strip().splitlines()\n"
        "    pid = pids[0] if pids else ''\n"
        "except subprocess.CalledProcessError:\n"
        "    pid = ''\n"
        "etime = ''\n"
        "if pid:\n"
        "    try:\n"
        "        etime = subprocess.check_output(['ps', '-p', pid, '-o', 'etime='], text=True).strip()\n"
        "    except subprocess.CalledProcessError:\n"
        "        etime = ''\n"
        "checkpoints = []\n"
        "for path in glob.glob(os.path.join(adapter_dir, 'checkpoint-*')):\n"
        "    name = os.path.basename(path)\n"
        "    try:\n"
        "        checkpoints.append(int(name.split('-', 1)[1]))\n"
        "    except Exception:\n"
        "        pass\n"
        "checkpoints.sort()\n"
        "log_text = ''\n"
        "if os.path.isfile(log_path):\n"
        "    with open(log_path, 'r', errors='replace') as fh:\n"
        "        log_text = fh.read().replace('\\r', '\\n')\n"
        "train_text = log_text\n"
        "marker = 'starting training'\n"
        "if marker in log_text:\n"
        "    train_text = log_text.split(marker, 1)[1]\n"
        "progress = []\n"
        "for done, total_seen in re.findall(r'(\\d+)/(\\d+)', train_text):\n"
        "    if total_seen == str(total):\n"
        "        progress.append(int(done))\n"
        "progress_step = max(progress) if progress else 0\n"
        "checkpoint_step = checkpoints[-1] if checkpoints else 0\n"
        "effective_step = max(progress_step, checkpoint_step)\n"
        "lines = [line for line in log_text.splitlines() if line.strip()]\n"
        "tail = lines[-12:]\n"
        "latest_metrics = None\n"
        "if checkpoints:\n"
        "    state_path = os.path.join(adapter_dir, f'checkpoint-{checkpoints[-1]}', 'trainer_state.json')\n"
        "    if os.path.isfile(state_path):\n"
        "        try:\n"
        "            with open(state_path, 'r') as fh:\n"
        "                state = json.load(fh)\n"
        "            rows = [row for row in state.get('log_history', []) if isinstance(row, dict) and 'loss' in row]\n"
        "            if rows:\n"
        "                latest_metrics = rows[-1]\n"
        "        except Exception:\n"
        "            latest_metrics = None\n"
        "print(json.dumps({\n"
        "    'pid': pid,\n"
        "    'alive': bool(pid),\n"
        "    'etime': etime,\n"
        "    'total': total,\n"
        "    'progress_step': progress_step,\n"
        "    'checkpoint_step': checkpoint_step,\n"
        "    'effective_step': effective_step,\n"
        "    'checkpoints': checkpoints,\n"
        "    'latest_metrics': latest_metrics,\n"
        "    'tail': tail,\n"
        "    'log_path': os.path.abspath(log_path),\n"
        "    'adapter_dir': os.path.abspath(adapter_dir),\n"
        "}))\n"
        "PY"
    )
    proc = run_local(ssh_command(pod, remote_cmd), capture_output=True)
    return json.loads(proc.stdout)


def render_monitor(summary, snapshot):
    total = snapshot["total"]
    done = snapshot["effective_step"]
    pct = (done / total * 100.0) if total else 0.0
    etime_seconds = parse_etime(snapshot.get("etime", ""))
    steps_per_hour = None
    eta_seconds = None
    if etime_seconds and done > 0:
        steps_per_hour = done / etime_seconds * 3600.0
        remaining = max(total - done, 0)
        if steps_per_hour > 0:
            eta_seconds = remaining / steps_per_hour * 3600.0
    checkpoint_step = snapshot["checkpoint_step"]
    cost = summary.get("costPerHr")
    lines = [
        f"pod: {summary['name']} :: {summary['id']}",
        f"gpu: {summary.get('gpu') or 'unknown'} :: ${cost}/hr" if cost is not None else f"gpu: {summary.get('gpu') or 'unknown'}",
        f"ssh: ssh -o StrictHostKeyChecking=no -p {summary['sshPort']} root@{summary['publicIp']}" if summary.get("publicIp") and summary.get("sshPort") else "ssh: pending",
        f"training: {'alive' if snapshot['alive'] else 'down'}" + (f" :: pid {snapshot['pid']}" if snapshot.get("pid") else ""),
        f"progress: {done}/{total} ({pct:.2f}%)",
        f"checkpoint: {checkpoint_step}" if checkpoint_step else "checkpoint: none yet",
        f"elapsed: {snapshot.get('etime') or 'n/a'}",
        f"pace: {steps_per_hour:.1f} steps/hr" if steps_per_hour is not None else "pace: n/a",
        f"eta: {format_seconds(eta_seconds)}" if eta_seconds is not None else "eta: n/a",
        f"log: {snapshot['log_path']}",
    ]
    latest_metrics = snapshot.get("latest_metrics") or {}
    if latest_metrics:
        lines.append(
            "metrics: "
            f"loss {latest_metrics.get('loss'):.6f} :: "
            f"token_acc {latest_metrics.get('mean_token_accuracy'):.4f} :: "
            f"grad_norm {latest_metrics.get('grad_norm'):.6f}"
        )
    if snapshot["tail"]:
        lines.append("latest:")
        lines.extend(snapshot["tail"][-5:])
    return "\n".join(lines)


def create_query(args, gpu_type, public_key):
    lines = [
        "mutation {",
        "  podFindAndDeployOnDemand(",
        "    input: {",
        f"      cloudType: {args.cloud_type}",
        "      gpuCount: 1",
        f"      volumeInGb: {args.volume_gb}",
        f"      containerDiskInGb: {args.container_disk_gb}",
        f"      minVcpuCount: {args.min_vcpu}",
        f"      minMemoryInGb: {args.min_memory_gb}",
        f"      gpuTypeId: {json.dumps(gpu_type)}",
        f"      name: {json.dumps(args.name)}",
        f"      imageName: {json.dumps(args.image)}",
        '      dockerArgs: ""',
        '      ports: "22/tcp,8000/http"',
        '      volumeMountPath: "/workspace"',
        f"      allowedCudaVersions: {json.dumps(args.allowed_cuda_versions)}",
        "      supportPublicIp: true",
        f'      env: [{{ key: "PUBLIC_KEY", value: {json.dumps(public_key)} }}]',
        "    }",
        "  ) {",
        "    id",
        "    name",
        "    desiredStatus",
        "    imageName",
        "    machineId",
        "    costPerHr",
        "    ports",
        "  }",
        "}",
    ]
    return "\n".join(lines)


def command_create(args):
    api_key = require_api_key()
    existing = find_pod(api_key, name=args.name)
    if existing and existing.get("desiredStatus") != "TERMINATED":
        print(json.dumps({"ok": True, "created": False, "pod": summarize_pod(existing)}))
        return

    public_key = detect_public_key()
    attempts = []
    for gpu_type in args.gpu_types:
        result = graphql(api_key, create_query(args, gpu_type, public_key))
        errors = result.get("errors") or []
        pod = ((result.get("data") or {}).get("podFindAndDeployOnDemand"))
        if pod:
            created = find_pod(api_key, pod_id=pod["id"])
            print(json.dumps({"ok": True, "created": True, "pod": summarize_pod(created or pod), "gpuTypeId": gpu_type}))
            return
        if errors:
            err = errors[0]
            attempts.append({
                "gpuTypeId": gpu_type,
                "code": (err.get("extensions") or {}).get("code"),
                "message": err.get("message"),
            })
            if (err.get("extensions") or {}).get("code") == "INSUFFICIENT_BALANCE":
                print(json.dumps({"ok": False, "error": "RunPod account balance is too low to rent the requested pod", "attempts": attempts}))
                sys.exit(1)
            continue
    print(json.dumps({"ok": False, "error": "no requested RunPod GPU could be provisioned", "attempts": attempts}))
    sys.exit(1)


def command_status(args):
    api_key = require_api_key()
    pod = find_pod(api_key, pod_id=args.pod_id, name=args.name)
    if not pod:
        print(json.dumps({"ok": False, "error": "pod not found"}))
        sys.exit(1)
    summary = summarize_pod(pod)
    if summary["publicIp"] and summary["sshPort"]:
        summary["ssh"] = f"ssh -o StrictHostKeyChecking=no -p {summary['sshPort']} root@{summary['publicIp']}"
    print(json.dumps({"ok": True, "pod": summary}))


def make_tarball(paths):
    repo = repo_root()
    fd, temp_path = tempfile.mkstemp(prefix="runpod-r4-", suffix=".tgz")
    os.close(fd)
    with tarfile.open(temp_path, "w:gz") as tar:
        for path in paths:
            src = repo / path
            if not src.exists() and path in FALLBACK_SOURCES:
                src = FALLBACK_SOURCES[path]
            if not src.exists():
                os.unlink(temp_path)
                fail(f"missing required path for bootstrap: {src}")
            tar.add(src, arcname=path)
    return temp_path


def command_bootstrap(args):
    api_key = require_api_key()
    pod = find_pod(api_key, pod_id=args.pod_id, name=args.name)
    if not pod:
        fail("pod not found")
    ip, port = ssh_target(pod)
    tarball = make_tarball(BUNDLE_PATHS)
    remote_tar = "/tmp/runpod-r4-bootstrap.tgz"
    remote_root_q = shlex.quote(args.remote_root)
    remote_sft_q = shlex.quote(remote_sft_dir(args.remote_root))
    remote_tar_q = shlex.quote(remote_tar)
    try:
        run_local(["scp", "-P", port, "-o", "StrictHostKeyChecking=no", tarball, f"root@{ip}:{remote_tar}"])
        remote_cmd = (
            f"mkdir -p {remote_root_q} && "
            f"tar xzf {remote_tar_q} --no-same-owner -C {remote_root_q} && "
            f"chmod +x {remote_sft_q}/launch-r4-cuda.sh {remote_sft_q}/setup-sft-cuda.sh && "
            f"cd {remote_sft_q} && "
            "bash setup-sft-cuda.sh && "
            "python3 sft_cuda_train.py --help | grep -q -- '--last-layers'"
        )
        run_local(ssh_command(pod, remote_cmd))
    finally:
        os.unlink(tarball)
    print(json.dumps({"ok": True, "pod": summarize_pod(pod), "remoteRoot": args.remote_root}))


def command_train(args):
    api_key = require_api_key()
    pod = find_pod(api_key, pod_id=args.pod_id, name=args.name)
    if not pod:
        fail("pod not found")
    sft_dir = shlex.quote(remote_sft_dir(args.remote_root))
    remote_cmd = (
        f"cd {sft_dir} && "
        "python3 - <<'PY'\n"
        "import json, os, pathlib, subprocess, sys\n"
        "root = pathlib.Path('.')\n"
        "adapter_dir = root / '.adapters' / 'a3b-r4-cuda'\n"
        "adapter_dir.mkdir(parents=True, exist_ok=True)\n"
        "script_path = str((root / 'sft_cuda_train.py').resolve())\n"
        "proc = subprocess.run(['pgrep', '-f', script_path], text=True, capture_output=True)\n"
        "pid = proc.stdout.strip().splitlines()[0] if proc.stdout.strip() else ''\n"
        "if pid:\n"
        "    print(json.dumps({'mode': 'noop_alive', 'pid': pid, 'resumeFromCheckpoint': None}))\n"
        "    raise SystemExit(0)\n"
        "checkpoints = []\n"
        "for path in adapter_dir.glob('checkpoint-*'):\n"
        "    try:\n"
        "        checkpoints.append((int(path.name.split('-', 1)[1]), path))\n"
        "    except Exception:\n"
        "        pass\n"
        "checkpoints.sort(key=lambda item: item[0])\n"
        "resume_path = str(checkpoints[-1][1]) if checkpoints else ''\n"
        "mode = 'resume' if resume_path else 'fresh'\n"
        "env = os.environ.copy()\n"
        "if resume_path:\n"
        "    env['RESUME_FROM_CHECKPOINT'] = resume_path\n"
        "log_path = root / '.adapters' / 'a3b-r4-cuda.train.log'\n"
        "with open(log_path, 'a') as log_file:\n"
        "    child = subprocess.Popen(['./launch-r4-cuda.sh'], cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)\n"
        "print(json.dumps({'mode': mode, 'pid': child.pid, 'resumeFromCheckpoint': resume_path or None}))\n"
        "PY"
    )
    proc = subprocess.run(ssh_command(pod, remote_cmd), check=True, text=True, capture_output=True)
    result = json.loads(proc.stdout)
    print(json.dumps({"ok": True, "pod": summarize_pod(pod), "remoteRoot": args.remote_root, **result}))


def command_stop(args):
    api_key = require_api_key()
    pod = find_pod(api_key, pod_id=args.pod_id, name=args.name)
    if not pod:
        fail("pod not found")
    result = graphql(api_key, f'mutation {{ podStop(input: {{ podId: "{pod["id"]}" }}) {{ id desiredStatus }} }}')
    print(json.dumps({"ok": True, "result": (result.get("data") or {}).get("podStop")}))


def command_resume(args):
    api_key = require_api_key()
    pod = find_pod(api_key, pod_id=args.pod_id, name=args.name)
    if not pod:
        fail("pod not found")
    result = graphql(api_key, f'mutation {{ podResume(input: {{ podId: "{pod["id"]}", gpuCount: 1 }}) {{ id desiredStatus imageName }} }}')
    print(json.dumps({"ok": True, "result": (result.get("data") or {}).get("podResume")}))


def command_ssh(args):
    api_key = require_api_key()
    pod = find_pod(api_key, pod_id=args.pod_id, name=args.name)
    if not pod:
        fail("pod not found")
    ip, port = ssh_target(pod)
    print(json.dumps({"ok": True, "ssh": f"ssh -o StrictHostKeyChecking=no -p {port} root@{ip}"}))


def command_bundle(args):
    out_path = pathlib.Path(args.out)
    if not out_path.is_absolute():
        out_path = repo_root() / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = make_tarball(BUNDLE_PATHS)
    os.replace(temp_path, out_path)
    print(json.dumps({"ok": True, "bundle": str(out_path), "paths": BUNDLE_PATHS}))


def command_monitor(args):
    api_key = require_api_key()
    pod = find_pod(api_key, pod_id=args.pod_id, name=args.name)
    if not pod:
        fail("pod not found")
    summary = summarize_pod(pod)

    def one_snapshot():
        snapshot = remote_monitor_snapshot(pod, args.remote_root)
        if args.json:
            payload = {"pod": summary, "monitor": snapshot}
            print(json.dumps(payload))
        else:
            stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            print(f"[{stamp}]")
            print(render_monitor(summary, snapshot))
        return snapshot

    polls = 0
    while True:
        one_snapshot()
        polls += 1
        if not args.watch:
            return
        if args.max_polls and polls >= args.max_polls:
            return
        time.sleep(args.interval)
        if not args.json:
            print()


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create")
    create.add_argument("--name", default=DEFAULT_NAME)
    create.add_argument("--cloud-type", default="ALL")
    create.add_argument("--image", default=DEFAULT_IMAGE)
    create.add_argument("--volume-gb", type=int, default=200)
    create.add_argument("--container-disk-gb", type=int, default=100)
    create.add_argument("--min-vcpu", type=int, default=8)
    create.add_argument("--min-memory-gb", type=int, default=64)
    create.add_argument("--gpu-types", nargs="+", default=GPU_PRIORITY)
    create.add_argument("--allowed-cuda-versions", nargs="+", default=DEFAULT_ALLOWED_CUDA_VERSIONS)
    create.set_defaults(fn=command_create)

    for name, fn in (
        ("status", command_status),
        ("bootstrap", command_bootstrap),
        ("train", command_train),
        ("stop", command_stop),
        ("resume", command_resume),
        ("ssh", command_ssh),
        ("bundle", command_bundle),
        ("monitor", command_monitor),
    ):
        subp = sub.add_parser(name)
        subp.add_argument("--pod-id", default=None)
        subp.add_argument("--name", default=DEFAULT_NAME)
        if name in ("bootstrap", "train", "monitor"):
            subp.add_argument("--remote-root", default=DEFAULT_REMOTE_ROOT)
        if name == "bundle":
            subp.add_argument("--out", default="service/sft/.artifacts/a3b-r4-cuda-bundle.tgz")
        if name == "monitor":
            subp.add_argument("--watch", action="store_true")
            subp.add_argument("--interval", type=int, default=20)
            subp.add_argument("--max-polls", type=int, default=0)
            subp.add_argument("--json", action="store_true")
        subp.set_defaults(fn=fn)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
