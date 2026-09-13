#!/usr/bin/env python3
"""Tiny static server for String Art Studio.

The app uses ES modules and a Web Worker, so it must be served over http://
rather than opened as a file:// path.

    python serve.py [port]
"""

import http.server
import functools
import os
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".ico": "image/x-icon",
    }

    def end_headers(self):
        # never serve a stale module while editing
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Launched via pythonw.exe there is no console, and sys.stderr is None.
        # Writing to it would raise inside the request handler and kill every
        # response, so drop the log line instead.
        if sys.stderr is None:
            return
        try:
            sys.stderr.write("  %s\n" % (fmt % args))
        except (OSError, ValueError):
            pass


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    no_browser = "--no-browser" in sys.argv
    port = int(args[0]) if args else 8123
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://127.0.0.1:{port}/"
        print(f"String Art Studio  ->  {url}")
        print("Press Ctrl+C to stop.\n")
        if not no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
