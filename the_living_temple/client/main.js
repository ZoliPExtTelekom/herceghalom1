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
const youRoleEl = document.getElementById("youRole");
const rosterEl = document.getElementById("roster");

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

const QUICK_CHAT_BUBBLES = {
  WAIT: "WAIT!",
  ON_PLATE: "STEP ON\nTHE PLATE!",
  PULL_LEVER: "PULL THE\nLEVER!",
  GO: "GO!",
  OK: "I'M READY!",
  HELP: "HELP!",
};

const ROOM_TITLES = [
  "Double Pressure Plates",
  "Hidden Code Puzzle",
  "Pillar Pushing Challenge",
  "Flood Valve Sequence",
  "Final Code Panel",
];

const ROLE_META = {
  guardian: { name: "Guardian", color: "#58a6ff", desc: "Strong: pushes block, resists traps." },
  scholar: { name: "Scholar", color: "#2ea043", desc: "Agile: reads clues, activates switches." },
};

// Render caches (procedural "pixel-dungeon" look)
const renderCache = {
  patterns: new Map(), // key: `${roomIndex}` -> { floorPattern, wallPattern }
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
  // role card
  if (role && ROLE_META[role]) {
    const meta = ROLE_META[role];
    youRoleEl.innerHTML = `
      <div class="roleDot" style="background:${meta.color}"></div>
      <div>
        <div class="roleName">You are ${meta.name}</div>
        <div class="roleDesc">${meta.desc}</div>
      </div>
    `;
  } else {
    youRoleEl.textContent = "You: -";
  }

  // roster
  rosterEl.textContent = "";
  for (const p of state.players ?? []) {
    const meta = ROLE_META[p.role] ?? { name: p.role ?? "?", color: "#8b949e" };
    const div = document.createElement("div");
    div.className = "rosterItem";
    const left = document.createElement("div");
    left.textContent = `P${p.player_id} - ${meta.name}${p.player_id === playerId ? " (you)" : ""}`;
    const right = document.createElement("div");
    right.className = `badge ${p.ready ? "badgeReady" : "badgeNotReady"}`;
    right.textContent = p.ready ? "READY" : "NOT READY";
    div.appendChild(left);
    div.appendChild(right);
    rosterEl.appendChild(div);
  }

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

  if (!lastState) {
    ctx.fillStyle = "#121a23";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#e6edf3";
    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.fillText("Connect + Ready with 2 players.", 24, 40);
    requestAnimationFrame(draw);
    return;
  }

  const roomIndex = lastState.room_index ?? 0;
  drawDungeonScene(roomIndex);

  // entities
  for (const e of lastState.entities ?? []) {
    drawEntity(e);
  }

  drawInteractionHints();

  // pings (draw before players so players can stand on them)
  drawPings();

  // players
  for (const p of lastState.players ?? []) {
    drawPlayer(p);
  }

  // room label
  drawRoomBanner(roomIndex);
  drawSpeechBubbles();
  drawVignette();

  requestAnimationFrame(draw);
}

function drawDungeonScene(roomIndex) {
  const patterns = getRoomPatterns(roomIndex);

  // floor
  ctx.fillStyle = patterns.floorPattern;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // carve a "room" area with darker border like stone walls
  drawWallsAndTrim(roomIndex, patterns.wallPattern);

  // torches + warm lighting
  drawTorches(roomIndex);

  // subtle room-specific decals
  drawDecals(roomIndex);
}

function getRoomPatterns(roomIndex) {
  const key = `${roomIndex}`;
  if (renderCache.patterns.has(key)) return renderCache.patterns.get(key);

  const seed = 1337 + roomIndex * 7919;
  const floorPattern = makeStoneFloorPattern(seed);
  const wallPattern = makeWallPattern(seed + 17);
  const entry = { floorPattern, wallPattern };
  renderCache.patterns.set(key, entry);
  return entry;
}

