from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .game_server import GameServer


ROOT = Path(__file__).resolve().parent
CLIENT_DIR = (ROOT.parent / "client").resolve()


app = FastAPI(title="The Living Temple Server")
game = GameServer()


@app.get("/health")
def health() -> dict:
    return {"ok": True}


if CLIENT_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(CLIENT_DIR)), name="static")


@app.get("/")
def index():
    index_path = CLIENT_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return {"ok": True, "message": "Client not found. Build/serve client/index.html."}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_json({"type": "welcome", "version": 1})
    await game.handle_socket(ws)

