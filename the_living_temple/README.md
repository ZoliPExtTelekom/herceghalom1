# The Living Temple (MVP)

2-player cooperative browser game:
- Python server (FastAPI WebSocket) - authoritative simulation
- JS client (Canvas) - connects via WebSocket

## Run locally

1) Create a virtualenv and install deps:

```powershell
cd C:\Users\veress1sand118\CodexProjekt\the_living_temple
python -m venv .venv
.\.venv\Scripts\pip install -r .\server\requirements.txt
```

2) Start the server:

```powershell
.\.venv\Scripts\python -m uvicorn server.app:app --reload --port 8000
```

3) Open in two browser windows:
- `http://localhost:8000/`
- Leave room code empty in the first window (creates a room)
- Copy the room code into the second window and connect
- Click `Ready` in both windows

Controls:
- Move: WASD / arrows
- Interact (hold): E
- Ping: click on canvas
- Quick chat: buttons

