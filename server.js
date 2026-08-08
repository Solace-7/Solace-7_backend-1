// SOLACE-7 backend
// - Holds GROQ_API_KEY / TAVILY_API_KEY server-side and proxies AI calls,
//   so visitors never see or enter an API key.
// - Holds real accounts (username + hashed password) in Postgres, so a
//   person's tokens/streaks/conversations follow them to any device.

const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("./db");

const app = express();
app.use(express.json({ limit: "12mb" })); // images arrive as base64 data URLs

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

// If you don't set JWT_SECRET yourself, one is generated at boot so the
// app still works — but everyone is signed out on every restart/redeploy.
// Set JWT_SECRET in the Render dashboard for sessions that actually persist.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn("⚠ JWT_SECRET is not set — using a random secret for this run. Set JWT_SECRET on Render so logins survive restarts.");
}
const JWT_EXPIRES_IN = "180d";

const DAILY_GRANT = 1000;
const SIGNUP_BONUS = 500;
const SIGNUP_SPINS = 7;

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1).toString().padStart(2, "0") + "-" + d.getDate().toString().padStart(2, "0");
}

function freshUserData(username, displayName) {
  const today = todayStr();
  return {
    username,
    displayName: displayName || username,
    avatar: "",
    createdAt: Date.now(),
    tokens: DAILY_GRANT + SIGNUP_BONUS,
    tokensEarned: DAILY_GRANT + SIGNUP_BONUS,
    tokensUsed: 0,
    lastDailyReset: today,
    checkinDay: 0,
    lastCheckin: null,
    spinsAvailable: SIGNUP_SPINS,
    lastSpinGrant: today,
    messageLog: [],
    timeSpent: {},
    conversations: [],
    theme: "terminal",
    autoSpeak: false,
    voiceURI: "",
    voiceRate: 1.0,
    customInstructions: "",
    customPersonas: [],
    reactions: { up: 0, down: 0 },
    bestCheckinStreak: 0,
  };
}

// ---------------------------------------------------------------------
// Small in-memory rate limiter (per IP, or per account once authenticated).
// Good enough to stop abuse of your shared API budget. Resets on
// redeploy since it's in-memory — that's fine for this use case.
// ---------------------------------------------------------------------
const buckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = (req.user?.username || req.ip) + ":" + req.path;
    const now = Date.now();
    const entry = buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    buckets.set(key, entry);
    if (entry.count > max) {
      res.status(429).json({ error: "Rate limit exceeded. Please slow down." });
      return;
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now > entry.resetAt) buckets.delete(key);
  }
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------
// Auth middleware — verifies the Bearer token and loads req.user
// ---------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET); // { username }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

// ---------------------------------------------------------------------
// /api/auth/signup — create a real account (Postgres)
// body: { username, password, displayName }
// ---------------------------------------------------------------------
app.post("/api/auth/signup", rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || "").trim();

    if (!/^[a-z0-9_.-]{3,24}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3-24 characters (letters, numbers, _ . -)." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const existing = await db.getByUsername(username);
    if (existing) return res.status(409).json({ error: "That username is taken." });

    const passwordHash = await bcrypt.hash(password, 10);
    const data = freshUserData(username, displayName);
    const row = await db.createUser(username, passwordHash, data);

    const token = jwt.sign({ username: row.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ token, user: row.data, username: row.username });
  } catch (err) {
    console.error("signup error:", err);
    res.status(500).json({ error: "Could not create account. Try again shortly." });
  }
});

// ---------------------------------------------------------------------
// /api/auth/login
// body: { username, password }
// ---------------------------------------------------------------------
app.post("/api/auth/login", rateLimit({ windowMs: 60_000, max: 15 }), async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!username || !password) return res.status(400).json({ error: "Enter a username and password." });

    const row = await db.getByUsername(username);
    if (!row) return res.status(401).json({ error: "No account with that username." });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect password." });

    const token = jwt.sign({ username: row.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ token, user: row.data, username: row.username });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: "Could not log in. Try again shortly." });
  }
});

