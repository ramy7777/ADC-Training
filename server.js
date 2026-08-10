// Host + secure AI proxy for the ADC 3D conversational training prototype.
// The Gemini API key lives ONLY here (server env). Browsers connect to this
// server's /live WebSocket and /api/generate endpoint; the server relays to
// Google with the key attached, so the key is never shipped to the client.
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const KEY = process.env.GEMINI_API_KEY || "";
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "models/gemini-2.5-flash-native-audio-latest";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const GEMINI_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Tells the client what is available — never the key itself.
app.get("/api/config", (req, res) => {
  res.json({
    aiAvailable: !!KEY,
    liveModel: LIVE_MODEL,
    voice: process.env.GEMINI_VOICE || "Orus",
  });
});

// REST proxy for the non-voice fallback (typed answers, ask-Saif).
app.post("/api/generate", async (req, res) => {
  if (!KEY) return res.status(503).json({ error: "AI not configured" });
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) }
    );
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

const server = http.createServer(app);

// Transparent relay: browser <-> this server <-> Gemini Live API.
const wss = new WebSocketServer({ server, path: "/live" });
let liveSeq = 0;
wss.on("connection", (client) => {
  if (!KEY) { client.close(1011, "AI not configured"); return; }
  const id = ++liveSeq;
  const t0 = Date.now();
  const age = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
  console.log(`[live#${id}] client connected`);
  const upstream = new WebSocket(`${GEMINI_WS}?key=${KEY}`);
  const pending = [];
  // keepalive: quiet stretches (fallback cards, trainee walking) left the socket
  // silent, and idle connections were reaped after ~70s (client 1006 / gemini 1011)
  const ka = setInterval(() => {
    try { if (client.readyState === WebSocket.OPEN) client.ping(); } catch {}
    try { if (upstream.readyState === WebSocket.OPEN) upstream.ping(); } catch {}
  }, 20000);
  upstream.on("open", () => { for (const m of pending) upstream.send(m); pending.length = 0; });
  client.on("message", (data) => {
    const msg = data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
    else pending.push(msg);
  });
  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data.toString());
  });
  const closeBoth = () => { clearInterval(ka); try { client.close(); } catch {} try { upstream.close(); } catch {} };
  client.on("close", (code) => { console.log(`[live#${id}] client closed ${code} after ${age()}`); closeBoth(); });
  client.on("error", (e) => { console.log(`[live#${id}] client error: ${e.message}`); closeBoth(); });
  upstream.on("close", (code, reason) => {
    console.log(`[live#${id}] gemini closed ${code} "${String(reason).slice(0, 200)}" after ${age()}`);
    clearInterval(ka);
    try { client.close(1000, String(reason).slice(0, 100)); } catch {}
  });
  upstream.on("error", (e) => { console.log(`[live#${id}] gemini error: ${e.message}`); closeBoth(); });
});

const port = process.env.PORT || 10000;
server.listen(port, () => console.log(`ADC Training prototype on :${port} (AI ${KEY ? "enabled" : "DISABLED - set GEMINI_API_KEY"})`));
