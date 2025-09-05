# Casino Games

A full‑stack casino games experience featuring Blackjack, Roulette, and other games coming. Built with a React + FastAPI stack.

## Tech Stack

- Frontend: Vite, React 18, TypeScript, Tailwind CSS v4, Framer Motion, Zustand
- Backend: FastAPI, Uvicorn, Pydantic v2, SQLAlchemy 2
- Database: PostgreSQL (prod) with SQLite fallback for dev (`dev.db`)
- Auth: HTTP‑only JWT session cookies (python‑jose, passlib)
- Tooling: ESM, ESLint, TypeScript project refs, Vite dev server

## Features

- Blackjack: Multi‑hand play with Hit/Stand/Double/Split, 3:2 natural payouts, dealer hits soft 17, and a realistic 6‑deck shoe with cut‑card reshuffle.
- Roulette: Quick spins with number or color bets (even‑money and straight‑up payouts).
- Wallet: Running balance, bet/payout/refund transactions, and summary endpoints.
- Auth: Email/username login, secure cookie session, CORS‑scoped API access.
- UI Polish: Motion design for cards, chips, and payouts; responsive layout; themed visuals.

## Quick Start

Prerequisites: Python 3.11+, Node.js 18+ (for Vite), and npm or pnpm.

1) Backend (FastAPI)

- Create a virtualenv and install requirements:
  - Windows (PowerShell):
    - `cd api`
    - `py -3.11 -m venv .venv`
    - `.venv\\Scripts\\Activate.ps1`
    - `pip install -r requirements.txt`
  - macOS/Linux:
    - `cd api`
    - `python3 -m venv .venv`
    - `source .venv/bin/activate`
    - `pip install -r requirements.txt`
- Configure environment (create `api/.env` or export vars):
  - `DATABASE_URL=postgresql://user:pass@host/db?sslmode=require`  (omit to use local SQLite `dev.db`)
  - `JWT_SECRET=<generate-a-long-random-secret>`
  - `CLIENT_ORIGIN=http://localhost:5173`
  - `SECURE_COOKIES=0`  (set `1` for HTTPS environments)
- Run the API:
  - From repo root or `api/`: `uvicorn api.app:app --reload --port 8000`
  - Health check: `GET http://localhost:8000/healthz`

2) Frontend (Vite + React)

- Install deps: `cd client && npm install`
- Point the client at your API (choose one):
  - Add `client/.env.local` with: `VITE_API_BASE=http://localhost:8000`
  - Or set it inline: `VITE_API_BASE=http://localhost:8000 npm run dev`
- Start dev server: `npm run dev` (opens on `http://localhost:5173`)

Log in or register from the UI, place a bet, and deal.

## Project Structure

- `api/` — FastAPI service, SQLAlchemy models, auth, and game engines
  - `api/app.py` — App factory, CORS, routers, health, `/me`
  - `api/models.py` — `User`, `GameSession`, `Transaction`, analytics tables
  - `api/security.py` — JWT cookie session, password hashing, `current_user`
  - `api/games/blackjack.py` — Multi‑hand blackjack logic and endpoints
  - `api/games/roulette.py` — Simple roulette spin endpoint
  - `api/requirements.txt` — Backend dependencies
- `client/` — Vite React app with Tailwind and animation
  - `client/src/features/game/BlackjackTable.tsx` — Table UI and actions
  - `client/src/features/auth/AuthModal.tsx` — Login/register modal
  - `client/src/components/Chip*.tsx` — Image‑based chip rendering and stacking
  - `client/src/api/client.ts` — Fetch wrapper with `VITE_API_BASE`

## API Overview

- Auth
  - `POST /auth/register` — Create account (username + password, optional email)
  - `POST /auth/login` — Email or username + password; sets session cookie
  - `POST /auth/logout` — Clears session cookie
  - `GET /me` — Current user profile and balance
- Wallet
  - `GET /wallet/balance` — Current balance (cents)
  - `GET /wallet/summary` — Totals for bets, returns, and net
- Blackjack
  - `POST /blackjack/start?bet_cents=500` — Start a round; deals player/dealer
  - `POST /blackjack/action?session_id={id}&action={hit|stand|double|split}` — Play actions
- Roulette
  - `POST /roulette/spin` — Body/query: `bet_cents`, `bet_target` (e.g., `"R"`, `"B"`, or `"17"`)
