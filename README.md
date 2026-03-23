# Miles & More Backend

Standalone backend for Miles & More, intended for Railway deployment.

## What is included

- Fastify HTTP server (`src/server.ts`)
- Miles & More bot runtime + storage + Twitch/EventSub integration (`src/milesandmorebot/*`)
- API endpoints consumed by the web app (`/flights`, `/channels`, `/bot/*`, `/simbrief/*`, `/simlink/*`, etc.)
- Webhook endpoints:
  - `POST /api/twitch/eventsub`
  - `POST /api/internal/jobs/boarding-warning`
  - `POST /api/internal/jobs/boarding-close`
  - `POST /api/simlink/ingest`
- OAuth helper endpoints:
  - `GET /api/twitch/authorize`
  - `GET /api/twitch/callback`
- `GET /health`

## Local run

```bash
npm install
cp .env.example .env
npm run dev
```

Server listens on `http://localhost:3001` by default.

## Railway

- Set all variables from `.env.example` in Railway.
- Point web app `NEXT_PUBLIC_BOT_API_URL` to your Railway backend URL.
