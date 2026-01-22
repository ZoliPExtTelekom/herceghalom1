from __future__ import annotations

import asyncio
import random
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from .rooms import ROOM_COUNT, build_room, reset_room_runtime_state, room_apply_interact, room_tick
from .util import clamp, dist2, normalize


TICK_HZ = 20
DT = 1.0 / TICK_HZ
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _gen_room_code() -> str:
    return "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(5))


async def _safe_send(ws: WebSocket, msg: dict[str, Any]) -> None:
    try:
        await ws.send_json(msg)
    except Exception:
        pass


@dataclass
class PlayerConn:
    ws: WebSocket
    player_id: int
    role: str
    name: str = ""
    last_seq: int = 0
    move_x: float = 0.0
    move_y: float = 0.0
    interact_held: bool = False


@dataclass
class PlayerState:
    player_id: int
    role: str
    x: float
    y: float
    hp: int = 3
    down: bool = False
    ready: bool = False
    revive_progress: float = 0.0
    damage_cd: dict[str, float] = field(default_factory=dict)


@dataclass
class Room:
    code: str
    created_at: float
    rng_seed: int
    escape_code: str
    code_fragments: list[dict[str, Any]]
    conns: dict[int, PlayerConn] = field(default_factory=dict)
    players: dict[int, PlayerState] = field(default_factory=dict)
    room_index: int = 0
    tick: int = 0
    started: bool = False
    messages: list[dict[str, Any]] = field(default_factory=list)
    room_static: dict[str, Any] = field(default_factory=dict)
    room_runtime: dict[str, Any] = field(default_factory=dict)
    task: asyncio.Task | None = None

    def broadcast(self, msg: dict[str, Any]) -> None:
        for conn in list(self.conns.values()):
            asyncio.create_task(_safe_send(conn.ws, msg))


