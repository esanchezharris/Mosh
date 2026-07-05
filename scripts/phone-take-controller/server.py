#!/usr/bin/env python3
"""Phone take-controller: DAWN's recording loop on phone buttons, driving Ableton Live.

    iPhone Safari --HTTP/LAN--> this server (:8123) --OSC/UDP 11000/11001--> AbletonOSC --> Live

Stdlib only. Run:  python3 server.py   then scan the QR (or type the printed URL) on a
phone that's on the same Wi-Fi. Requires Ableton Live running with the AbletonOSC
control surface selected (Settings > Link/Tempo/MIDI > Control Surface: AbletonOSC).

Session-view take loop (the old DAWN voice assistant, buttons instead of voice). Each take
records into its own clip slot on the armed track; keepers stack down the column. This is
DAWN's real mechanic: stash every keeper, delete-and-redo for retries -- no undo, no take
lanes (both proved fragile/unreadable over OSC in the phase-0 spike).

  PUT ME IN  record a fresh take (next empty slot)   KEEP    take stays, roll the next slot
  AGAIN      delete this take, re-record same slot    HEAR IT play the current take back
  STOP       stop everything                          - / +   move between takes

Demo rig: binds the LAN interface with no auth token. Don't run it on hostile networks.
"""
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HTTP_PORT = int(os.environ.get("PTC_HTTP_PORT", "8123"))
ABLETON_ADDR = ("127.0.0.1", int(os.environ.get("PTC_OSC_SEND_PORT", "11000")))
OSC_RECV_PORT = int(os.environ.get("PTC_OSC_RECV_PORT", "11001"))
FORCE_TRACK = os.environ.get("PTC_TRACK")  # override armed-track auto-detect if set

PAUSED, PLAYING, RECORDING = "PAUSED", "PLAYING", "RECORDING"

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- OSC (minimal)

def _pad(b: bytes) -> bytes:
    return b + b"\x00" * ((4 - len(b) % 4) % 4)


def osc_pack(addr: str, *args) -> bytes:
    msg = _pad(addr.encode() + b"\x00")
    tags, data = ",", b""
    for a in args:
        if isinstance(a, float):
            tags += "f"
            data += struct.pack(">f", a)
        elif isinstance(a, int):
            tags += "i"
            data += struct.pack(">i", a)
        elif isinstance(a, str):
            tags += "s"
            data += _pad(a.encode() + b"\x00")
        else:
            raise TypeError(f"unsupported OSC arg {a!r}")
    return msg + _pad(tags.encode() + b"\x00") + data


def osc_unpack(dgram: bytes):
    end = dgram.index(b"\x00")
    addr = dgram[:end].decode(errors="replace")
    i = (end + 4) & ~3
    args = []
    if i < len(dgram) and dgram[i : i + 1] == b",":
        end = dgram.index(b"\x00", i)
        tags = dgram[i + 1 : end].decode(errors="replace")
        i = (end + 4) & ~3
        for t in tags:
            if t == "i":
                args.append(struct.unpack(">i", dgram[i : i + 4])[0]); i += 4
            elif t == "f":
                args.append(struct.unpack(">f", dgram[i : i + 4])[0]); i += 4
            elif t == "d":
                args.append(struct.unpack(">d", dgram[i : i + 8])[0]); i += 8
            elif t == "s":
                end = dgram.index(b"\x00", i)
                args.append(dgram[i:end].decode(errors="replace")); i = (end + 4) & ~3
            elif t == "T":
                args.append(True)
            elif t == "F":
                args.append(False)
            else:
                break
    return addr, args


# ---------------------------------------------------------------- Live link

