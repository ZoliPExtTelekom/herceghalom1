const statusEl = document.getElementById("status");
const roomLabelEl = document.getElementById("roomLabel");
const roleLabelEl = document.getElementById("roleLabel");

const roomCodeInput = document.getElementById("roomCode");
const playerNameInput = document.getElementById("playerName");

const connectBtn = document.getElementById("connect");
const readyBtn = document.getElementById("ready");

const fragmentsEl = document.getElementById("fragments");
const finalCodeInput = document.getElementById("finalCode");
const submitCodeBtn = document.getElementById("submitCode");

const messagesEl = document.getElementById("messages");

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

let ws = null;
let joined = false;
let roomCode = null;
let playerId = null;
let role = null;
let ready = false;

let inputSeq = 0;
let lastState = null;

const keys = new Set();
let interactHeld = false;

const QUICK_CHAT_LABELS = {
  WAIT: "Wait!",
  ON_PLATE: "On plate",
  PULL_LEVER: "Pull lever",
  GO: "Go!",
  OK: "OK",
  HELP: "Help!",
};

function setStatus(text) {
  statusEl.textContent = text;
}

function setRoomAndRole() {
  roomLabelEl.textContent = `Room: ${roomCode ?? "-"}`;
  roleLabelEl.textContent = `Role: ${role ?? "-"}`;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(wsUrl());
  setStatus("Connecting...");
  joined = false;
  roomCode = null;
  playerId = null;
  role = null;
  ready = false;
  readyBtn.disabled = true;
  submitCodeBtn.disabled = true;
  setRoomAndRole();

  ws.addEventListener("open", () => {
    setStatus("Connected");
    send({ type: "hello", version: 1 });
    send({
      type: "join",
      room_code: roomCodeInput.value.trim().toUpperCase(),
      player_name: playerNameInput.value.trim(),
    });
  });

  ws.addEventListener("close", () => {
    setStatus("Disconnected");
    joined = false;
    readyBtn.disabled = true;
    submitCodeBtn.disabled = true;
  });

  ws.addEventListener("error", () => setStatus("Error"));

  ws.addEventListener("message", (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    onMessage(msg);
  });
}

function onMessage(msg) {
  if (msg.type === "welcome") return;

  if (msg.type === "error") {
    setStatus(`Error: ${msg.message}`);
    return;
  }

  if (msg.type === "joined") {
    joined = true;
    roomCode = msg.room_code;
    playerId = msg.player_id;
    role = msg.role;
    setRoomAndRole();
    readyBtn.disabled = false;
    submitCodeBtn.disabled = false;
    setStatus("Joined");
    return;
  }

  if (msg.type === "state") {
    lastState = msg;
    updateHud(msg);
    return;
  }
}

function updateHud(state) {
  // fragments
  fragmentsEl.textContent = "";
  const frags = state.ui?.fragments ?? [];
  for (const f of frags) {
    const div = document.createElement("div");
    div.className = `frag ${f.awarded ? "" : "off"}`;
    const fragText = f.awarded && f.frag ? f.frag : "??";
    div.textContent = `[${f.hint}] ${fragText}`;
    fragmentsEl.appendChild(div);
  }

  // messages
  messagesEl.textContent = "";
  if (state.ui?.private_hint) {
    const line = document.createElement("div");
    line.className = "msg";
    line.textContent = `(Hint) ${state.ui.private_hint}`;
    messagesEl.appendChild(line);
  }
  for (const m of state.messages ?? []) {
    const line = document.createElement("div");
    line.className = "msg";
    if (m.kind === "chat") {
      const who = m.player_id === playerId ? "You" : `P${m.player_id}`;
      line.textContent = `${who}: ${QUICK_CHAT_LABELS[m.text] ?? m.text}`;
    } else if (m.kind === "ping") {
      line.textContent = `Ping: ${m.text ?? "PING"}`;
    } else {
      line.textContent = m.text ?? "";
    }
    messagesEl.appendChild(line);
  }

  // enable submit only in final room
  submitCodeBtn.disabled = !(state.ui?.can_submit ?? false);
}

function computeMove() {
  let x = 0;
  let y = 0;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1;
  if (keys.has("KeyW") || keys.has("ArrowUp")) y -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) y += 1;
  const mag = Math.hypot(x, y);
  if (mag > 1e-6) {
    x /= mag;
    y /= mag;
  }
  return { x, y };
}