function makeStoneFloorPattern(seed) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");

  // base stone
  g.fillStyle = "#9b845c";
  g.fillRect(0, 0, c.width, c.height);

  // tiles
  const tile = 16;
  for (let y = 0; y < c.height; y += tile) {
    for (let x = 0; x < c.width; x += tile) {
      const n = hash01(seed, x, y);
      const base = n > 0.5 ? "#b79a6a" : "#a7895f";
      g.fillStyle = base;
      g.fillRect(x, y, tile, tile);

      // crack / speckle
      g.globalAlpha = 0.22;
      g.fillStyle = "#6b5b3c";
      const sx = x + 2 + Math.floor(hash01(seed + 3, x, y) * 10);
      const sy = y + 2 + Math.floor(hash01(seed + 5, x, y) * 10);
      g.fillRect(sx, sy, 2, 1);
      g.globalAlpha = 1;
    }
  }

  // grout lines
  g.strokeStyle = "rgba(30,24,16,0.35)";
  g.lineWidth = 1;
  for (let i = 0; i <= 64; i += tile) {
    g.beginPath();
    g.moveTo(i + 0.5, 0);
    g.lineTo(i + 0.5, 64);
    g.stroke();
    g.beginPath();
    g.moveTo(0, i + 0.5);
    g.lineTo(64, i + 0.5);
    g.stroke();
  }

  return ctx.createPattern(c, "repeat");
}

function makeWallPattern(seed) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");

  g.fillStyle = "#5b4a2f";
  g.fillRect(0, 0, 64, 64);

  // brick blocks
  const bh = 10;
  for (let y = 0; y < 64; y += bh) {
    const offset = (y / bh) % 2 === 0 ? 0 : 10;
    for (let x = -offset; x < 64; x += 20) {
      const n = hash01(seed, x, y);
      g.fillStyle = n > 0.5 ? "#6a5736" : "#4f4028";
      g.fillRect(x, y, 18, bh - 1);
    }
  }

  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.strokeRect(0.5, 0.5, 63, 63);
  return ctx.createPattern(c, "repeat");
}

function drawWallsAndTrim(roomIndex, wallPattern) {
  // outer walls
  ctx.save();
  ctx.fillStyle = wallPattern;
  ctx.fillRect(0, 0, canvas.width, 36);
  ctx.fillRect(0, canvas.height - 36, canvas.width, 36);
  ctx.fillRect(0, 0, 36, canvas.height);
  ctx.fillRect(canvas.width - 36, 0, 36, canvas.height);
  ctx.restore();

  // room-specific interior walls (purely visual, matches reference vibe)
  const walls = getInteriorWalls(roomIndex);
  ctx.save();
  ctx.fillStyle = wallPattern;
  for (const r of walls) ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();

  // trim shadow
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#000";
  ctx.fillRect(36, 36, canvas.width - 72, 6);
  ctx.fillRect(36, canvas.height - 42, canvas.width - 72, 6);
  ctx.fillRect(36, 36, 6, canvas.height - 72);
  ctx.fillRect(canvas.width - 42, 36, 6, canvas.height - 72);
  ctx.restore();
}

function getInteriorWalls(roomIndex) {
  if (roomIndex === 0) {
    return [
      { x: 420, y: 36, w: 36, h: 120 },
      { x: 420, y: 240, w: 36, h: 264 },
    ];
  }
  if (roomIndex === 1) {
    return [{ x: 360, y: 220, w: 220, h: 36 }];
  }
  if (roomIndex === 2) {
    return [{ x: 720, y: 36, w: 36, h: 170 }];
  }
  if (roomIndex === 3) {
    return [{ x: 260, y: 360, w: 420, h: 36 }];
  }
  if (roomIndex === 4) {
    return [
      { x: 36, y: 160, w: 220, h: 36 },
      { x: 704, y: 160, w: 220, h: 36 },
    ];
  }
  return [];
}

function drawTorches(roomIndex) {
  const t = (performance.now() / 1000) % 1000;
  const positions = [
    { x: 64, y: 64 },
    { x: canvas.width - 64, y: 64 },
    { x: 64, y: canvas.height - 64 },
    { x: canvas.width - 64, y: canvas.height - 64 },
  ];
  // add a couple of room-specific torches like the reference panels
  if (roomIndex === 0) positions.push({ x: 480, y: 72 }, { x: 720, y: 72 });
  if (roomIndex === 1) positions.push({ x: 620, y: 72 }, { x: 820, y: 72 });
  if (roomIndex === 4) positions.push({ x: 480, y: 72 }, { x: 860, y: 260 });

  for (const p of positions) {
    drawTorch(p.x, p.y, t, roomIndex);
  }
}