class LiveLink:
    """Sends OSC to AbletonOSC, tracks Live's transport from listeners, and does
    synchronous request/reply queries over the same (single) 11001 socket."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", OSC_RECV_PORT))
        self.lock = threading.Lock()
        self.live = {"is_playing": 0, "beat": 0.0, "tempo": 0.0}
        self.last_rx = 0.0
        self.rtt_ms = None
        self._hb_sent = None
        # synchronous-query plumbing (rx_loop is the only socket reader)
        self.q_cv = threading.Condition()
        self.q_last = {}   # addr -> (args, seq)
        self.q_seq = 0
        threading.Thread(target=self._rx_loop, daemon=True).start()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()

    def send(self, addr, *args):
        self.sock.sendto(osc_pack(addr, *args), ABLETON_ADDR)

    def subscribe(self):
        for prop in ("is_playing", "beat", "tempo"):
            self.send(f"/live/song/start_listen/{prop}")

    def _rx_loop(self):
        while True:
            try:
                dgram, _ = self.sock.recvfrom(65536)
            except OSError:
                continue
            addr, args = osc_unpack(dgram)
            now = time.time()
            with self.lock:
                self.last_rx = now
                if addr.startswith("/live/song/get/") and args:
                    prop = addr.rsplit("/", 1)[-1]
                    if prop in self.live:
                        self.live[prop] = float(args[0]) if prop in ("beat", "tempo") else int(bool(args[0]))
                    if prop == "is_playing" and self._hb_sent is not None:
                        self.rtt_ms = (now - self._hb_sent) * 1000.0
                        self._hb_sent = None
            with self.q_cv:
                self.q_seq += 1
                self.q_last[addr] = (args, self.q_seq)
                self.q_cv.notify_all()

    def _heartbeat_loop(self):
        while True:
            with self.lock:
                self._hb_sent = time.time()
            self.send("/live/song/get/is_playing")
            time.sleep(2.0)

    def query(self, addr, *args, timeout=1.0):
        """Send addr(args) and wait for the next reply on that addr. Returns args or None."""
        with self.q_cv:
            before = self.q_last.get(addr, (None, 0))[1]
            self.send(addr, *args)
            end = time.time() + timeout
            while True:
                cur = self.q_last.get(addr, (None, 0))
                if cur[1] > before:
                    return cur[0]
                remaining = end - time.time()
                if remaining <= 0:
                    return None
                self.q_cv.wait(remaining)

    def armed_track(self):
        """Index of the first armed track, or None. (FORCE_TRACK overrides.)"""
        if FORCE_TRACK is not None:
            return int(FORCE_TRACK)
        n = self.query("/live/song/get/num_tracks")
        if not n:
            return None
        for i in range(int(n[0])):
            a = self.query("/live/track/get/arm", i)
            if a and len(a) > 1 and a[1]:
                return i
        return None

    def snapshot(self):
        with self.lock:
            connected = (time.time() - self.last_rx) < 5.0
            bpb = 4
            bar = int(self.live["beat"] // bpb) + 1 if connected else None
            return {
                "connected": connected,
                "is_playing": bool(self.live["is_playing"]),
                "beat": self.live["beat"],
                "bar": bar,
                "tempo": self.live["tempo"],
                "osc_rtt_ms": round(self.rtt_ms, 1) if self.rtt_ms is not None else None,
            }


# ---------------------------------------------------------------- take loop

class TakeLoop:
    """DAWN's loop in Ableton Session view. Each take is a clip in a slot on the armed
    track; `filled` is the controller's own record of which slots hold takes (no per-action
    queries needed -- the controller is the only thing creating/deleting these clips)."""

    def __init__(self, link: LiveLink):
        self.link = link
        self.lock = threading.Lock()
        self.state = PAUSED
        self.track = None
        self.cur = 0            # active slot
        self.filled = set()     # slots holding a take
        self.err = None         # last "arm a track" style hint

    def _next_empty(self):
        i = 0
        while i in self.filled:
            i += 1
        return i

    def _ensure_track(self, refresh=False):
        if refresh or self.track is None:
            t = self.link.armed_track()
            if t is not None:
                self.track = t
        return self.track

    def _record_into(self, slot):
        self.link.send("/live/clip_slot/fire", self.track, slot)
        self.filled.add(slot)
        self.cur = slot
        self.state = RECORDING

    def action(self, name: str, arg=None):
        with self.lock:
            self.err = None
            if name in ("record", "keep", "again"):
                t = self._ensure_track(refresh=(name == "record"))
                if t is None:
                    self.err = "arm a track in Live first"
                    return self.err

            if name == "record":  # PUT ME IN -- fresh take in the next empty slot
                slot = self._next_empty()
                self.link.send("/live/clip_slot/stop", self.track, self.cur)
                time.sleep(0.05)
                self._record_into(slot)
                return f"recording take {slot + 1}"

            if name == "keep":  # this take stays; roll the next slot
                self.link.send("/live/clip_slot/stop", self.track, self.cur)
                time.sleep(0.1)
                slot = self._next_empty()
                self._record_into(slot)
                return f"kept take {slot} -> recording take {slot + 1}"

            if name == "again":  # trash this take, re-record the same slot
                self.link.send("/live/clip_slot/stop", self.track, self.cur)
                time.sleep(0.1)
                self.link.send("/live/clip_slot/delete_clip", self.track, self.cur)
                self.filled.discard(self.cur)
                time.sleep(0.15)
                self._record_into(self.cur)
                return f"redoing take {self.cur + 1}"

            if name == "play":  # HEAR IT -- play the current take
                t = self._ensure_track()
                if t is None:
                    self.err = "arm a track in Live first"
                    return self.err
                if self.cur not in self.filled:
                    self.err = "no take here yet"
                    return self.err
                self.link.send("/live/clip_slot/fire", self.track, self.cur)
                self.state = PLAYING
                return f"playing take {self.cur + 1}"

            if name == "stop":
                self.link.send("/live/song/stop_playing")
                if self.track is not None:
                    self.link.send("/live/clip_slot/stop", self.track, self.cur)
                self.state = PAUSED
                return "stopped"

            if name == "prev":
                self.cur = max(0, self.cur - 1)
                return f"take {self.cur + 1}"

            if name == "next":
                self.cur += 1
                return f"take {self.cur + 1}"

            raise ValueError(f"unknown action {name!r}")

    def snapshot(self):
        with self.lock:
            return {
                "state": self.state,
                "take": self.cur + 1,
                "cur_has_take": self.cur in self.filled,
                "kept": len(self.filled),
                "track": self.track,
                "hint": self.err,
            }


# ---------------------------------------------------------------- HTTP

def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packet sent; just picks the outbound interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class Handler(BaseHTTPRequestHandler):
    link: LiveLink = None
    loop: TakeLoop = None

    def _reply(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _page(self, name):
        try:
            with open(os.path.join(HERE, name), "rb") as f:
                self._reply(200, f.read(), "text/html; charset=utf-8")
        except FileNotFoundError:
            self._reply(404, {"error": f"{name} missing"})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            self._page("index.html")
        elif path == "/qr":
            self._page("qr.html")
        elif path == "/state":
            self._reply(200, {**self.loop.snapshot(), "live": self.link.snapshot()})
        elif path == "/url":
            self._reply(200, {"url": f"http://{lan_ip()}:{HTTP_PORT}/"})
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/action":
            return self._reply(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            msg = self.loop.action(req.get("action", ""), req.get("arg"))
            print(f"[action] {msg}")
            self._reply(200, {"ok": True, "msg": msg, **self.loop.snapshot(), "live": self.link.snapshot()})
        except (ValueError, json.JSONDecodeError) as e:
            self._reply(400, {"ok": False, "error": str(e)})

    def log_message(self, *a):  # quiet
        pass


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)  # keep logs visible when redirected
    except AttributeError:
        pass
    link = LiveLink()
    link.subscribe()
    Handler.link = link
    Handler.loop = TakeLoop(link)
    url = f"http://{lan_ip()}:{HTTP_PORT}/"
    srv = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler)
    print("=" * 56)
    print("  PHONE TAKE CONTROLLER (DAWN loop -> Ableton Live)")
    print(f"  phone URL : {url}")
    print(f"  QR screen : http://127.0.0.1:{HTTP_PORT}/qr")
    print("  needs     : Live running + AbletonOSC control surface")
    print("=" * 56)
    time.sleep(0.5)
    snap = link.snapshot()
    print(f"  AbletonOSC: {'CONNECTED' if snap['connected'] else 'not answering yet (is the control surface selected?)'}")
    if snap["connected"]:
        t = link.armed_track()
        print(f"  armed track: {t if t is not None else 'NONE -- arm your vocal track in Live'}")
    if "--open-qr" in sys.argv:
        subprocess.Popen(["open", f"http://127.0.0.1:{HTTP_PORT}/qr"])
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
