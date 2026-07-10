from __future__ import annotations

import http.client
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from preview_server import URL_PREFIX, RangeRequestHandler  # noqa: E402


def _serve(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), RangeRequestHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def test_root_redirects_to_the_review_page(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "index.html").write_text("<h1>review</h1>", encoding="utf-8")
    server = _serve(tmp_path, monkeypatch)
    try:
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        connection.request("GET", "/")
        response = connection.getresponse()
        assert response.status == 302
        assert response.getheader("Location") == URL_PREFIX + "/"
        response.read()
        # The redirect target itself serves the review page.
        connection.request("GET", URL_PREFIX + "/")
        target = connection.getresponse()
        assert target.status == 200
        assert b"review" in target.read()
        # Anything else outside the prefix stays fail-closed.
        connection.request("GET", "/etc/passwd")
        other = connection.getresponse()
        assert other.status == 404
        other.read()
        connection.close()
    finally:
        server.shutdown()
        server.server_close()
