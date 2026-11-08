@echo off
rem Start Karyam on Windows. It never touches other programs: it uses port 8765.
cd /d "%~dp0"
python -c "import fastapi, uvicorn, httpx, multipart" >nul 2>&1 || (echo Run once: python -m pip install -r requirements.txt & exit /b 1)
if not exist .env (copy .env.example .env >nul & echo Created .env. Open it, add your keys, then run this again. & exit /b 0)
echo Starting Karyam at http://localhost:8765  (press Ctrl+C to stop)
start "" http://localhost:8765
python -m uvicorn backend.app:app --port 8765
