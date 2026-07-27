#!/usr/bin/env python3
"""
Static server for the arcade hub.

Replaces a bare `python3 -m http.server`, which sends no Cache-Control at all.
With only Last-Modified present, browsers fall back to *heuristic* caching
(~10% of the document's age), so a visitor who loaded the hub before a deploy
keeps serving themselves a stale registry.json without ever revalidating. That
is how OpenFlight Sim stayed invisible on the cabinet after it was deployed:
the origin was correct and the browser never asked.

Policy:
  - *.html / *.json / *.js  -> no-cache (revalidate every time; 304s stay cheap)
  - everything else         -> cached for a day: thumbnails, fonts and audio are
                               large, and a stale image is cosmetic where stale
                               code or a stale catalog is the bug being fixed

Stdlib only, so it has the same dependency footprint as http.server.

Usage: PORT=8000 python3 scripts/serve.py [--bind 127.0.0.1] [--dir <path>]
"""

import argparse
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

REVALIDATE_SUFFIXES = (".html", ".json", ".js", ".mjs", ".css", "/")
IMMUTABLE_MAX_AGE = 86400


class ArcadeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path.endswith(REVALIDATE_SUFFIXES) or path == "":
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        else:
            self.send_header("Cache-Control", f"public, max-age={IMMUTABLE_MAX_AGE}")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--dir", default=os.getcwd())
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = ap.parse_args()

    handler = partial(ArcadeHandler, directory=args.dir)
    with ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        sys.stderr.write(f"arcade serving {args.dir} on {args.bind}:{args.port}\n")
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
