// Host + secure AI proxy + persistence API for the ADC 3D conversational
// training prototype. The Gemini API key lives ONLY here (server env).
// Browsers connect to this server's /live WebSocket and /api/* endpoints; the
// server relays to Google with the key attached, so the key never ships to the
// client. Player progress/results persist in Postgres (DATABASE_URL) so a
// trainee can log out and continue later, and the admin panel (/admin.html)
// can supervise every user.
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const KEY = process.env.GEMINI_API_KEY || "";
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "models/gemini-2.5-flash-native-audio-latest";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const ADMIN_PIN = process.env.ADMIN_PIN || "2026";
const GEMINI_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/* ---------------- database (optional: app still runs without it) ---------------- */
let pool = null, dbReady = false, resultDedupe = false, dbInit = Promise.resolve();
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 5,
  });
  // free-tier Postgres reaps idle connections; an unhandled pool 'error' event
  // would take the whole process down between demo runs
  pool.on("error", (e) => console.log("[db] idle client error: " + e.message));
  dbInit = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS players (
          id SERIAL PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          lang TEXT DEFAULT 'en',
          created_at TIMESTAMPTZ DEFAULT now(),
          last_seen TIMESTAMPTZ DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS results (
          id SERIAL PRIMARY KEY,
          player_id INT REFERENCES players(id) ON DELETE CASCADE,
          level INT NOT NULL,
          attempt INT NOT NULL,
          score INT NOT NULL,
          pass BOOLEAN NOT NULL,
          lang TEXT,
          answers JSONB DEFAULT '[]',
          ts TIMESTAMPTZ DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS progress (
          player_id INT REFERENCES players(id) ON DELETE CASCADE,
          level INT NOT NULL DEFAULT 1,
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT now(),
          PRIMARY KEY (player_id, level)
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL
        );
      `);
      // migrate a pre-level progress table (single slot per player) in place
      await pool.query(`
        ALTER TABLE progress ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1;
        DO $$ BEGIN
          IF (SELECT count(*) FROM information_schema.key_column_usage
              WHERE table_name='progress' AND constraint_name='progress_pkey') = 1 THEN
            ALTER TABLE progress DROP CONSTRAINT progress_pkey;
            ALTER TABLE progress ADD PRIMARY KEY (player_id, level);
          END IF;
        END $$;
      `);
      // one row per (player, level, attempt): a client retry after a half-failed
      // POST must not burn a try with a duplicate result row
      try {
        await pool.query(`
          DELETE FROM results a USING results b
            WHERE a.id > b.id AND a.player_id = b.player_id AND a.level = b.level AND a.attempt = b.attempt;
          CREATE UNIQUE INDEX IF NOT EXISTS results_try ON results (player_id, level, attempt);
        `);
        resultDedupe = true;
      } catch (e) { console.log("[db] results_try index skipped: " + e.message); }
      dbReady = true;
      console.log("[db] schema ready");
    } catch (e) { console.log("[db] init FAILED: " + e.message); }
  })();
}
const db = () => { if (!dbReady) throw Object.assign(new Error("no database"), { status: 503 }); return pool; };

const app = express();
app.use(express.json({ limit: "1mb" }));
// the app lives at the ROOT address; the old /ADC_POC_3D.html deep link keeps working
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "ADC_POC_3D.html"));
});
// HTML must revalidate on every load — stale cached pages kept resurrecting old bugs
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, p) => { if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); },
}));

// Tells the client what is available — never the key itself.
app.get("/api/config", (req, res) => {
  res.json({
    aiAvailable: !!KEY,
    dbAvailable: dbReady,
    liveModel: LIVE_MODEL,
    voice: process.env.GEMINI_VOICE || "Orus",
  });
});

// Client voice telemetry — shows up in Render logs so silences are diagnosable.
app.post("/api/clog", (req, res) => {
  console.log("[voice]", String((req.body && req.body.m) || "").slice(0, 300));
  res.json({ ok: 1 });
});

/* ---------------- player persistence ---------------- */
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};

async function getBypass() {
  const r = await db().query("SELECT value FROM settings WHERE key='bypass'");
  return r.rows.length ? r.rows[0].value : null;
}

// Login (or register) by name → everything the client needs to gate levels and resume.
app.post("/api/login", wrap(async (req, res) => {
  const name = String((req.body && req.body.name) || "").trim().slice(0, 60);
  const lang = req.body && req.body.lang === "ar" ? "ar" : "en";
  if (!name) return res.status(400).json({ error: "name required" });
  const p = await db().query(
    `INSERT INTO players (name, lang) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET last_seen=now(), lang=$2 RETURNING id, name`,
    [name, lang]);
  const id = p.rows[0].id;
  const [results, prog, bypass] = await Promise.all([
    db().query("SELECT level, attempt, score, pass, lang, ts FROM results WHERE player_id=$1 ORDER BY ts", [id]),
    db().query("SELECT level, state, updated_at FROM progress WHERE player_id=$1 ORDER BY updated_at DESC", [id]),
    getBypass(),
  ]);
  res.json({
    playerId: id, name: p.rows[0].name,
    results: results.rows,
    progress: prog.rows, // one in-flight checkpoint per level
    bypass,
  });
}));

// Mid-level checkpoint — written after every answered beat, deleted on level end.
app.post("/api/progress", wrap(async (req, res) => {
  const { playerId, level, state } = req.body || {};
  if (!playerId) return res.status(400).json({ error: "playerId required" });
  const lv = (level | 0) || 1;
  if (state) {
    await db().query(
      `INSERT INTO progress (player_id, level, state, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (player_id, level) DO UPDATE SET state=$3, updated_at=now()`,
      [playerId, lv, state]);
  } else {
    await db().query("DELETE FROM progress WHERE player_id=$1 AND level=$2", [playerId, lv]);
  }
  await db().query("UPDATE players SET last_seen=now() WHERE id=$1", [playerId]);
  res.json({ ok: 1 });
}));

// Final level result — the progress checkpoint is consumed by it.
app.post("/api/result", wrap(async (req, res) => {
  const { playerId, level, attempt, score, pass, lang, answers } = req.body || {};
  if (!playerId || !level) return res.status(400).json({ error: "playerId and level required" });
  await db().query(
    `INSERT INTO results (player_id, level, attempt, score, pass, lang, answers) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ${resultDedupe ? `ON CONFLICT (player_id, level, attempt) DO UPDATE
       SET score = GREATEST(results.score, EXCLUDED.score), pass = results.pass OR EXCLUDED.pass` : ""}`,
    [playerId, level | 0, attempt | 0, score | 0, !!pass, lang === "ar" ? "ar" : "en", JSON.stringify(answers || [])]);
  await db().query("DELETE FROM progress WHERE player_id=$1 AND level=$2", [playerId, level | 0]);
  await db().query("UPDATE players SET last_seen=now() WHERE id=$1", [playerId]);
  res.json({ ok: 1 });
}));

/* ---------------- admin API (PIN-protected) ---------------- */
const adminOnly = (req, res, next) => {
  if ((req.headers["x-admin-pin"] || "") !== ADMIN_PIN) return res.status(401).json({ error: "wrong PIN" });
  next();
};

// Everything the admin panel shows, in one call.
app.get("/api/admin/overview", adminOnly, wrap(async (req, res) => {
  const [players, results, progress, bypass] = await Promise.all([
    db().query("SELECT id, name, lang, created_at, last_seen FROM players ORDER BY last_seen DESC"),
    db().query("SELECT player_id, level, attempt, score, pass, lang, ts FROM results ORDER BY ts DESC"),
    db().query("SELECT player_id, level, state, updated_at FROM progress ORDER BY updated_at DESC"),
    getBypass(),
  ]);
  res.json({ players: players.rows, results: results.rows, progress: progress.rows, bypass });
}));

// Global Level-2 bypass (the tender's "logged admin unlock" requirement).
app.post("/api/admin/bypass", adminOnly, wrap(async (req, res) => {
  const { on, by } = req.body || {};
  if (on) {
    await db().query(
      `INSERT INTO settings (key, value) VALUES ('bypass', $1)
       ON CONFLICT (key) DO UPDATE SET value=$1`,
      [JSON.stringify({ by: String(by || "admin").slice(0, 60), ts: new Date().toISOString() })]);
  } else {
    await db().query("DELETE FROM settings WHERE key='bypass'");
  }
  console.log(`[admin] bypass ${on ? "ON by " + by : "OFF"}`);
  res.json({ ok: 1 });
}));

// Wipe one player's in-flight progress (they restart the level cleanly).
app.post("/api/admin/reset-progress", adminOnly, wrap(async (req, res) => {
  await db().query("DELETE FROM progress WHERE player_id=$1", [req.body.playerId | 0]);
  res.json({ ok: 1 });
}));

// Remove a player entirely (results + progress cascade).
app.post("/api/admin/delete-player", adminOnly, wrap(async (req, res) => {
  await db().query("DELETE FROM players WHERE id=$1", [req.body.playerId | 0]);
  res.json({ ok: 1 });
}));

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
// listen only after the schema check settles — the first visitor after a
// free-tier wake-up otherwise read dbAvailable:false and ran unpersisted
dbInit.finally(() =>
  server.listen(port, () => console.log(`ADC Training prototype on :${port} (AI ${KEY ? "enabled" : "DISABLED - set GEMINI_API_KEY"}, DB ${process.env.DATABASE_URL ? (dbReady ? "ready" : "FAILED") : "DISABLED - set DATABASE_URL"})`)));
