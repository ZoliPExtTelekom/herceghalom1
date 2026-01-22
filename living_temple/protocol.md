# The Living Temple (2-player) - Protocol (MVP)

This repo contains:
- `server/`: Python WebSocket game server (authoritative state)
- `client/`: Browser client (HTML/JS Canvas)
- `shared/`: Shared protocol/schema definitions

## Transport
- WebSocket
- Payloads: JSON objects with a `type` field

## Concepts
- Room code: short code to join a 2-player session
- Server authoritative: client sends inputs, server simulates and broadcasts state
- Tick rate: 20 Hz (state snapshots)

## Client -> Server messages (planned)
- `hello`: `{ type: "hello", version: 1 }`
- `join`: `{ type: "join", room_code?: string, player_name?: string }`
- `ready`: `{ type: "ready", ready: boolean }`
- `input`: `{ type: "input", seq: number, move_x: number, move_y: number, interact?: boolean }`
- `ping`: `{ type: "ping", x: number, y: number, label?: string }`
- `quick_chat`: `{ type: "quick_chat", preset_id: string }`
- `code_submit`: `{ type: "code_submit", code: string }`

## Server -> Client messages (planned)
- `welcome`: `{ type: "welcome", version: 1 }`
- `joined`: `{ type: "joined", room_code, player_id, role, players }`
- `state`: `{ type: "state", tick, room_index, players, entities, ui, messages }`
- `event`: `{ type: "event", name, data }`
- `error`: `{ type: "error", code, message }`

Exact schemas live in `shared/schema.json`.