function sendInputLoop() {
  if (joined) {
    const mv = computeMove();
    send({
      type: "input",
      seq: inputSeq++,
      move_x: mv.x,
      move_y: mv.y,
      interact: interactHeld,
    });
  }
  setTimeout(sendInputLoop, 50);
}

function worldPosFromCanvasEvent(evt) {
  const rect = canvas.getBoundingClientRect();
  const x = ((evt.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((evt.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // background
  ctx.fillStyle = "#121a23";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!lastState) {
    ctx.fillStyle = "#e6edf3";
    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.fillText("Connect + Ready with 2 players.", 24, 40);
    requestAnimationFrame(draw);
    return;
  }

  // entities
  for (const e of lastState.entities ?? []) {
    drawEntity(e);
  }

  // players
  for (const p of lastState.players ?? []) {
    drawPlayer(p);
  }

  // room label
  ctx.fillStyle = "#e6edf3";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(`Room ${((lastState.room_index ?? 0) + 1)}/5`, 16, 18);

  requestAnimationFrame(draw);
}

function drawEntity(e) {
  const x = e.x ?? 0;
  const y = e.y ?? 0;
  const w = e.w ?? 0;
  const h = e.h ?? 0;

  if (e.type === "door") {
    ctx.fillStyle = e.open ? "#2ea043" : "#8b949e";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (e.type === "plate") {
    ctx.fillStyle = "#30363d";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#8b949e";
    ctx.strokeRect(x, y, w, h);
    return;
  }
  if (e.type === "spikes") {
    ctx.fillStyle = e.active ? "#f85149" : "#1f2a37";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (e.type === "mural" || e.type === "sign") {
    ctx.fillStyle = "#a371f7";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (e.type === "lever") {
    const state = e.state ?? 0;
    ctx.fillStyle = ["#58a6ff", "#d29922", "#2ea043"][state] ?? "#58a6ff";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (e.type === "block") {
    ctx.fillStyle = "#8b949e";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (e.type === "switch") {
    ctx.fillStyle = "#d29922";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (e.type === "valve") {
    ctx.fillStyle = "#58a6ff";
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (e.type === "water") {
    ctx.fillStyle = "rgba(56, 139, 253, 0.25)";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (e.type === "panel") {
    ctx.fillStyle = "#d29922";
    ctx.fillRect(x, y, w, h);
    return;
  }
}

function drawPlayer(p) {
  const isMe = p.player_id === playerId;
  const color =
    p.down ? "#30363d" : p.role === "guardian" ? "#58a6ff" : "#2ea043";
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
  ctx.fill();

  // outline
  ctx.strokeStyle = isMe ? "#f0f6fc" : "rgba(240,246,252,0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // hp text
  ctx.fillStyle = "#e6edf3";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(`P${p.player_id} ${p.hp}`, p.x - 14, p.y - 16);

  // revive progress
  if (p.down && p.revive_progress > 0) {
    const w = 30;
    const h = 4;
    const t = Math.max(0, Math.min(1, p.revive_progress / 3.5));
    ctx.fillStyle = "#30363d";
    ctx.fillRect(p.x - w / 2, p.y + 16, w, h);
    ctx.fillStyle = "#2ea043";
    ctx.fillRect(p.x - w / 2, p.y + 16, w * t, h);
  }
}

// UI events
connectBtn.addEventListener("click", connect);

readyBtn.addEventListener("click", () => {
  if (!joined) return;
  ready = !ready;
  readyBtn.textContent = ready ? "Unready" : "Ready";
  send({ type: "ready", ready });
});

submitCodeBtn.addEventListener("click", () => {
  const code = finalCodeInput.value.trim().toUpperCase();
  send({ type: "code_submit", code });
});

for (const btn of document.querySelectorAll("button.qc")) {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-qc");
    if (!id) return;
    send({ type: "quick_chat", preset_id: id });
  });
}

canvas.addEventListener("click", (evt) => {
  if (!joined) return;
  const pos = worldPosFromCanvasEvent(evt);
  send({ type: "ping", x: pos.x, y: pos.y, label: "PING" });
});

window.addEventListener("keydown", (evt) => {
  keys.add(evt.code);
  if (evt.code === "KeyE") interactHeld = true;
});
window.addEventListener("keyup", (evt) => {
  keys.delete(evt.code);
  if (evt.code === "KeyE") interactHeld = false;
});

// Start loops
sendInputLoop();
draw();