function drawTorch(x, y, t, roomIndex) {
  const flick = 0.8 + 0.2 * Math.sin(t * 9 + x * 0.01 + roomIndex);
  const r = 120 * flick;

  // warm light
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(x, y, 6, x, y, r);
  g.addColorStop(0, "rgba(255, 204, 120, 0.45)");
  g.addColorStop(0.4, "rgba(255, 140, 50, 0.18)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // torch sprite (simple pixel-ish)
  ctx.save();
  ctx.fillStyle = "#2b2116";
  ctx.fillRect(x - 4, y + 6, 8, 18);
  ctx.fillStyle = "#1f6feb";
  ctx.globalAlpha = 0.0; // no blue, keep palette warm (placeholder for future)
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "#3b2b1b";
  ctx.fillRect(x - 6, y + 2, 12, 6);
  ctx.restore();

  const flameH = 10 + 4 * Math.sin(t * 12 + x * 0.02);
  ctx.save();
  ctx.fillStyle = "#ffb86b";
  ctx.beginPath();
  ctx.moveTo(x, y - flameH);
  ctx.quadraticCurveTo(x + 10, y - 2, x, y + 2);
  ctx.quadraticCurveTo(x - 10, y - 2, x, y - flameH);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = "#ff6a2b";
  ctx.beginPath();
  ctx.moveTo(x, y - flameH * 0.7);
  ctx.quadraticCurveTo(x + 6, y - 1, x, y + 1);
  ctx.quadraticCurveTo(x - 6, y - 1, x, y - flameH * 0.7);
  ctx.fill();
  ctx.restore();
}

function drawDecals(roomIndex) {
  ctx.save();
  ctx.globalAlpha = 0.2;
  if (roomIndex === 1) {
    // rune strip under mural area
    ctx.fillStyle = "#ffd479";
    for (let i = 0; i < 7; i++) ctx.fillRect(320 + i * 22, 90, 10, 3);
  } else if (roomIndex === 4) {
    // big rune circle at center
    ctx.strokeStyle = "#ffd479";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(480, 270, 90, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRoomBanner(roomIndex) {
  const title = ROOM_TITLES[roomIndex] ?? `Room ${roomIndex + 1}`;
  const w = Math.min(520, 24 + title.length * 10);
  const x = (canvas.width - w) / 2;
  const y = 10;
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "#2b2116";
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  roundedRectPath(ctx, x, y, w, 30, 10);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#e6edf3";
  ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, canvas.width / 2, y + 15);
  ctx.restore();
}

function hash01(seed, x, y) {
  // tiny integer hash -> [0,1)
  let n = seed ^ (x * 374761393) ^ (y * 668265263);
  n = (n ^ (n >> 13)) >>> 0;
  n = (n * 1274126177) >>> 0;
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
}

function drawVignette() {
  const g = ctx.createRadialGradient(
    canvas.width / 2,
    canvas.height / 2,
    200,
    canvas.width / 2,
    canvas.height / 2,
    520
  );
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawPings() {
  const tick = lastState.tick ?? 0;
  const msgs = lastState.messages ?? [];
  for (const m of msgs) {
    if (m.kind !== "ping") continue;
    const age = (tick - (m.t ?? tick)) / 20;
    if (age < 0 || age > 2.0) continue;
    const alpha = 1.0 - age / 2.0;
    const x = m.x ?? 0;
    const y = m.y ?? 0;
    ctx.save();
    ctx.globalAlpha = 0.55 * alpha;
    ctx.strokeStyle = "#f0f6fc";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 14 + age * 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.9 * alpha;
    ctx.fillStyle = "#f0f6fc";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.fillText(m.text ?? "PING", x + 10, y - 10);
    ctx.restore();
  }
}

function drawEntity(e) {
  const x = e.x ?? 0;
  const y = e.y ?? 0;
  const w = e.w ?? 0;
  const h = e.h ?? 0;

  if (e.type === "door") {
    // stone arch
    ctx.save();
    ctx.fillStyle = "#30363d";
    ctx.fillRect(x - 6, y - 10, w + 12, h + 20);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(x, y, w, h);
    if (e.open) {
      const g = ctx.createLinearGradient(x, y, x + w, y);
      g.addColorStop(0, "rgba(46,160,67,0.0)");
      g.addColorStop(0.5, "rgba(46,160,67,0.35)");
      g.addColorStop(1, "rgba(46,160,67,0.0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.strokeStyle = "#8b949e";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
    return;
  }
  if (e.type === "plate") {
    const pressed = isPlatePressed(e);
    ctx.save();
    ctx.fillStyle = pressed ? "#1f2a37" : "#30363d";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#8b949e";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    ctx.globalAlpha = pressed ? 0.6 : 0.25;
    ctx.strokeStyle = "#d29922";
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (e.type === "spikes") {
    ctx.save();
    ctx.fillStyle = e.active ? "#3a1b1b" : "#131b24";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = e.active ? "#f85149" : "#30363d";
    const teeth = Math.max(3, Math.floor(w / 18));
    for (let i = 0; i < teeth; i++) {
      const tx = x + (i * w) / teeth;
      ctx.beginPath();
      ctx.moveTo(tx + 2, y + h);
      ctx.lineTo(tx + w / teeth / 2, y + 6);
      ctx.lineTo(tx + w / teeth - 2, y + h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    return;
  }
  if (e.type === "mural" || e.type === "sign") {
    ctx.save();
    ctx.fillStyle = "#30363d";
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.fillStyle = "#1f2a37";
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = e.read ? 0.55 : 0.25;
    ctx.fillStyle = "#a371f7";
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(x + 8, y + 10 + i * 10, w - 16, 2);
    }
    ctx.restore();
    return;
  }
  if (e.type === "lever") {
    const state = e.state ?? 0;
    ctx.save();
    ctx.fillStyle = "#30363d";
    ctx.fillRect(x, y + h - 10, w, 10);
    ctx.strokeStyle = "#8b949e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + h - 10);
    const angle = (-0.9 + state * 0.9) * 0.7;
    ctx.lineTo(x + w / 2 + Math.cos(angle) * 18, y + 12);
    ctx.stroke();
    ctx.fillStyle = ["#58a6ff", "#d29922", "#2ea043"][state] ?? "#58a6ff";
    ctx.beginPath();
    ctx.arc(x + w / 2 + Math.cos(angle) * 18, y + 12, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  if (e.type === "block") {
    ctx.save();
    ctx.fillStyle = "#8b949e";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#30363d";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = "#0b0f14";
    ctx.beginPath();
    ctx.moveTo(x + 8, y + 10);
    ctx.lineTo(x + w - 10, y + h - 12);
    ctx.stroke();
    if (e.grabbed) {
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = "#d29922";
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    }
    ctx.restore();
    return;
  }
  if (e.type === "switch") {
    ctx.save();
    const on = !!e.on;
    ctx.fillStyle = "#30363d";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = on ? "#2ea043" : "#8b949e";
    ctx.fillRect(x + 10, y + 10, w - 20, h - 20);
    ctx.restore();
    return;
  }
  if (e.type === "valve") {
    ctx.save();
    ctx.fillStyle = "#58a6ff";
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0b0f14";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + 6);
    ctx.lineTo(x + w / 2, y + h - 6);
    ctx.moveTo(x + 6, y + h / 2);
    ctx.lineTo(x + w - 6, y + h / 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (e.type === "water") {
    ctx.fillStyle = "rgba(56, 139, 253, 0.25)";
    ctx.fillRect(x, y, w, h);
    return;
  }
  if (e.type === "panel") {
    ctx.save();
    ctx.fillStyle = "#30363d";
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.fillStyle = e.active ? "#d29922" : "#8b949e";
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#0b0f14";
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        ctx.fillRect(x + 10 + c * 14, y + 10 + r * 14, 8, 8);
      }
    }
    ctx.restore();
    return;
  }
}

function drawPlayer(p) {
  const isMe = p.player_id === playerId;
  drawPlayerSprite(p.x, p.y, p.role, p.down, isMe);
  drawPlayerLabel(p);

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

function drawPlayerSprite(x, y, role, down, isMe) {
  ctx.save();
  // shadow
  ctx.globalAlpha = down ? 0.3 : 0.55;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.ellipse(x, y + 12, 12, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // body base
  const bodyColor = role === "guardian" ? "#2f5ea8" : "#2a7a42";
  const cloakColor = role === "guardian" ? "#1f2a37" : "#5b1f1f";

  // cloak/robe
  ctx.fillStyle = down ? "#30363d" : cloakColor;
  ctx.beginPath();
  ctx.moveTo(x - 10, y + 10);
  ctx.lineTo(x + 10, y + 10);
  ctx.lineTo(x + 6, y - 2);
  ctx.lineTo(x - 6, y - 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // torso
  ctx.fillStyle = down ? "#3b4046" : bodyColor;
  ctx.fillRect(x - 6, y - 2, 12, 12);

  // head/helmet
  if (role === "guardian") {
    ctx.fillStyle = down ? "#4b4f55" : "#c9d1d9";
    ctx.beginPath();
    ctx.arc(x, y - 10, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(x - 6, y - 11, 12, 3);
  } else {
    // hood
    ctx.fillStyle = down ? "#3b4046" : "#d29922";
    ctx.beginPath();
    ctx.arc(x, y - 10, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.arc(x + 2, y - 10, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // outline ring for "me"
  ctx.strokeStyle = isMe ? "#f0f6fc" : "rgba(240,246,252,0.25)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPlayerLabel(p) {
  ctx.save();
  const meta = ROLE_META[p.role] ?? { name: p.role ?? "?", color: "#8b949e" };
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1.5;
  const label = `P${p.player_id} ${meta.name}  HP:${p.hp}`;
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const tw = Math.min(220, ctx.measureText(label).width + 16);
  const x = p.x - tw / 2;
  const y = p.y - 34;
  ctx.beginPath();
  roundedRectPath(ctx, x, y, tw, 18, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e6edf3";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, p.x, y + 9);
  ctx.restore();
}

function drawSpeechBubbles() {
  const tick = lastState.tick ?? 0;
  const msgs = lastState.messages ?? [];
  const latestByPlayer = new Map();
  for (const m of msgs) {
    if (m.kind !== "chat") continue;
    const age = (tick - (m.t ?? tick)) / 20;
    if (age < 0 || age > 3.0) continue;
    latestByPlayer.set(m.player_id, m);
  }
  for (const [pid, m] of latestByPlayer.entries()) {
    const p = (lastState.players ?? []).find((pp) => pp.player_id === pid);
    if (!p) continue;
    const text = QUICK_CHAT_BUBBLES[m.text] ?? String(m.text ?? "").slice(0, 28);
    drawSpeechBubble(p.x + (pid === 1 ? -26 : 26), p.y - 58, text, pid === 1);
  }
}

function drawSpeechBubble(x, y, text, left) {
  const lines = String(text).split("\n");
  ctx.save();
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
  const padX = 10;
  const padY = 8;
  const w = Math.min(260, maxW + padX * 2);
  const h = lines.length * 14 + padY * 2;
  const bx = x - (left ? w : 0);
  const by = y - h;

  // bubble
  ctx.fillStyle = "rgba(255,244,220,0.95)";
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  roundedRectPath(ctx, bx, by, w, h, 10);
  ctx.fill();
  ctx.stroke();

  // tail
  ctx.beginPath();
  if (left) {
    ctx.moveTo(bx + w - 18, by + h);
    ctx.lineTo(bx + w - 6, by + h + 10);
    ctx.lineTo(bx + w - 2, by + h - 2);
  } else {
    ctx.moveTo(bx + 18, by + h);
    ctx.lineTo(bx + 6, by + h + 10);
    ctx.lineTo(bx + 2, by + h - 2);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // text
  ctx.fillStyle = "#1f2a37";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const tx = bx + w / 2;
  let ty = by + padY;
  for (const ln of lines) {
    ctx.fillText(ln, tx, ty);
    ty += 14;
  }
  ctx.restore();
}

function drawInteractionHints() {
  const me = (lastState.players ?? []).find((p) => p.player_id === playerId);
  if (!me || me.down) return;

  for (const e of lastState.entities ?? []) {
    if (!isInteractableForRole(e, role)) continue;
    const cx = (e.x ?? 0) + (e.w ?? 0) / 2;
    const cy = (e.y ?? 0) + (e.h ?? 0) / 2;
    const d = Math.hypot(me.x - cx, me.y - cy);
    if (d > 56) continue;
    drawHintBubble(cx, cy - 22, "E");
  }
}

function isInteractableForRole(e, role) {
  if (!e?.type) return false;
  if (e.type === "lever") return role === "guardian";
  if (e.type === "valve") return role === "guardian";
  if (e.type === "block") return role === "guardian";
  if (e.type === "switch") return role === "scholar";
  if (e.type === "mural") return role === "scholar";
  if (e.type === "sign") return role === "scholar";
  if (e.type === "panel") return true;
  return false;
}

function drawHintBubble(x, y, text) {
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "#0b0f14";
  ctx.strokeStyle = "rgba(240,246,252,0.35)";
  ctx.lineWidth = 2;
  const w = 20;
  const h = 18;
  ctx.beginPath();
  roundedRectPath(ctx, x - w / 2, y - h / 2, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e6edf3";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 1);
  ctx.restore();
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
}

function isPlatePressed(plate) {
  if (!lastState?.players) return false;
  const x = plate.x ?? 0;
  const y = plate.y ?? 0;
  const w = plate.w ?? 0;
  const h = plate.h ?? 0;
  for (const ps of lastState.players) {
    if (ps.x >= x && ps.x <= x + w && ps.y >= y && ps.y <= y + h) return true;
  }
  return false;
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