- Health
  - `GET /healthz` — Simple readiness check

Notes
- CORS origin is controlled by `CLIENT_ORIGIN`.
- Sessions use an HTTP‑only `session` cookie; set `SECURE_COOKIES=1` behind HTTPS.
- In development, SQLite (`dev.db`) is created automatically if `DATABASE_URL` is not provided.

## Gameplay Details (Blackjack)

- Shoe: 6 decks, reshuffle when ~75–80% used (cut card behavior).
- Dealer: Hits on soft 17; reveals with small staged animations in UI.
- Payouts: Natural 3:2, wins 1:1, pushes refunded; per‑hand settlement after split.
- Analytics: Card draws recorded to `card_draws` for future insights.

## Deployment

- API: FastAPI can run on Fly.io, Railway, Render, or any container host. Use `DATABASE_URL` for Postgres (e.g., Neon). Ensure `SECURE_COOKIES=1` and set `CLIENT_ORIGIN` to your frontend URL.
- Frontend: Vite output is static; deploy on Vercel, Netlify, or static hosting. Configure `VITE_API_BASE` to your API URL.

## Plans

### Home Casino Hub
- Landing page to browse and jump into games (Blackjack, Roulette, future Slots).
- Show current balance, recent sessions, and featured tables.
- Quick links and keyboard shortcuts to rejoin the last table.

### Roulette Table
- Full betting board: straight-up, split, street, corner, dozen, column, red/black, even/odd, high/low.
- Spin animation, last-results history strip, chip stack animations on wins.
- Persist bet target(s) and stake per spin for better analytics.

### Profile & Stats (what to display)
- Lifetime totals: total money bet, total returns (payout + refunds), net, ROI, average bet size, largest win/loss, sessions played, active days.
- Blackjack: hands played, wins/losses/pushes, natural count/rate, bust rate, double-down attempts + win rate, splits attempted + win rate, surrender count, outcomes by starting hand, outcomes vs dealer upcard, per-hand ROI, time-to-settle.
- Card distribution: draw counts by rank and suit, starting two-card combos, dealer upcard distribution (leveraging `card_draws`).
- Roulette: spins played, hit rate by bet type, red/black distribution, number distribution, net by bet type.

### Data & Schema (what to track)
- Keep using: `game_sessions`, `transactions`, `card_draws`, `roulette_spins`.
- Add `blackjack_hand_results` (per-hand after splits):
  - session_id, hand_index, bet_cents, outcome (win/lose/push/blackjack/surrender), doubled (bool), surrendered (bool), natural (bool),
    player_total, dealer_total, dealer_upcard_rank, dealer_upcard_suit, settled_at.
- Optional `blackjack_actions` if deeper action analytics are needed (session_id, hand_index, action, order_idx, created_at) — current `actions_log` JSON may suffice.
- Optional `roulette_bets` with bet_type (color/number/dozen/etc), target, stake_cents, odds, outcome, payout_cents.
- Indexing: `(user_id, created_at)` on sessions/transactions; `(session_id)` on analytics tables.

### API Additions
- `GET /stats/profile` — aggregates lifetime totals and per-game summaries.
- `GET /stats/blackjack` — breakdowns by starting hand, dealer upcard, action (double/split), and per-hand ROI.
- `GET /stats/roulette` — results by bet type and target.

### Implementation Notes
- Backfill: derive `blackjack_hand_results` for past sessions by combining `card_draws`, final dealer/player totals, and transactions.
- Migrations: introduce Alembic or a lightweight migration script to add analytics tables.
- Privacy: expose only the current user’s stats by default; make leaderboards opt-in.

## Resume / Website Summary

- Built a production‑style casino experience with animated Blackjack and Roulette, including real‑world rules (multi‑deck shoe, soft‑17, 3:2 naturals) and polished interaction design.
- Implemented a secure FastAPI backend with JWT cookie sessions, SQLAlchemy models, and transaction‑based wallet accounting, backed by Postgres (with SQLite for local dev).
- Delivered an engaging React + TypeScript UI using Tailwind CSS and Framer Motion, with clean state management via Zustand and responsive layouts.
- Clean separation of concerns, CORS‑scoped API, environment‑driven config, and straightforward deployment paths to modern platforms.