class GameServer:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._rooms: dict[str, Room] = {}
        self._ws_to_room: dict[int, str] = {}

    async def handle_socket(self, ws: WebSocket) -> None:
        ws_id = id(ws)
        room: Room | None = None
        player_id: int | None = None
        try:
            while True:
                msg = await ws.receive_json()
                msg_type = msg.get("type")

                if msg_type == "hello":
                    await ws.send_json({"type": "welcome", "version": 1})
                    continue

                if msg_type == "join":
                    room, player_id = await self._handle_join(ws, msg)
                    continue

                if room is None or player_id is None or player_id < 0:
                    await ws.send_json({"type": "error", "code": "not_joined", "message": "Send join first."})
                    continue

                if msg_type == "ready":
                    await self._handle_ready(room, player_id, bool(msg.get("ready")))
                elif msg_type == "input":
                    await self._handle_input(room, player_id, msg)
                elif msg_type == "ping":
                    await self._handle_ping(room, player_id, msg)
                elif msg_type == "quick_chat":
                    await self._handle_quick_chat(room, player_id, msg)
                elif msg_type == "code_submit":
                    await self._handle_code_submit(room, player_id, msg)
                else:
                    await ws.send_json({"type": "error", "code": "bad_type", "message": f"Unknown type: {msg_type}"})
        except Exception:
            pass
        finally:
            await self._disconnect(ws_id, ws)

    async def _disconnect(self, ws_id: int, ws: WebSocket) -> None:
        async with self._lock:
            room_code = self._ws_to_room.pop(ws_id, None)
            if not room_code:
                return
            room = self._rooms.get(room_code)
            if not room:
                return
            for pid, conn in list(room.conns.items()):
                if conn.ws is ws:
                    room.conns.pop(pid, None)
                    room.players.pop(pid, None)
            room.messages.append({"t": room.tick, "kind": "system", "text": "A player disconnected."})
            if not room.conns:
                if room.task:
                    room.task.cancel()
                self._rooms.pop(room_code, None)
                return
            room.started = False
            for ps in room.players.values():
                ps.ready = False

    async def _handle_join(self, ws: WebSocket, msg: dict[str, Any]) -> tuple[Room, int]:
        async with self._lock:
            desired_code = (msg.get("room_code") or "").strip().upper()
            name = (msg.get("player_name") or "").strip()[:16]

            if desired_code:
                room = self._rooms.get(desired_code)
                if room is None:
                    room = self._create_room(desired_code)
                    self._rooms[desired_code] = room
            else:
                while True:
                    code = _gen_room_code()
                    if code not in self._rooms:
                        room = self._create_room(code)
                        self._rooms[code] = room
                        break

            if len(room.conns) >= 2:
                await ws.send_json({"type": "error", "code": "room_full", "message": "Room is full."})
                return room, -1

            player_id = 1 if 1 not in room.conns else 2
            role = "guardian" if player_id == 1 else "scholar"
            room.conns[player_id] = PlayerConn(ws=ws, player_id=player_id, role=role, name=name)

            spawn = self._spawn_for(room.room_index, role)
            room.players[player_id] = PlayerState(player_id=player_id, role=role, x=spawn[0], y=spawn[1])
            self._ws_to_room[id(ws)] = room.code

            if room.task is None or room.task.done():
                room.task = asyncio.create_task(self._room_loop(room))

            players_payload = [
                {"player_id": ps.player_id, "role": ps.role, "ready": ps.ready} for ps in room.players.values()
            ]
            await ws.send_json(
                {"type": "joined", "room_code": room.code, "player_id": player_id, "role": role, "players": players_payload}
            )
            room.broadcast({"type": "event", "name": "roster", "data": {"players": players_payload}})
            room.messages.append({"t": room.tick, "kind": "system", "text": "A player joined."})
            return room, player_id

    def _create_room(self, code: str) -> Room:
        seed = sum(ord(c) for c in code) * 1337
        rng = random.Random(seed)
        escape_code = "".join(rng.choice(ROOM_CODE_ALPHABET) for _ in range(10))
        fragments = [{"frag": escape_code[i : i + 2]} for i in range(0, 10, 2)]
        rng.shuffle(fragments)
        hint_orders = [1, 3, 2, 5, 4]  # per room index 0..4
        for i, f in enumerate(fragments):
            f["hint"] = hint_orders[i]
        room_static, room_runtime = build_room(0, fragments[0])
        return Room(
            code=code,
            created_at=time.time(),
            rng_seed=seed,
            escape_code=escape_code,
            code_fragments=fragments,
            room_static=room_static,
            room_runtime=room_runtime,
        )

    def _spawn_for(self, room_index: int, role: str) -> tuple[float, float]:
        base_x = 90.0
        base_y = 130.0 if role == "guardian" else 210.0
        return base_x, base_y

    async def _handle_ready(self, room: Room, player_id: int, ready: bool) -> None:
        ps = room.players.get(player_id)
        if not ps:
            return
        ps.ready = ready
        if len(room.players) == 2 and all(p.ready for p in room.players.values()):
            room.started = True
            reset_room_runtime_state(room)
            room.messages.append({"t": room.tick, "kind": "system", "text": "Game started."})

    async def _handle_input(self, room: Room, player_id: int, msg: dict[str, Any]) -> None:
        conn = room.conns.get(player_id)
        if not conn:
            return
        try:
            seq = int(msg.get("seq", 0))
        except Exception:
            seq = 0
        conn.last_seq = max(conn.last_seq, seq)
        mx = float(msg.get("move_x", 0.0))
        my = float(msg.get("move_y", 0.0))
        mx, my = normalize(mx, my)
        conn.move_x, conn.move_y = mx, my
        conn.interact_held = bool(msg.get("interact", False))

    async def _handle_ping(self, room: Room, player_id: int, msg: dict[str, Any]) -> None:
        room.messages.append(
            {
                "t": room.tick,
                "kind": "ping",
                "x": float(msg.get("x", 0.0)),
                "y": float(msg.get("y", 0.0)),
                "text": (msg.get("label") or "PING")[:12],
            }
        )

    async def _handle_quick_chat(self, room: Room, player_id: int, msg: dict[str, Any]) -> None:
        preset_id = (msg.get("preset_id") or "")[:32]
        room.messages.append({"t": room.tick, "kind": "chat", "player_id": player_id, "text": preset_id})

    async def _handle_code_submit(self, room: Room, player_id: int, msg: dict[str, Any]) -> None:
        code = (msg.get("code") or "").strip().upper()[:20]
        if room.room_index != (ROOM_COUNT - 1):
            room.messages.append({"t": room.tick, "kind": "system", "text": "Not at the final gate yet."})
            return

        puzzle = room.room_runtime.get("puzzle", {})
        if not puzzle.get("plates_ok"):
            room.messages.append({"t": room.tick, "kind": "system", "text": "Both plates must be held."})
            return
        if not puzzle.get("panel_active"):
            room.messages.append({"t": room.tick, "kind": "system", "text": "Interact with the panel first."})
            return

        ok = code == room.escape_code
        if ok:
            room.room_runtime["final_unlocked"] = True
            room.messages.append({"t": room.tick, "kind": "system", "text": "Final code accepted!"})
        else:
            room.messages.append({"t": room.tick, "kind": "system", "text": "Wrong code."})

    async def _room_loop(self, room: Room) -> None:
        next_time = time.perf_counter()
        while True:
            next_time += DT
            room.tick += 1
            if room.started:
                self._simulate(room, DT)
                await self._broadcast_state(room)
            await asyncio.sleep(max(0.0, next_time - time.perf_counter()))

    def _simulate(self, room: Room, dt: float) -> None:
        # movement
        door_open = bool(room.room_runtime.get("door_open", False))
        for pid, ps in list(room.players.items()):
            conn = room.conns.get(pid)
            if not conn or ps.down:
                continue
            speed = 135.0 if ps.role == "guardian" else 165.0
            ps.x += conn.move_x * speed * dt
            ps.y += conn.move_y * speed * dt
            ps.x = clamp(ps.x, 20.0, 940.0)
            ps.y = clamp(ps.y, 20.0, 520.0)
            if not door_open:
                ps.x = min(ps.x, 871.0)

        room_tick(room, dt)

        self._maybe_award_fragment(room)

        # interactions (including grab mechanics)
        for pid, conn in list(room.conns.items()):
            ps = room.players.get(pid)
            if not ps or ps.down:
                continue
            if conn.interact_held:
                room_apply_interact(room, pid)

        self._simulate_revive(room, dt)

        if room.players and all(p.down for p in room.players.values()):
            reset_room_runtime_state(room)
            room.messages.append({"t": room.tick, "kind": "system", "text": "Room reset."})

        exit_zone = room.room_static.get("exit_zone")
        if exit_zone and room.room_runtime.get("door_open"):
            if all(
                exit_zone["x"] <= ps.x <= exit_zone["x"] + exit_zone["w"]
                and exit_zone["y"] <= ps.y <= exit_zone["y"] + exit_zone["h"]
                for ps in room.players.values()
            ):
                self._advance_room(room)

    def _maybe_award_fragment(self, room: Room) -> None:
        if room.room_runtime.get("fragment_awarded", False):
            return
        if room.room_index >= len(room.code_fragments):
            return

        should_award = False
        if room.room_index < (ROOM_COUNT - 1):
            should_award = bool(room.room_runtime.get("door_open", False))
        else:
            # Final room: award after "phase 1" (both plates held + panel activated),
            # so the last shard is available before entering the final code.
            pz = room.room_runtime.get("puzzle", {})
            should_award = bool(pz.get("plates_ok")) and bool(pz.get("panel_active"))

        if not should_award:
            return

        room.room_runtime["fragment_awarded"] = True
        frag = room.code_fragments[room.room_index]
        room.messages.append(
            {"t": room.tick, "kind": "system", "text": f"Code fragment found: {frag['frag']} (hint {frag['hint']})"}
        )

    def _simulate_revive(self, room: Room, dt: float) -> None:
        if len(room.players) != 2:
            return
        p1 = room.players.get(1)
        p2 = room.players.get(2)
        if not p1 or not p2:
            return
        for down, other, other_conn in ((p1, p2, room.conns.get(2)), (p2, p1, room.conns.get(1))):
            if not down.down:
                down.revive_progress = 0.0
                continue
            if other.down or not other_conn or not other_conn.interact_held:
                down.revive_progress = 0.0
                continue
            if dist2(down.x, down.y, other.x, other.y) > 45.0 * 45.0:
                down.revive_progress = 0.0
                continue
            down.revive_progress += dt
            if down.revive_progress >= 3.5:
                down.down = False
                down.hp = 2
                down.revive_progress = 0.0
                room.messages.append({"t": room.tick, "kind": "system", "text": f"Player {down.player_id} revived."})

    def _advance_room(self, room: Room) -> None:
        if room.room_index >= ROOM_COUNT - 1:
            return

        room.room_index += 1
        frag = room.code_fragments[room.room_index]
        room.room_static, room.room_runtime = build_room(room.room_index, frag)
        for ps in room.players.values():
            ps.x, ps.y = self._spawn_for(room.room_index, ps.role)
            ps.hp = 3
            ps.down = False
            ps.revive_progress = 0.0
            ps.damage_cd.clear()

    async def _broadcast_state(self, room: Room) -> None:
        room.messages = room.messages[-25:]

        players = [
            {
                "player_id": ps.player_id,
                "role": ps.role,
                "x": ps.x,
                "y": ps.y,
                "hp": ps.hp,
                "down": ps.down,
                "revive_progress": ps.revive_progress,
                "ready": ps.ready,
            }
            for ps in room.players.values()
        ]

        base = {
            "type": "state",
            "tick": room.tick,
            "room_index": room.room_index,
            "players": players,
            "entities": room.room_runtime.get("entities", []),
            "messages": room.messages,
        }

        for pid, conn in list(room.conns.items()):
            ui = self._build_ui_for(room, conn.role)
            msg = dict(base)
            msg["ui"] = ui
            await _safe_send(conn.ws, msg)

    def _build_ui_for(self, room: Room, role: str) -> dict[str, Any]:
        # Hide fragment text until awarded to preserve the "code shards" feel.
        fragments_ui: list[dict[str, Any]] = []
        for idx, f in enumerate(room.code_fragments):
            awarded = (idx < room.room_index) or (
                idx == room.room_index and room.room_runtime.get("fragment_awarded", False)
            )
            fragments_ui.append({"hint": f["hint"], "awarded": awarded, "frag": (f["frag"] if awarded else None)})

        ui: dict[str, Any] = {
            "room_count": ROOM_COUNT,
            "fragments": fragments_ui,
            "final_unlocked": bool(room.room_runtime.get("final_unlocked", False)),
            "can_submit": False,
            "private_hint": "",
        }

        # Role-specific puzzle hints (only after the scholar reads signs).
        if room.room_index == 1:
            pz = room.room_runtime.get("puzzle", {})
            if role == "scholar" and pz.get("mural_read"):
                target = pz.get("target", [])
                map_state = {0: "L", 1: "M", 2: "R"}
                ui["private_hint"] = "Levers target: " + "-".join(map_state.get(int(v), "?") for v in target)
        if room.room_index == 3:
            pz = room.room_runtime.get("puzzle", {})
            if role == "scholar" and pz.get("order_revealed"):
                order = pz.get("order", [])
                ui["private_hint"] = "Valves order: " + "-".join(v.replace("v", "") for v in order)

        if room.room_index == 4:
            pz = room.room_runtime.get("puzzle", {})
            ui["can_submit"] = bool(pz.get("plates_ok")) and bool(pz.get("panel_active"))

        return ui
