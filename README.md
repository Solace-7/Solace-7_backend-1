# SOLACE-7 — backend, real accounts, and deploy files

This turns SOLACE-7 into a normal, hosted web app with **real
cross-device accounts**:

- `GROQ_API_KEY` and `TAVILY_API_KEY` live only on the server (Render
  environment variables) — visitors never see or enter an API key.
- Accounts (username + password) are stored in **Postgres**, with the
  password hashed server-side (bcrypt) — never in plain text, never in
  the browser.
- Everything about an account — tokens, streaks, conversations,
  personas, settings — is stored as one JSON document per user in
  Postgres, and synced automatically as you use the app. Sign in from
  any device/browser and it's all there.

## What's in here

```
solace7-backend/
├── server.js          Express app — auth endpoints + Groq/Tavily proxy
├── db.js              Postgres access layer (accounts table)
├── package.json
├── render.yaml         one-click Render blueprint (web service + free Postgres DB)
├── .env.example         local-dev env template (copy to .env, never commit .env)
├── .gitignore
└── public/
    └── index.html      your SOLACE-7 frontend, updated to:
                          - sign up / log in against the backend (no more
                            "add your API key" step)
                          - load + save your account data from Postgres
                            instead of only localStorage
                          - call /api/chat, /api/vision, /api/search
                            (which hold the real API keys) instead of
                            calling Groq/Tavily directly
```

Nothing about the app's *features* changed — same chat, personas,
tokens, streaks, spin wheel, themes. What changed is where the data
lives: it now round-trips to your own Postgres database instead of
staying trapped in one browser's localStorage.

## 1. Get your API keys

- Groq (chat + vision): https://console.groq.com/keys — free tier available.
- Tavily (web search): https://tavily.com — free tier available.

You don't need a database account/URL ahead of time — Render creates
and connects one automatically if you use the blueprint below.

## 2. Push this folder to GitHub

`server.js`, `db.js`, and `package.json` should sit at the repo root
(or set Render's "Root Directory" if you nest it).

```bash
cd solace7-backend
git init
git add .
git commit -m "SOLACE-7 with real accounts"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 3. Deploy on Render.com

**Recommended — one-click blueprint**
1. In Render, click **New → Blueprint** and pick this repo. It reads
   `render.yaml` automatically, which provisions:
   - a **free Postgres database** (`solace7-db`) and wires its
     connection string into the web service as `DATABASE_URL`
   - a random `JWT_SECRET` (used to sign login sessions)
2. Render will prompt you for `GROQ_API_KEY` and `TAVILY_API_KEY` —
   paste them in (marked `sync: false` so they're never stored in the
   repo).
3. Deploy. Done — accounts, chat, vision, and search all work
   immediately.

**Manual setup (if you'd rather not use the blueprint)**
1. **New → PostgreSQL** → create a free database, copy its **Internal
   Database URL**.
2. **New → Web Service** → connect this repo.
   - Environment: **Node**, Build command: `npm install`, Start
     command: `node server.js`
   - Environment variables:
     - `GROQ_API_KEY` = your Groq key
     - `TAVILY_API_KEY` = your Tavily key
     - `DATABASE_URL` = the Postgres URL from step 1
     - `JWT_SECRET` = any long random string (e.g. generate one with
       `openssl rand -hex 32`)
3. Deploy.

The server creates its one `users` table automatically on first boot
— no manual migration step needed.

## 4. Test it

Visit your Render URL, create an account, send a message, check in,
spin the wheel. Then open the same URL in a different browser (or log
out and back in) with the same username/password — your tokens,
streak, and chats should all be there, because they now live in
Postgres, not that browser's localStorage.

`GET /healthz` returns `{ok:true}` — used as Render's health check.

## Notes / things worth knowing

- **Sessions**: logins are signed tokens (JWT) valid for 180 days,
  stored in the browser's localStorage as just a token (not your
  password, not your data). If you don't set `JWT_SECRET` yourself, a
  random one is generated at boot — meaning every restart/redeploy
  signs everyone out. The blueprint sets this for you automatically;
  if you're doing manual setup, make sure to set it.
- **Free Render Postgres databases expire after 90 days** unless
  upgraded to a paid plan — Render will email you before that happens.
  For anything beyond a demo/personal project, plan to upgrade the
  database plan.
- **Free web services spin down when idle** and take ~30–50s to wake
  on the next request. Upgrade to a paid instance to avoid this.
- The in-memory rate limiter in `server.js` resets on
  redeploy/restart — it exists to stop one account or IP from burning
  through your API quota, not as a full abuse-prevention system.
- Saves to your account are debounced (~800ms after each change) and
  also flushed on page close, so you won't lose progress from a normal
  tab close — but a hard crash mid-request could in rare cases lose
  the last few seconds of activity.

## Local development

```bash
cp .env.example .env      # fill in your real keys + a local Postgres URL
npm install
npm start                 # http://localhost:3000
```

You'll need a local Postgres instance for local dev (or point
`DATABASE_URL` at a Render/other hosted Postgres instance).
