#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import shutil
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from asserted_proof_verdict import save_review_verdict

URL_PREFIX = "/used2/asserted-proof"
VERDICT_ENDPOINT = URL_PREFIX + "/api/verdict/opening"
MAX_VERDICT_BYTES = 16 * 1024


def load_current_verdict(verdict_path: Path, manifest_path: Path) -> tuple[int, dict]:
    if not verdict_path.is_file():
        return HTTPStatus.OK, {"ok": False, "verdict": None}
    payload = json.loads(verdict_path.read_text(encoding="utf-8"))
    current_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    if payload.get("manifestSha256") != current_hash:
        return HTTPStatus.CONFLICT, {"ok": False, "stale": True, "verdict": None}
    return HTTPStatus.OK, payload


class RangeRequestHandler(SimpleHTTPRequestHandler):
    range_start: int | None = None
    range_end: int | None = None

    def _send_json(self, status: HTTPStatus, payload: dict) -> None:
        encoded = (json.dumps(payload) + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if urlsplit(self.path).path != VERDICT_ENDPOINT:
            super().do_GET()
            return
        try:
            status, payload = load_current_verdict(Path.cwd() / "opening/owner-verdict.json", Path.cwd() / "opening/manifest.json")
        except (OSError, json.JSONDecodeError):
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "saved verdict is unreadable"})
            return
        self._send_json(HTTPStatus(status), payload)

    def do_POST(self) -> None:
        if urlsplit(self.path).path != VERDICT_ENDPOINT:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid content length"})
            return
        if length <= 0 or length > MAX_VERDICT_BYTES:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "invalid verdict size"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise RuntimeError("owner verdict must be a JSON object")
            save_review_verdict(
                payload,
                Path.cwd() / "opening/manifest.json",
                Path.cwd() / "opening/owner-verdict.json",
            )
        except (json.JSONDecodeError, OSError, RuntimeError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        self._send_json(HTTPStatus.CREATED, {"ok": True, "verdict": payload})

    def translate_path(self, path: str) -> str:
        request_path = urlsplit(path).path.rstrip("/") or "/"
        if request_path == URL_PREFIX:
            return super().translate_path("/")
        if request_path.startswith(URL_PREFIX + "/"):
            return super().translate_path(request_path.removeprefix(URL_PREFIX))
        return str(Path.cwd() / "__not_found__")

    def send_head(self):
        root = Path.cwd().resolve()
        path = Path(self.translate_path(self.path)).resolve()
        if not path.is_relative_to(root):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None
        if path.is_dir():
            for name in ("index.html", "index.htm"):
                candidate = path / name
                if candidate.is_file():
                    path = candidate
                    break
            else:
                self.send_error(HTTPStatus.NOT_FOUND, "File not found")
                return None
        try:
            source = path.open("rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None
        size = path.stat().st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            value = range_header.removeprefix("bytes=").split(",", 1)[0]
            left, separator, right = value.partition("-")
            if not left and not right:
                source.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None
            try:
                if left:
                    start = int(left)
                    end = min(int(right), end) if separator and right else end
                elif right:
                    start = max(0, size - int(right))
            except ValueError:
                source.close()
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return None
            if start < 0 or start > end or start >= size:
                source.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None
            self.range_start, self.range_end = start, end
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.range_start = self.range_end = None
            self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(path.stat().st_mtime))
        self.end_headers()
        return source

    def copyfile(self, source, outputfile) -> None:
        if self.range_start is None or self.range_end is None:
            shutil.copyfileobj(source, outputfile)
            return
        source.seek(self.range_start)
        remaining = self.range_end - self.range_start + 1
        while remaining:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            try:
                outputfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return
            remaining -= len(chunk)


def main() -> int:
    parser = argparse.ArgumentParser(description="Range-capable static server for FMS audio review")
    parser.add_argument("--root", type=Path, default=Path("~/mosh-fms-ksb/used2/asserted-proof").expanduser())
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8189)
    args = parser.parse_args()
    try:
        bind_address = ipaddress.ip_address(args.bind)
    except ValueError as error:
        parser.error(f"--bind must be a loopback IP address: {error}")
    if not bind_address.is_loopback:
        parser.error("--bind must be a loopback IP address")
    os.chdir(args.root.expanduser().resolve())
    server = ThreadingHTTPServer((args.bind, args.port), RangeRequestHandler)
    print(f"serving {Path.cwd()} at http://{args.bind}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
