// THE WALL: one shared pixel canvas. Everyone online paints the same grid live.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const W = 96;
const H = 96;
const SAVE_FILE = process.env.SAVE_FILE || path.join(__dirname, "wall.bin");
const SAVE_EVERY_MS = 10000;
const MAX_PIXELS_PER_SEC = 40; // per connection
const MAX_CLIENTS = 500;

let grid = new Uint8Array(W * H); // palette index per cell, 0 = blank
let totalPlaced = 0;
let dirty = false;

try {
  const raw = fs.readFileSync(SAVE_FILE);
  if (raw.length >= W * H) {
    grid = new Uint8Array(raw.subarray(0, W * H));
    if (raw.length >= W * H + 4) totalPlaced = raw.readUInt32BE(W * H);
  }
} catch (_) {
  /* first run, nothing saved yet */
}

function save() {
  if (!dirty) return;
  dirty = false;
  const buf = Buffer.alloc(W * H + 4);
  buf.set(grid, 0);
  buf.writeUInt32BE(totalPlaced >>> 0, W * H);
  fs.writeFile(SAVE_FILE, buf, () => {});
}
setInterval(save, SAVE_EVERY_MS);

const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"));
let cardPng = null;
try {
  cardPng = fs.readFileSync(path.join(__dirname, "public", "card.png"));
} catch (_) {
  /* card image is optional */
}

const server = http.createServer((req, res) => {
  const p = (req.url || "/").split("?")[0];
  if (p === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  // "/" is the full page, "/play" is the same page in compact mode for the X player card
  if (p === "/" || p === "/play") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
    return res.end(indexHtml);
  }
  if (p === "/card.png" && cardPng) {
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600",
    });
    return res.end(cardPng);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ server, maxPayload: 1024 });
let nextId = 1;

function broadcast(obj, except) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c !== except && c.readyState === 1) c.send(msg);
  }
}

function online() {
  let n = 0;
  for (const c of wss.clients) if (c.readyState === 1) n++;
  return n;
}

wss.on("connection", (ws) => {
  if (online() > MAX_CLIENTS) {
    ws.close(1013, "full");
    return;
  }
  ws.id = nextId++;
  ws.tokens = MAX_PIXELS_PER_SEC;
  ws.lastRefill = Date.now();
  ws.alive = true;

  ws.send(
    JSON.stringify({
      t: "init",
      id: ws.id,
      w: W,
      h: H,
      data: Buffer.from(grid).toString("base64"),
      online: online(),
      total: totalPlaced,
    })
  );
  broadcast({ t: "online", n: online() }, null);

  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (!m || typeof m !== "object") return;

    if (m.t === "p") {
      const now = Date.now();
      ws.tokens = Math.min(
        MAX_PIXELS_PER_SEC,
        ws.tokens + ((now - ws.lastRefill) / 1000) * MAX_PIXELS_PER_SEC
      );
      ws.lastRefill = now;
      if (ws.tokens < 1) return;
      const x = m.x | 0;
      const y = m.y | 0;
      const c = m.c | 0;
      if (x < 0 || y < 0 || x >= W || y >= H || c < 0 || c > 15) return;
      ws.tokens -= 1;
      if (grid[y * W + x] === c) return;
      grid[y * W + x] = c;
      dirty = true;
      totalPlaced++;
      broadcast({ t: "p", x, y, c }, null);
    } else if (m.t === "m") {
      const x = Number(m.x);
      const y = Number(m.y);
      const c = m.c | 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      broadcast({ t: "m", id: ws.id, x, y, c: c & 15 }, ws);
    }
  });

  ws.on("close", () => {
    broadcast({ t: "online", n: online() }, null);
    broadcast({ t: "gone", id: ws.id }, null);
  });
  ws.on("error", () => {});
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch (_) {}
  }
}, 30000);

// periodic total counter so everyone's number stays roughly in sync
setInterval(() => {
  broadcast({ t: "total", n: totalPlaced }, null);
}, 5000);

function shutdown() {
  dirty = true;
  save();
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => console.log("the wall is up on :" + PORT));
