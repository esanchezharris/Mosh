#!/usr/bin/env python3
"""Hermetic tests for the brain-proxy cutover (docs/brain-proxy/RUNBOOK.md) — NO
network, NO real keys, NO real proxy required. Mirrors service/lyrics/llm_backend_test.py's
style: monkeypatch the HTTP seam (urllib.request.urlopen / brain_client._chat_via_proxy
directly) rather than hitting a real endpoint, so this is safe to run anywhere,
deterministically, with zero external dependencies (stdlib only).

Covers: proxy_enabled() gating, chat_json()'s proxy-first dispatch, the fallthrough to
the direct-provider path on ANY proxy failure (unreachable / non-ok), that the proxy
seam is never even consulted when MOSH_BRAIN_PROXY_URL is unset (byte-identical
pre-proxy behaviour), and _install_id()'s override + mint-once-and-reuse semantics.

Run:  python3 service/brain_client_test.py     (exit 0 = all pass)
"""
import json
import os
import shutil
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # service/
import brain_client  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _clear_env():
    brain_client._BRAIN_ENV_CACHE = {}   # ignore any real bundled brain.env
    brain_client._INSTALL_ID_CACHE = None
    for k in list(os.environ):
        if (k.endswith(("_API_KEY", "_BASE_URL", "_MODEL"))
                or k in ("MOSHI_BRAIN_PROVIDER", "MOSH_ENABLE_LYRIC", "MOSH_BRAIN_PROXY_URL",
                         "MOSH_BRAIN_PROXY_APIKEY", "MOSH_BRAIN_INSTALL_ID", "MOSH_SELFTEST_SESSION")):
            os.environ.pop(k, None)


class _FakeHTTPResponse:
    """Just enough of urllib's response object for chat_json's `with urlopen(...) as r`."""
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


# ── 1. proxy_enabled() is a pure env read ─────────────────────────────────────────
_clear_env()
check("proxy_enabled() False when MOSH_BRAIN_PROXY_URL is unset", brain_client.proxy_enabled() is False)
os.environ["MOSH_BRAIN_PROXY_URL"] = "https://example.invalid/functions/v1/brain"
check("proxy_enabled() True once MOSH_BRAIN_PROXY_URL is set", brain_client.proxy_enabled() is True)
_clear_env()

# ── 2. chat_json() dispatches to the proxy first, and returns ITS result untouched ──
# No provider is configured anywhere in this block — success here can only come from
# the proxy branch, proving chat_json really tried the proxy first (not resolve()).
os.environ["MOSH_BRAIN_PROXY_URL"] = "https://example.invalid/functions/v1/brain"
_real_chat_via_proxy = brain_client._chat_via_proxy
try:
    calls = []

    def _fake_proxy_ok(messages, requested="", timeout=60, temperature=None):
        calls.append({"messages": messages, "requested": requested})
        return {"ok": True, "content": "hello from the proxy", "provider": "proxy", "model": ""}

    brain_client._chat_via_proxy = _fake_proxy_ok
    r = brain_client.chat_json([{"role": "user", "content": "hi"}])
    check("chat_json() returns the proxy's content when the proxy succeeds",
          r.get("ok") is True and r.get("content") == "hello from the proxy", str(r))
    check("chat_json() never discloses a real provider id for a proxied reply",
          r.get("provider") == "proxy", str(r))
    check("the proxy call actually ran (dispatched before any provider resolution)", len(calls) == 1)
finally:
    brain_client._chat_via_proxy = _real_chat_via_proxy
_clear_env()

# ── 3. Proxy failure falls through to the direct-provider path (no provider case) ──
os.environ["MOSH_BRAIN_PROXY_URL"] = "https://example.invalid/functions/v1/brain"
try:
    brain_client._chat_via_proxy = lambda *a, **k: {"ok": False, "error": "proxy down"}
    r = brain_client.chat_json([{"role": "user", "content": "hi"}])
    check("proxy failure + no provider configured ⇒ ok:false", r.get("ok") is False, str(r))
    check("...with the PROVIDER path's own error (proves real fallthrough, not just the proxy's error)",
          "no brain provider configured" in r.get("error", ""), str(r))
