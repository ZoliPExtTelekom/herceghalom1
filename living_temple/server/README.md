# Server (Python)

Stack (MVP):
- FastAPI (WebSocket) + uvicorn
- Authoritative room state on the server

Run from repo root:
```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r .\server\requirements.txt
.\.venv\Scripts\python -m uvicorn server.app:app --reload --port 8000
```
