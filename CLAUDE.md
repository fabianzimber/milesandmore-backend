# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Miles & More Backend — Fastify v5 HTTP server + Twitch IRC chat bot for a Twitch-integrated airline simulation. TypeScript CJS, Node 20, Upstash Redis, deployed to Fly.io (fra region).

The frontend (separate repo/folder: `milesandmore-web`) is a Next.js App Router app that proxies API requests to this backend.

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Dev server | `npm run dev` (tsx watch, port 3001) |
| Build | `npm run build` (tsc) |
| Start | `npm run start` (node dist/main.js) |
| Type-check | `npx tsc --noEmit` |

No linter configured. No test runner configured. No `*.test.*` or `*.spec.*` files exist.

## Architecture

### Layers

- **Entry**: `src/main.ts` boots Fastify, restarts bot runtime, starts local scheduler
- **Routes**: all in `src/server.ts`, grouped as public / admin / webhooks / OAuth
- **Bot logic**: `src/milesandmorebot/core.ts` — commands defined as `CommandDefinition` objects
- **Storage**: `src/milesandmorebot/storage.ts` — all Redis access through `repositories` object
- **Twitch API**: `src/milesandmorebot/twitch.ts` — OAuth, chat, whispers
- **IRC**: `src/milesandmorebot/irc.ts` — tmi.js client singleton
- **Scheduling**: QStash (`scheduler.ts`) with local polling fallback (`local-scheduler.ts`)
- **Config**: `src/milesandmorebot/env.ts` — all env vars accessed through this config object
- **Types**: `src/lib/types.ts` — shared domain types

### Key Endpoints

- Public: `/flights`, `/channels`, `/leaderboard/*`, `/commands`, `/simbrief/*`
- Admin: `/bot/*`, `/flights/*` mutations — protected by `x-internal-job-secret` header
- Webhooks: `/api/twitch/eventsub`, `/api/internal/jobs/*`, `/api/simlink/ingest`
- OAuth: `/api/twitch/authorize`, `/api/twitch/callback`
- Health: `/health`

## Key Conventions

- **TypeScript strict**; do not weaken tsconfig
- **Wire-format fields are snake_case** (`flight_id`, `channel_name`, `icao_from`); local variables are camelCase
- **Relative imports only**, no path aliases (`"./storage"`, `"../lib/types"`)
- **`import type`** for type-only imports
- **Bot responses and user-facing labels are in German**
- Admin endpoints protected by `x-internal-job-secret` header via `isAdminAuthorized()`
- New routes go in `server.ts`; new bot commands go in `core.ts`
- All Redis access via `repositories` in `storage.ts`; all Twitch API via `twitch.ts`
- Formatting: semicolons, double quotes, 2-space indent, trailing commas

## CI/CD

GitHub Actions deploys to Fly.io on push to `main`, then restarts the bot runtime via POST `/bot/restart`.

## Ignore

- `src/main.go` — dead scaffold, ignore it
