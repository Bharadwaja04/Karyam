import os

# Tests must never pick up a real .env with real keys.
os.environ.setdefault("KARYAM_NO_DOTENV", "1")
