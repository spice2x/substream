"""Static file server, only here so phones and tablets on the LAN can load the app.

Plain HTTP on purpose: an HTTPS page cannot talk to the game's http:// and ws:// ports.
Caching is switched off because a stale app.js on a phone is indistinguishable from a bug.
"""

import functools
import http.server
import os
import sys

# not 8080: spice2x runs its own e-amusement server there for -ea and smart ea. 45000 also
# stays below the 49152 dynamic range, which outbound connections are allocated from.
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 45000
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


handler = functools.partial(Handler, directory=ROOT)
http.server.ThreadingHTTPServer(("0.0.0.0", PORT), handler).serve_forever()