finally:
    brain_client._chat_via_proxy = _real_chat_via_proxy
_clear_env()

# ── 4. Proxy failure falls through to a configured provider, which then succeeds ───
os.environ["MOSH_BRAIN_PROXY_URL"] = "https://example.invalid/functions/v1/brain"
os.environ["DEEPSEEK_BASE_URL"] = "https://api.deepseek.test"
os.environ["DEEPSEEK_API_KEY"] = "sk-test-deepseek"
os.environ["DEEPSEEK_MODEL"] = "deepseek-test"
_real_urlopen = urllib.request.urlopen
try:
    brain_client._chat_via_proxy = lambda *a, **k: {"ok": False, "error": "proxy down"}
    urllib.request.urlopen = lambda req, timeout=None: _FakeHTTPResponse(
        {"choices": [{"message": {"content": "provider reply"}}]})
    r = brain_client.chat_json([{"role": "user", "content": "hi"}])
    check("proxy failure + a configured provider ⇒ the provider's reply, ok:true",
          r.get("ok") is True and r.get("content") == "provider reply", str(r))
    check("the fallthrough reply is attributed to the real provider (not \"proxy\")",
          r.get("provider") == "deepseek", str(r))
finally:
    urllib.request.urlopen = _real_urlopen
    brain_client._chat_via_proxy = _real_chat_via_proxy
_clear_env()

# ── 5. Proxy unset ⇒ the proxy seam is never even consulted (byte-identical default) ─
os.environ["DEEPSEEK_BASE_URL"] = "https://api.deepseek.test"
os.environ["DEEPSEEK_API_KEY"] = "sk-test-deepseek"
os.environ["DEEPSEEK_MODEL"] = "deepseek-test"
try:
    def _boom(*_a, **_k):
        raise AssertionError("_chat_via_proxy must not be called when proxy_enabled() is False")
    brain_client._chat_via_proxy = _boom
    urllib.request.urlopen = lambda req, timeout=None: _FakeHTTPResponse(
        {"choices": [{"message": {"content": "direct reply"}}]})
    r = brain_client.chat_json([{"role": "user", "content": "hi"}])
    check("proxy unset ⇒ chat_json() still resolves via the direct-provider path",
          r.get("ok") is True and r.get("content") == "direct reply", str(r))
except AssertionError as e:
    check("proxy seam is skipped entirely when MOSH_BRAIN_PROXY_URL is unset", False, str(e))
else:
    check("proxy seam is skipped entirely when MOSH_BRAIN_PROXY_URL is unset", True)
finally:
    urllib.request.urlopen = _real_urlopen
    brain_client._chat_via_proxy = _real_chat_via_proxy
_clear_env()

# ── 6. _install_id(): the MOSH_BRAIN_INSTALL_ID test/CI override skips the filesystem ─
os.environ["MOSH_BRAIN_INSTALL_ID"] = "test-install-abc123"
check("_install_id() honours the override verbatim", brain_client._install_id() == "test-install-abc123")
_clear_env()

# ── 7. _install_id(): minted once, persisted, and reused — isolated from the real session ─
leaf = "session-brainclient-pytest"
identity_dir = os.path.join(os.path.expanduser("~"), "Library", "Mosh", leaf)
shutil.rmtree(identity_dir, ignore_errors=True)  # start clean regardless of a prior interrupted run
os.environ["MOSH_SELFTEST_SESSION"] = leaf
try:
    first = brain_client._install_id()
    check("_install_id() mints a non-empty id on first use", bool(first))
    check("_install_id() persists identity.json under the isolated session leaf",
          os.path.isfile(os.path.join(identity_dir, "identity.json")))
    brain_client._INSTALL_ID_CACHE = None  # force a re-read from disk, not the in-process cache
    second = brain_client._install_id()
    check("_install_id() reuses the persisted id rather than re-minting", second == first,
          f"{first} != {second}")
finally:
    shutil.rmtree(identity_dir, ignore_errors=True)  # leave no trace
_clear_env()

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