// ---------------------------------------------------------------------
// /api/me — GET current account data, PUT to save it
// ---------------------------------------------------------------------
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const row = await db.getByUsername(req.user.username);
    if (!row) return res.status(404).json({ error: "Account not found" });
    res.json({ username: row.username, user: row.data });
  } catch (err) {
    console.error("get me error:", err);
    res.status(500).json({ error: "Could not load account" });
  }
});

app.put("/api/me", requireAuth, async (req, res) => {
  try {
    const data = req.body?.data;
    if (!data || typeof data !== "object") return res.status(400).json({ error: "data object is required" });
    // Keep the data tied to the authenticated account regardless of what's in the payload
    data.username = req.user.username;
    const row = await db.saveUserData(req.user.username, data);
    if (!row) return res.status(404).json({ error: "Account not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("save me error:", err);
    res.status(500).json({ error: "Could not save account" });
  }
});

// ---------------------------------------------------------------------
// /api/chat — text chat completions (signed-in users only)
// body: { messages: [{role, content}], sys: "system prompt" }
// ---------------------------------------------------------------------
app.post("/api/chat", requireAuth, rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: "Server is missing GROQ_API_KEY. Set it in the Render dashboard." });
  }
  try {
    const { messages, sys } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages[] is required" });
    }
    const payload = {
      model: GROQ_MODEL,
      messages: [{ role: "system", content: String(sys || "") }, ...messages],
      temperature: 0.7,
      max_tokens: 900,
    };
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + GROQ_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error("Groq chat error:", upstream.status, data);
      return res.status(502).json({ error: "Upstream model error", detail: data?.error?.message });
    }
    const content = data.choices?.[0]?.message?.content || "";
    res.json({ content });
  } catch (err) {
    console.error("chat handler error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------
// /api/vision — image understanding (signed-in users only)
// body: { text, imageDataUrl, sys }
// ---------------------------------------------------------------------
app.post("/api/vision", requireAuth, rateLimit({ windowMs: 60_000, max: 12 }), async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: "Server is missing GROQ_API_KEY. Set it in the Render dashboard." });
  }
  try {
    const { text, imageDataUrl, sys } = req.body || {};
    if (!imageDataUrl) {
      return res.status(400).json({ error: "imageDataUrl is required" });
    }
    const payload = {
      model: GROQ_VISION_MODEL,
      messages: [
        { role: "system", content: String(sys || "") },
        {
          role: "user",
          content: [
            { type: "text", text: text || "What's in this image?" },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.7,
      max_tokens: 900,
    };
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + GROQ_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error("Groq vision error:", upstream.status, data);
      return res.status(502).json({ error: "Upstream vision error", detail: data?.error?.message });
    }
    const content = data.choices?.[0]?.message?.content || "";
    res.json({ content });
  } catch (err) {
    console.error("vision handler error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------
// /api/search — live web search (signed-in users only)
// body: { query }
// ---------------------------------------------------------------------
app.post("/api/search", requireAuth, rateLimit({ windowMs: 60_000, max: 12 }), async (req, res) => {
  if (!TAVILY_API_KEY) {
    return res.status(500).json({ error: "Server is missing TAVILY_API_KEY. Set it in the Render dashboard." });
  }
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: "query is required" });
    const upstream = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: "basic",
        include_answer: true,
        max_results: 5,
      }),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error("Tavily error:", upstream.status, data);
      return res.status(502).json({ error: "Upstream search error" });
    }
    res.json({ results: data.results || [], answer: data.answer || "" });
  } catch (err) {
    console.error("search handler error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// health check for Render
app.get("/healthz", (req, res) => res.json({ ok: true }));

// static frontend (must come after the /api routes)
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`SOLACE-7 backend listening on port ${PORT}`);
      if (!GROQ_API_KEY) console.warn("⚠ GROQ_API_KEY is not set — chat/vision will fail until it is.");
      if (!TAVILY_API_KEY) console.warn("⚠ TAVILY_API_KEY is not set — web search will fail until it is.");
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
