"""
api/index.py — the serverless entrypoint.

Vercel builds any `.py` file under `/api` with the Python runtime and serves it
as a WSGI app, looking for a module-level callable named `app`. Ours lives in
`app.py` at the repository root, which is NOT automatically on the import path
inside the function bundle, so the root is added explicitly first.

There is nothing else to configure, and that is the point: the catch-all rewrite
in vercel.json sends EVERY request here — pages, assets and API alike — so Flask
routes them exactly as it does locally. No asset prefix has to be rewritten, no
static output directory has to be kept in sync, and there is no second way to
serve the frontend that could disagree with the first one.

Two things made this possible, and both are worth keeping:

  1. `/step` is idempotent. It carries the scenario and the step index, so the
     server can rebuild the mission from scratch and replay to that point. A
     stateless function can therefore hold a mission without holding any state.
  2. `mission_trace.json` is written to /tmp when the working directory is
     read-only, which is the normal case for a serverless function.
"""
import os
import sys

# Put the repository root on the import path so `import app` resolves to
# /app.py rather than to this package.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: E402  (the import must follow the sys.path fix)

__all__ = ["app"]
