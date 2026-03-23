# AGENTS.md

This file gives coding agents the minimum project-specific guidance needed to work safely and consistently in this repository.

## Project Snapshot

- App: Fastify v5 HTTP server + Twitch IRC chat bot for Miles & More.
- Language: TypeScript with `strict` mode, CommonJS modules, ES2022 target.
- Runtime: Node.js 20.
- Database: Upstash Redis (all data stored as Redis keys, sorted sets, sets — no SQL).
- Job scheduling: Upstash QStash for delayed jobs (boarding warnings, boarding close), with a local fallback scheduler polling every 15s.
- Twitch integration: tmi.js for IRC chat, Twitch Helix API for user lookups, chat messages, whispers.
- Deployment: Fly.io (fra region), GitHub Actions CI/CD.

## Source Layout

- `src/main.ts`: Entry point — boots Fastify, restarts bot runtime, starts local scheduler.
- `src/server.ts`: All Fastify route definitions, CORS, admin auth middleware.
- `src/lib/types.ts`: Shared domain types (`Flight`, `Participant`, `SeatConfig`, `SimBrief`, etc.).
- `src/lib/airports.ts`: Static ICAO→coordinates lookup (160+ airports).
- `src/milesandmorebot/core.ts`: Business logic and all chat commands (17 commands).
- `src/milesandmorebot/env.ts`: Environment variable config object.
- `src/milesandmorebot/irc.ts`: tmi.js IRC client singleton, join/part/reset.
- `src/milesandmorebot/storage.ts`: Upstash Redis repository layer (flights, participants, userMiles, etc.).
- `src/milesandmorebot/twitch.ts`: Twitch API client, OAuth flows, credential management, chat/whisper sending.
- `src/milesandmorebot/scheduler.ts`: QStash client for delayed job publishing.
- `src/milesandmorebot/local-scheduler.ts`: Polling fallback scheduler for boarding lifecycle.
- `src/milesandmorebot/logger.ts`: Redis-backed bot log with console output.
- `src/main.go`: Dead scaffold — ignore.

## Package Manager And Setup

- Primary lockfile present: `package-lock.json`, so default to `npm` commands.
- Install dependencies: `npm install`.
- Dev server: `npm run dev` (uses `tsx watch src/main.ts`).
- Production build: `npm run build` (runs `tsc`).
- Production start: `npm run start` (runs `node dist/main.js`).
- Environment variables are injected by Fly.io in production; set them manually for local dev.

## Build / Lint / Test Commands

- Install deps: `npm install`
- Start dev server: `npm run dev`
- Create production build: `npm run build`
- Start production server: `npm run start`
- There is NO lint script configured. No ESLint or similar is present.

## Single-File / Targeted Commands

- Type-check the project without emitting: `npx tsc --noEmit`
- Type-check with concise output: `npx tsc --noEmit --pretty false`
- No single-file lint command available (no linter configured).

## Test Status

- There is currently no `test` script in `package.json`.
- No Jest, Vitest, or any test framework is installed.
- No `*.test.*` or `*.spec.*` files are present in the repository.
- Because no automated test runner is configured, there is currently no supported command for running tests.
- If you add tests in the future, also add explicit `test` and single-test guidance here.

## Command Reality Check

- `npm run build` is the primary verification command.
- `npm run dev` starts the server with tsx watch for local development.
- If dependencies are not installed, build will fail (`tsc` not found).

## Environment Variables

Important values referenced by the app include:

