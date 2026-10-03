# Deployment

Levels is built for a single owner. Two ways to run it:

## 1. Local, on your own computer (default)

```bash
npm install
npm run db:local          # embedded PostgreSQL on 127.0.0.1:5433 (keep running)
npm run db:deploy         # apply migrations
npm run dev               # web app on http://localhost:3000 (bound to 127.0.0.1)
npm run worker            # alert engine, notifications, backtests (keep running)
```

With `AUTH_MODE=local` there is no sign-in on this computer; other machines cannot connect (loopback-only bind).
TradingView webhooks cannot reach a local-only app — use a tunnel (e.g. Cloudflare Tunnel) pointing at port 3000
if you need them, and keep `AUTH_MODE=password` when anything is exposed.

## 2. A server (VPS / container)

Requirements: Node 20+, PostgreSQL 14+, optionally Redis 6+.

```bash
npm ci
npm run build
npm run db:deploy
npm start                 # web (behind HTTPS reverse proxy: Caddy, nginx, …)
npm run worker            # as a separate long-running process (systemd, pm2, docker)
```

Required environment (see `.env.example`):

| Variable                                      | Notes                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                | PostgreSQL                                                                                      |
| `NEXTAUTH_SECRET`                             | `openssl rand -base64 32` — signs session tokens                                                |
| `ENCRYPTION_KEY`                              | `openssl rand -base64 32` — encrypts bot tokens. **Never change** after bots exist; back it up. |
| `APP_URL`                                     | public HTTPS URL (origin checks, webhook URLs)                                                  |
| `AUTH_MODE`                                   | `password` on servers (local mode is ignored unless loopback-bound)                             |
| `MARKET_DATA_PROVIDER`, `TWELVE_DATA_API_KEY` | real market data                                                                                |
| `REDIS_URL`                                   | optional; BullMQ queues and shared rate limits across processes                                 |

Run exactly **one** worker unless you use Redis (the interrupted-backtest sweep assumes one worker; triggers and
deliveries are safe with several).

After every deploy with migrations: run `npm run db:deploy`, then restart **web and worker**.

## 3. Docker Compose

`docker-compose.yml` runs PostgreSQL, Redis, a one-shot `migrate` job, the web app and the worker:

```bash
docker compose up -d --build      # everything; secrets come from .env
docker compose up -d db redis     # only infrastructure, run the app with npm
```

Containers always require sign-in (local mode needs a loopback-bound process). Back up with
`npm run db:backup` pointed at the container's database, or use `pg_dump` from the `db` container.

## Health endpoints

`/api/health/database`, `/api/health/redis`, `/api/health/market-data`, `/api/health/workers` — for uptime
monitors. The System page shows the same plus queues and provider health.

## What "production complete" still needs from you

- A real market-data key (`TWELVE_DATA_API_KEY`) — the mock provider is synthetic.
- A Telegram bot with the correct chat (Telegram Bots → Edit → **Find my chat**).
- Redis if you run more than one worker or web instance.
- HTTPS and a public URL for TradingView webhooks.
