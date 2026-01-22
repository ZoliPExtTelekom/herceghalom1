from __future__ import annotations

from typing import Any

from .util import clamp, dist2


ROOM_COUNT = 5


def build_room(room_index: int, fragment: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    static: dict[str, Any] = {
        "room_index": room_index,
        "exit_zone": {"x": 900, "y": 200, "w": 60, "h": 140},
    }

    runtime: dict[str, Any] = {
        "door_open": False,
        "fragment_awarded": False,
        "entities": [],
        "puzzle": {},
    }

    if room_index == 0:
        _room1(runtime)
    elif room_index == 1:
        _room2(runtime)
    elif room_index == 2:
        _room3(runtime)
    elif room_index == 3:
        _room4(runtime)
    elif room_index == 4:
        _room5(runtime)

    runtime["puzzle"]["fragment_hint"] = {"frag": fragment["frag"], "hint": fragment["hint"]}
    return static, runtime


def reset_room_runtime_state(room: Any) -> None:
    frag = room.code_fragments[room.room_index]
    room.room_static, room.room_runtime = build_room(room.room_index, frag)
    for ps in room.players.values():
        ps.hp = 3
        ps.down = False
        ps.revive_progress = 0.0
        ps.damage_cd.clear()


def room_apply_interact(room: Any, player_id: int) -> None:
    rt = room.room_runtime
    ps = room.players.get(player_id)
    if not ps:
        return

    def near(ent: dict[str, Any], r: float = 48.0) -> bool:
        cx = ent["x"] + ent.get("w", 0) / 2.0
        cy = ent["y"] + ent.get("h", 0) / 2.0
        return dist2(ps.x, ps.y, cx, cy) <= r * r

    if room.room_index == 1:
        mural = rt["puzzle"].get("mural")
        if mural and near(mural, 60.0) and ps.role == "scholar":
            rt["puzzle"]["mural_read"] = True
            room.messages.append({"t": room.tick, "kind": "system", "text": "Scholar read the mural."})
        for lever in rt["puzzle"].get("levers", []):
            if near(lever, 55.0) and ps.role == "guardian":
                lever["state"] = (lever["state"] + 1) % 3
                _room2_check(room)
                return

    if room.room_index == 2:
        block = rt["puzzle"].get("block")
        if block and ps.role == "guardian" and near(block, 55.0):
            rt["puzzle"]["block_grabbed_by"] = player_id
            return
        sw = rt["puzzle"].get("switch")
        if sw and ps.role == "scholar" and near(sw, 55.0):
            rt["puzzle"]["switch_on"] = True
            room.messages.append({"t": room.tick, "kind": "system", "text": "Switch activated."})
            _room3_check(room)
            return

    if room.room_index == 3:
        sign = rt["puzzle"].get("sign")
        if sign and ps.role == "scholar" and near(sign, 60.0):
            rt["puzzle"]["order_revealed"] = True
            room.messages.append({"t": room.tick, "kind": "system", "text": "Scholar read pipe markings."})
            return
        for valve in rt["puzzle"].get("valves", []):
            if near(valve, 60.0) and ps.role == "guardian":
                _room4_turn_valve(room, valve["id"])
                return

    if room.room_index == 4:
        panel = rt["puzzle"].get("panel")
        if panel and near(panel, 70.0):
            rt["puzzle"]["panel_active"] = True


def room_tick(room: Any, dt: float) -> None:
    idx = room.room_index
    if idx == 0:
        _room1_tick(room, dt)
    elif idx == 1:
        _room2_tick(room, dt)
    elif idx == 2:
        _room3_tick(room, dt)
    elif idx == 3:
        _room4_tick(room, dt)
    elif idx == 4:
        _room5_tick(room, dt)


def _damage(room: Any, ps: Any, amount: int, source: str, cooldown_s: float = 0.5) -> None:
    now = room.tick / 20.0
    last = ps.damage_cd.get(source, -999.0)
    if (now - last) < cooldown_s:
        return
    ps.damage_cd[source] = now
    if ps.down:
        return
    if ps.role == "guardian":
        amount = max(1, amount - 1)
    ps.hp -= amount
    if ps.hp <= 0:
        ps.hp = 0
        ps.down = True
        room.messages.append({"t": room.tick, "kind": "system", "text": f"Player {ps.player_id} is down!"})


def _sync_door_entity(rt: dict[str, Any]) -> None:
    for ent in rt.get("entities", []):
        if ent.get("type") == "door":
            ent["open"] = bool(rt.get("door_open", False))


def _player_in_rect(ps: Any, rect: dict[str, Any]) -> bool:
    return (
        rect["x"] <= ps.x <= rect["x"] + rect.get("w", 0)
        and rect["y"] <= ps.y <= rect["y"] + rect.get("h", 0)
    )


def _any_player_in_rect(room: Any, rect: dict[str, Any]) -> bool:
    return any(_player_in_rect(ps, rect) for ps in room.players.values())


def _rect_overlap(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return not (
        a["x"] + a.get("w", 0) < b["x"]
        or a["x"] > b["x"] + b.get("w", 0)
        or a["y"] + a.get("h", 0) < b["y"]
        or a["y"] > b["y"] + b.get("h", 0)
    )


def _room1(rt: dict[str, Any]) -> None:
    plate_a = {"id": "plate_a", "type": "plate", "x": 240, "y": 360, "w": 46, "h": 46}
    plate_b = {"id": "plate_b", "type": "plate", "x": 690, "y": 150, "w": 46, "h": 46}
    # Two spike columns that form a timed barrier between left (spawn/plate_a) and right (plate_b/exit).
    # Important: do NOT overlap plate_b, otherwise it can get visually obscured.
    spikes_l = {"id": "spikes_1_l", "type": "spikes", "x": 410, "y": 20, "w": 110, "h": 500}
    spikes_r = {"id": "spikes_1_r", "type": "spikes", "x": 560, "y": 20, "w": 110, "h": 500}
    rt["puzzle"] = {
        "plate_a": plate_a,
        "plate_b": plate_b,
        "spikes_l": spikes_l,
        "spikes_r": spikes_r,
        "hold_t": 0.0,
    }
    rt["entities"] = [
        plate_a,
        plate_b,
        spikes_l,
        spikes_r,
        {"type": "door", "x": 885, "y": 240, "w": 30, "h": 80},
    ]


def _room1_tick(room: Any, dt: float) -> None:
    rt = room.room_runtime
    plate_a = rt["puzzle"]["plate_a"]
    plate_b = rt["puzzle"]["plate_b"]
    spikes_l = rt["puzzle"]["spikes_l"]
    spikes_r = rt["puzzle"]["spikes_r"]

    # 2s cycle (20Hz -> 40 ticks). The two columns are phase-shifted to reduce trivial waiting.
    phase = (room.tick % 40) / 40.0
    # Active 70% / inactive 30% with an overlap window -> forces timing or tanking (Guardian advantage).
    spikes_l_active = phase < 0.7
    spikes_r_active = phase > 0.3
    spikes_l["active"] = spikes_l_active
    spikes_r["active"] = spikes_r_active

    a_on = _any_player_in_rect(room, plate_a)
    b_on = _any_player_in_rect(room, plate_b)
    if a_on and b_on:
        rt["puzzle"]["hold_t"] += dt
    else:
        rt["puzzle"]["hold_t"] = max(0.0, rt["puzzle"]["hold_t"] - dt * 2.0)

    for ps in room.players.values():
        if spikes_l_active and _player_in_rect(ps, spikes_l):
            _damage(room, ps, 1, "spikes_1_l", cooldown_s=0.28)
        if spikes_r_active and _player_in_rect(ps, spikes_r):
            _damage(room, ps, 1, "spikes_1_r", cooldown_s=0.28)

    if rt["puzzle"]["hold_t"] >= 0.8:
        rt["door_open"] = True
    _sync_door_entity(rt)


def _room2(rt: dict[str, Any]) -> None:
    mural = {"id": "mural", "type": "mural", "x": 180, "y": 110, "w": 60, "h": 80}
    levers = [
        {"id": "lever1", "type": "lever", "x": 520, "y": 110, "w": 30, "h": 60, "state": 0},
        {"id": "lever2", "type": "lever", "x": 590, "y": 110, "w": 30, "h": 60, "state": 0},
        {"id": "lever3", "type": "lever", "x": 660, "y": 110, "w": 30, "h": 60, "state": 0},
    ]
    target = [2, 0, 1]  # 0..2
    rt["puzzle"] = {
        "mural": mural,
        "mural_read": False,
        "levers": levers,
        "target": target,
        "solved": False,
    }
    rt["entities"] = [mural, *levers, {"type": "door", "x": 885, "y": 240, "w": 30, "h": 80}]


def _room2_tick(room: Any, dt: float) -> None:
    rt = room.room_runtime
    pz = rt["puzzle"]
    mural = pz.get("mural")
    if mural:
        mural["read"] = bool(pz.get("mural_read"))
    _sync_door_entity(rt)


def _room2_check(room: Any) -> None:
    rt = room.room_runtime
    levers = rt["puzzle"]["levers"]
    target = rt["puzzle"]["target"]
    current = [l["state"] for l in levers]
    if current == target:
        rt["puzzle"]["solved"] = True
        rt["door_open"] = True
        room.messages.append({"t": room.tick, "kind": "system", "text": "Levers solved!"})
    else:
        toggler = room.players.get(1)
        if toggler:
            _damage(room, toggler, 1, "arrow_room2", cooldown_s=0.5)


def _room3(rt: dict[str, Any]) -> None:
    block = {"id": "block", "type": "block", "x": 360, "y": 300, "w": 50, "h": 50}
    plate = {"id": "plate", "type": "plate", "x": 610, "y": 320, "w": 46, "h": 46}
    spikes = {"id": "spikes_3", "type": "spikes", "x": 520, "y": 210, "w": 220, "h": 80, "active": True}
    sw = {"id": "switch", "type": "switch", "x": 800, "y": 150, "w": 40, "h": 40}
    rt["puzzle"] = {
        "block": block,
        "plate": plate,
        "spikes": spikes,
        "switch": sw,
        "block_grabbed_by": None,
        "switch_on": False,
    }
    rt["entities"] = [block, plate, spikes, sw, {"type": "door", "x": 885, "y": 240, "w": 30, "h": 80}]


def _room3_tick(room: Any, dt: float) -> None:
    rt = room.room_runtime
    pz = rt["puzzle"]
    block = pz["block"]
    plate = pz["plate"]
    spikes = pz["spikes"]
    sw = pz.get("switch")

    grabber_id = pz.get("block_grabbed_by")
    if grabber_id == 1:
        conn = room.conns.get(1)
        if conn and conn.interact_held:
            block["x"] += conn.move_x * 120.0 * dt
            block["y"] += conn.move_y * 120.0 * dt
            block["x"] = clamp(block["x"], 80.0, 860.0)
            block["y"] = clamp(block["y"], 80.0, 460.0)
        else:
            pz["block_grabbed_by"] = None
    else:
        pz["block_grabbed_by"] = None

    on_plate = _rect_overlap(block, plate)
    spikes["active"] = not on_plate
    if spikes["active"]:
        for ps in room.players.values():
            if _player_in_rect(ps, spikes):
                _damage(room, ps, 1, "spikes_3", cooldown_s=0.35)

    _room3_check(room)
    if sw:
        sw["on"] = bool(pz.get("switch_on"))
    block["grabbed"] = bool(pz.get("block_grabbed_by"))
    _sync_door_entity(rt)


def _room3_check(room: Any) -> None:
    rt = room.room_runtime
    pz = rt["puzzle"]
    if pz.get("switch_on") and not pz.get("spikes", {}).get("active", True):
        rt["door_open"] = True


def _room4(rt: dict[str, Any]) -> None:
    sign = {"id": "sign", "type": "sign", "x": 160, "y": 110, "w": 60, "h": 80}
    valves = [
        {"id": "v1", "type": "valve", "x": 450, "y": 200, "w": 46, "h": 46},
        {"id": "v2", "type": "valve", "x": 550, "y": 200, "w": 46, "h": 46},
        {"id": "v3", "type": "valve", "x": 650, "y": 200, "w": 46, "h": 46},
    ]
    order = ["v2", "v1", "v3"]
    rt["puzzle"] = {
        "sign": sign,
        "valves": valves,
        "order": order,
        "order_revealed": False,
        "step": 0,
        "water": 0.0,
        "solved": False,
    }
    rt["entities"] = [
        sign,
        *valves,
        {"type": "water", "x": 0, "y": 380, "w": 960, "h": 0},
        {"type": "door", "x": 885, "y": 240, "w": 30, "h": 80},
    ]


def _room4_tick(room: Any, dt: float) -> None:
    rt = room.room_runtime
    pz = rt["puzzle"]
    sign = pz.get("sign")
    if sign:
        sign["read"] = bool(pz.get("order_revealed"))

    pz["water"] = max(0.0, pz["water"] - dt * 0.05)
    water_h = int(160 * pz["water"])
    for ent in rt["entities"]:
        if ent.get("type") == "water":
            ent["h"] = water_h
            ent["y"] = 540 - water_h

    if pz["water"] > 0.65 and water_h > 0:
        water_zone = {"x": 0, "y": 540 - water_h, "w": 960, "h": water_h}
        for ps in room.players.values():
            if _player_in_rect(ps, water_zone):
                _damage(room, ps, 1, "water_room4", cooldown_s=0.6)

    if pz.get("solved"):
        rt["door_open"] = True

    _sync_door_entity(rt)


def _room4_turn_valve(room: Any, valve_id: str) -> None:
    rt = room.room_runtime
    pz = rt["puzzle"]
    if pz.get("solved"):
        return
    step = int(pz.get("step", 0))
    order = pz.get("order", [])
    if step < len(order) and valve_id == order[step]:
        pz["step"] = step + 1
        room.messages.append({"t": room.tick, "kind": "system", "text": f"Valve OK ({step+1}/3)."})
        if pz["step"] >= len(order):
            pz["solved"] = True
            room.messages.append({"t": room.tick, "kind": "system", "text": "Valves solved!"})
    else:
        pz["water"] = min(1.0, pz["water"] + 0.25)
        pz["step"] = 0
        room.messages.append({"t": room.tick, "kind": "system", "text": "Wrong valve! Water rises."})


def _room5(rt: dict[str, Any]) -> None:
    plate_l = {"id": "plate_l", "type": "plate", "x": 300, "y": 360, "w": 46, "h": 46}
    plate_r = {"id": "plate_r", "type": "plate", "x": 600, "y": 360, "w": 46, "h": 46}
    panel = {"id": "panel", "type": "panel", "x": 450, "y": 180, "w": 60, "h": 60}
    spikes = {"id": "spikes_5", "type": "spikes", "x": 420, "y": 240, "w": 120, "h": 80}
    rt["puzzle"] = {
        "plate_l": plate_l,
        "plate_r": plate_r,
        "panel": panel,
        "panel_active": False,
        "spikes": spikes,
        "plates_ok": False,
    }
    rt["entities"] = [plate_l, plate_r, panel, spikes, {"type": "door", "x": 885, "y": 240, "w": 30, "h": 80}]


def _room5_tick(room: Any, dt: float) -> None:
    rt = room.room_runtime
    pz = rt["puzzle"]
    spikes = pz["spikes"]
    panel = pz.get("panel")

    phase = (room.tick % 30) / 30.0
    spikes["active"] = phase < 0.4
    if spikes["active"]:
        for ps in room.players.values():
            if _player_in_rect(ps, spikes):
                _damage(room, ps, 1, "spikes_5", cooldown_s=0.35)

    plates_ok = _any_player_in_rect(room, pz["plate_l"]) and _any_player_in_rect(room, pz["plate_r"])
    pz["plates_ok"] = plates_ok
    if panel:
        panel["active"] = bool(pz.get("panel_active"))

    if plates_ok and rt.get("final_unlocked"):
        rt["door_open"] = True

    _sync_door_entity(rt)
