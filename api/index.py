"""
api/index.py — Vercel Python serverless entrypoint.

Vercel's Python runtime loads a function entrypoint and looks for a WSGI callable
named `app` at module level. Ours is defined in the sibling module `app.py` as
`app = Flask(__name__)`, so this file simply re-exports it.

This file lives at the repository root, next to `app.py`, `requirements.txt` and
`vercel.json`. That keeps the import a plain sibling import and avoids any
`sys.path` manipulation.
"""
from app import app

__all__ = ["app"]
