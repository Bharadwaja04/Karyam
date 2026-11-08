"""Tiny .env loader so API keys can live in a file next to the app instead of the browser.

Real environment variables always win over the file. Nothing here is logged or sent anywhere.
"""
from __future__ import annotations

import os
from pathlib import Path


def parse_env(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:  # trailing comment on an unquoted value
            value = value.split(" #", 1)[0].rstrip()
        if key and value:
            out[key] = value
    return out


def load_env() -> list[Path]:
    """Load .env from the project folder and the current folder. Returns the files that were read."""
    if os.getenv("KARYAM_NO_DOTENV") == "1":
        return []
    root = Path(__file__).resolve().parent.parent
    loaded: list[Path] = []
    for path in dict.fromkeys([root / ".env", Path.cwd() / ".env"]):
        try:
            if path.is_file():
                for k, v in parse_env(path.read_text(encoding="utf-8")).items():
                    os.environ.setdefault(k, v)
                loaded.append(path)
        except OSError:
            continue
    return loaded