- `PORT`, `HOST`
- `BACKEND_PUBLIC_URL`
- `TWITCH_APP_CLIENT_ID`, `TWITCH_APP_CLIENT_SECRET`
- `ADMIN_TWITCH_IDS`
- `TWITCH_BOT_CLIENT_ID`, `TWITCH_BOT_ACCESS_TOKEN`, `TWITCH_BOT_REFRESH_TOKEN`
- `TWITCH_BOT_USERNAME`, `TWITCH_BOT_OWNER_ID`
- `SIMLINK_INGEST_SECRET`
- `INTERNAL_JOB_SECRET`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`

Rules for agents:

- Never hardcode secrets.
- All secrets are server-side only (no browser exposure).
- Access environment variables through the config object in `src/milesandmorebot/env.ts`.
- Preserve the `INTERNAL_JOB_SECRET` header-based admin auth pattern.

## Cursor / Copilot Rules

- No `.cursorrules` file was found.
- No files were found under `.cursor/rules/`.
- No `.github/copilot-instructions.md` file was found.
- Do not invent extra editor-specific rules; follow the repository conventions documented here.

## TypeScript Rules

- Keep TypeScript strictness intact; do not weaken `tsconfig.json`.
- Module system is CommonJS — use standard `import` syntax (transpiled to CJS).
- Target is ES2022.
- Prefer explicit interfaces and type aliases for domain data.
- Use `import type` for type-only imports.
- Prefer `unknown` over `any`; narrow before use.
- Preserve wire-format field names exactly when they are snake_case (`channel_name`, `icao_from`, `participant_hash`, `flight_id`, etc.).
- Use camelCase for local variables, function parameters, and internal logic.
- Annotate public helpers and route handlers when the return type is not obvious.

## Imports

- No path aliases configured — use relative imports (`"./storage"`, `"../lib/types"`).
- Follow the existing grouping pattern:
  1. Node built-ins
  2. Third-party packages (`fastify`, `tmi.js`, `@upstash/redis`)
  3. Internal relative imports
- Keep type imports separate with `import type`.
- Remove unused imports immediately.

## Naming Conventions

- Functions: camelCase, verb-oriented (`handleJoinFlight`, `formatDistance`, `parseSeatConfig`).
- Interfaces and type aliases: PascalCase (`Flight`, `Participant`, `SeatConfig`).
- Constants: `UPPER_SNAKE_CASE` for module-level immutable values (`AIRCRAFT_DEFAULTS`, `TWITCH_API_BASE`).
- Wire-format / storage keys: snake_case to match Redis and frontend expectations.
- Bot command names: lowercase with `!` prefix in user-facing messages (`!join`, `!miles`, `!seat`).
- Internal chat messages and user-facing labels are German.

## Fastify / Server Conventions

- All routes are defined in `src/server.ts` using Fastify's route methods.
- Admin endpoints are protected by `x-internal-job-secret` header checked via `isAdminAuthorized()`.
- CORS is configured for the frontend origin.
- QStash webhook endpoints verify signatures using `@upstash/qstash` receiver, with fallback to `x-internal-job-secret`.
- OAuth callback routes handle both App OAuth (streamer authorizes channel) and Bot OAuth (bot client credentials).
- Use `reply.code(N).send(...)` for responses; do not mix response patterns.
- Register new routes in `server.ts` following the existing grouping (public, admin, webhooks, OAuth).

## Formatting

- Match the existing code style: semicolons, double quotes, trailing commas where the formatter would place them.
- Use 2-space indentation.
- Keep one blank line between logical sections; avoid excessive vertical whitespace.
- Prefer concise expressions, but do not collapse code so much that logic becomes hard to scan.

## Error Handling

- Throw `Error` objects for invalid configuration or failed external requests.
- Narrow caught values with `instanceof Error` before reading `.message`.
- Bot command errors are caught and logged via the Redis-backed logger; the bot continues running.
- External API failures (Twitch, QStash) are logged and gracefully degraded where possible.
- Never swallow errors silently unless stale-data fallback is intentional and harmless.

## API / Data Rules

- All Redis access goes through the `repositories` object in `src/milesandmorebot/storage.ts`.
- Do not access Redis directly from route handlers or bot commands — use repository methods.
- Match wire-format field names exactly (snake_case for stored and transmitted data).
- Extend shared types in `src/lib/types.ts` instead of creating duplicate inline types.
- Twitch API calls go through helpers in `src/milesandmorebot/twitch.ts`.
- QStash job publishing goes through `src/milesandmorebot/scheduler.ts`.

## Bot Command Conventions

- Commands are defined as `CommandDefinition` objects in `src/milesandmorebot/core.ts`.
- Each command has: name, aliases, description, permission level, cooldown, execute function.
- Permission levels: everyone, subscriber, moderator, broadcaster.
- Commands respond via `client.say()` for public messages or whisper helpers for private responses.
- Keep command responses concise and in German.
- Test commands manually in a Twitch chat before considering them complete.

## Editing Guidance For Agents

- Before changing behavior, inspect neighboring code and follow local patterns instead of introducing a new style.
- Keep comments sparse; add them only for non-obvious logic.
- Do not refactor unrelated areas while making a focused change.
- If you add a new route, register it in `server.ts` following the existing grouping.
- If you add a new bot command, add it to the commands array in `core.ts`.
- If you introduce a new command or workflow, update this file.
- If you add automated tests, document both the full suite command and the single-test command.
- Ignore `src/main.go` — it is a dead scaffold.

## Agent Tooling

The following MCP servers, plugins, and skills are available and should be used automatically when helpful:

- **context7** — Fetch current library/framework docs instead of relying on training data.
- **gh_grep** — Search real-world code examples from public GitHub repos.
- **code-index** — Symbol-aware local codebase navigation (functions, classes, imports).
- **local-rag** — Semantic search over ingested local documents.
- **exa web search** — General web search for current information or topics not covered elsewhere.
- **fetch** — Direct URL retrieval.
- **playwright** — Browser automation, screenshots, page snapshots for UI verification.
- **chrome-devtools** — DevTools inspection: network, console, performance, Lighthouse.
- **code-simplifier** — Invoke after implementation to refine code clarity and consistency.
- **context7-mcp skill** — Load when delegating tasks involving libraries or frameworks.
- **frontend-ui-ux skill** — Load for any visual or UI work.
- **git-master skill** — Load for any git operations.
- **dev-browser skill** — Load for browser automation tasks.

## Useful Reference Files

- `package.json`
- `tsconfig.json`
- `Dockerfile`
- `fly.toml`
- `.env.example`
- `src/lib/types.ts`
- `src/milesandmorebot/storage.ts`
- `src/milesandmorebot/core.ts`
- `src/milesandmorebot/env.ts`
- `src/server.ts`

## Bottom Line

- Use `npm`.
- Respect strict TypeScript and snake_case wire formats.
- Use relative imports and `import type` for type-only imports.
- All Redis access through `repositories` in `storage.ts`.
- All Twitch API access through helpers in `twitch.ts`.
- Routes in `server.ts`, commands in `core.ts`.
- No linter or test runner configured yet — call that out instead of inventing commands.
