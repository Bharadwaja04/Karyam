#!/usr/bin/env bash
# Start Karyam on macOS or Linux:  bash start.sh
# It never stops or touches anything else you have running. If another program is using the port,
# it simply picks the next free one. If Karyam is already running, it just opens it.
cd "$(dirname "$0")" || exit 1

if ! python3 -c "import fastapi, uvicorn, httpx, multipart" >/dev/null 2>&1; then
  echo "Karyam needs its Python packages. Run this once, then start again:"
  echo "  python3 -m pip install -r requirements.txt"
  exit 1
fi
if [ ! -f .env ]; then cp .env.example .env && echo "Created .env. Open it, add your keys, then run this again." && exit 0; fi

open_page() { (command -v open >/dev/null && open "$1") || (command -v xdg-open >/dev/null && xdg-open "$1") || echo "Open $1 in your browser."; }
is_karyam() { curl -s --max-time 1 "http://127.0.0.1:$1/api/health" 2>/dev/null | grep -q '"server_llm"'; }
in_use() { python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(0.3)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}

port=8765
while in_use "$port"; do
  if is_karyam "$port"; then echo "Karyam is already running on port $port. Opening it."; open_page "http://localhost:$port"; exit 0; fi
  port=$((port + 1))
  [ "$port" -gt 8800 ] && { echo "No free port found between 8765 and 8800."; exit 1; }
done

echo "Starting Karyam at http://localhost:$port  (press Ctrl+C to stop)"
( sleep 2; open_page "http://localhost:$port" ) &
exec python3 -m uvicorn backend.app:app --port "$port"
