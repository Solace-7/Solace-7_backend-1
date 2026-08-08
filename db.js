// db.js — Postgres access layer for SOLACE-7 accounts.
// One table, one JSONB blob per user: everything the frontend used to
// keep in localStorage (tokens, streaks, conversations, personas...)
// now lives in `data`, keyed by a real account with a hashed password.

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn("⚠ DATABASE_URL is not set — accounts will not work until a Postgres database is attached.");
}

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    })
  : null;

async function init() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function getByUsername(username) {
  if (!pool) throw new Error("Database not configured");
  const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  return rows[0] || null;
}

async function createUser(username, passwordHash, data) {
  if (!pool) throw new Error("Database not configured");
  const { rows } = await pool.query(
    "INSERT INTO users (username, password_hash, data) VALUES ($1, $2, $3) RETURNING *",
    [username, passwordHash, data]
  );
  return rows[0];
}

async function saveUserData(username, data) {
  if (!pool) throw new Error("Database not configured");
  const { rows } = await pool.query(
    "UPDATE users SET data = $2, updated_at = now() WHERE username = $1 RETURNING *",
    [username, data]
  );
  return rows[0] || null;
}

module.exports = { pool, init, getByUsername, createUser, saveUserData };
