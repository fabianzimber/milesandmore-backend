"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const node_crypto_1 = __importDefault(require("node:crypto"));
const fastify_1 = __importDefault(require("fastify"));
const cookie_1 = __importDefault(require("@fastify/cookie"));
const core_1 = require("./milesandmorebot/core");
const env_1 = require("./milesandmorebot/env");
const logger_1 = require("./milesandmorebot/logger");
const storage_1 = require("./milesandmorebot/storage");
const twitch_1 = require("./milesandmorebot/twitch");
const irc_1 = require("./milesandmorebot/irc");
const scheduler_1 = require("./milesandmorebot/scheduler");
function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function parseJsonBody(request) {
    const body = request.body;
    if (typeof body === "string") {
        try {
            return JSON.parse(body);
        }
        catch {
            throw new SyntaxError("Invalid JSON body");
        }
    }
    return (body || {});
}
function error(reply, message, status = 400) {
    return reply.code(status).send({ error: message });
}
function toWebRequest(request, rawBody) {
    const protocol = request.headers["x-forwarded-proto"] || "http";
    const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
    const url = `${protocol}://${host}${request.url}`;
    return new Request(url, {
        method: request.method,
        headers: new Headers(Object.entries(request.headers).filter(([, value]) => typeof value === "string")),
        body: rawBody,
    });
}
function isAdminAuthorized(request) {
    const configured = env_1.milesandmorebotEnv.internalJobSecret;
    if (!configured) {
        return false;
    }
    return request.headers["x-internal-job-secret"] === configured;
}
async function requireAdmin(reply, request) {
    if (isAdminAuthorized(request)) {
        return true;
    }
    error(reply, "Unauthorized", 401);
    return false;
}
function createServer() {
    const app = (0, fastify_1.default)({ logger: true });
    app.register(cookie_1.default, { secret: env_1.milesandmorebotEnv.authSecret });
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
        done(null, body);
    });
    app.setErrorHandler(async (err, _request, reply) => {
        if (err instanceof SyntaxError) {
            return reply.code(400).send({ error: err.message || "Invalid JSON body" });
        }
        const statusCode = "statusCode" in err ? err.statusCode : 500;
        const message = err instanceof Error ? err.message : "Internal Server Error";
        return reply.code(statusCode).send({ error: message });
    });
    app.addHook("onRequest", async (request, reply) => {
        const origin = request.headers.origin;
        const allowedOrigin = env_1.milesandmorebotEnv.frontendUrl || env_1.milesandmorebotEnv.appUrl;
        if (origin) {
            if (!allowedOrigin || origin === allowedOrigin || origin === env_1.milesandmorebotEnv.appUrl) {
                reply.header("access-control-allow-origin", origin);
            }
        }
        reply.header("access-control-allow-headers", "content-type,x-internal-job-secret,x-simlink-secret");
        reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
        reply.header("access-control-allow-credentials", "true");
        if (request.method === "OPTIONS") {
            return reply.code(204).send();
        }
    });
    app.get("/health", async () => ({ ok: true, service: "milesandmore-backend" }));
    app.get("/commands", async () => (0, core_1.getCommandsMetadata)());
    app.get("/flights", async (request) => (0, core_1.getFlights)(request.query.status));
    app.get("/flights/:id", async (request) => (0, core_1.getFlightById)(Number(request.params.id)));
    app.get("/flights/:id/participants", async (request) => (0, core_1.getFlightParticipants)(Number(request.params.id)));
    app.get("/flights/:id/seats", async (request) => (0, core_1.getOccupiedSeats)(Number(request.params.id)));
    app.get("/participant/:hash", async (request, reply) => {
        const hash = request.params.hash;
        const participant = await (0, core_1.getParticipantByHash)(hash);
        if (!participant) {
            return error(reply, "Participant not found", 404);
        }
        return participant;
    });
    app.get("/channels", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        return storage_1.repositories.managedChannels.getAll();
    });
    app.post("/channels", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        const body = parseJsonBody(request);
        if (!body.channel_name) {
            return error(reply, "channel_name required");
        }
        try {
            return await (0, core_1.addManagedChannel)(body.channel_name);
        }
        catch (cause) {
            return error(reply, cause instanceof Error ? cause.message : "Channel konnte nicht aktiviert werden.");
        }
    });
    app.delete("/channels/:name", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        await (0, core_1.removeManagedChannel)(request.params.name);
        return { success: true };
    });
    app.get("/bot/logs", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        const limit = Number(request.query.limit || "100");
        return (0, logger_1.getRecentBotLogs)(limit);
    });
    app.get("/bot/status", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        return storage_1.repositories.status.get();
    });
    app.get("/bot/settings", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        return (0, twitch_1.getBotRuntimeSettings)();
    });
    app.post("/bot/restart", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        return (0, twitch_1.restartBotRuntime)();
    });
    app.get("/leaderboard/countries", async () => (0, core_1.getCountryLeaderboard)());
    app.get("/leaderboard/miles", async () => (0, core_1.getMilesLeaderboard)());
    app.get("/user/:id/stats", async (request) => (0, core_1.getUserStats)(request.params.id));
    app.post("/simbrief/import", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        const body = parseJsonBody(request);
        if (!body.pilotId) {
            return error(reply, "pilotId required");
        }
        return (0, core_1.fetchSimBriefFlightPlan)(body.pilotId);
    });
    app.post("/aircraft-configs", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        const body = parseJsonBody(request);
        if (!body.icaoCode || !body.name || !body.seatConfig || !body.totalSeats) {
            return error(reply, "Missing aircraft config fields");
        }
        await (0, core_1.saveAircraftConfig)(body.icaoCode, body.name, body.seatConfig, body.totalSeats);
        return { success: true };
    });
    app.post("/flights", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        try {
            return await (0, core_1.createFlight)(parseJsonBody(request));
        }
        catch (cause) {
            return error(reply, cause instanceof Error ? cause.message : "Flight konnte nicht erstellt werden.");
        }
    });
    app.post("/flights/:id/status", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        const flightId = Number(request.params.id);
        const body = parseJsonBody(request);
        if (!body.status) {
            return error(reply, "status required");
        }
        const updated = await (0, core_1.updateFlightStatus)(flightId, body.status);
        if (!updated) {
            return error(reply, "Flight not found", 404);
        }
        if (body.status === "completed") {
            return { status: body.status, rewards: await (0, core_1.awardFlightRewards)(flightId) };
        }
        return { status: body.status };
    });
    app.post("/flights/:id/resume-boarding", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        const body = parseJsonBody(request);
        return (0, core_1.resumeBoarding)(Number(request.params.id), body.extraMinutes || 5);
    });
    app.post("/flights/:id/resume-flight", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        return (0, core_1.resumeFlight)(Number(request.params.id));
    });
    app.post("/flights/:id/assign-seats", async (request, reply) => {
        if (!(await requireAdmin(reply, request)))
            return;
        return (0, core_1.assignSeats)(Number(request.params.id));
    });
    app.post("/seats/change", async (request, reply) => {
        const body = parseJsonBody(request);
        if (!body.participant_hash || !body.new_seat) {
            return error(reply, "participant_hash and new_seat required");
        }
        try {
            return await (0, core_1.changeSeat)(body.participant_hash, body.new_seat);
        }
        catch (cause) {
            return error(reply, cause instanceof Error ? cause.message : "Seat change failed");
        }
    });
    app.post("/simlink/connect", async () => ({ connected: true }));
    app.post("/simlink/disconnect", async () => ({ connected: false }));
    app.get("/simlink/status", async () => storage_1.repositories.simlink.getStatus());
    app.post("/api/simlink/ingest", async (request, reply) => {
        if (request.headers["x-simlink-secret"] !== env_1.milesandmorebotEnv.simlinkIngestSecret) {
            return error(reply, "Unauthorized", 401);
        }
        return (0, core_1.handleSimLinkIngest)(parseJsonBody(request));
    });
    app.post("/api/internal/jobs/boarding-warning", async (request, reply) => {
        const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
        const authorized = await (0, scheduler_1.verifyQStashRequest)(toWebRequest(request, raw));
        if (!authorized) {
            return error(reply, "Unauthorized", 401);
        }
        try {
            const body = parseJsonBody(request);
            await (0, core_1.sendBoardingWarningJob)(body.flightId, body.channelName, body.warningMinutes, body.lifecycleVersion);
            return { ok: true };
        }
        catch (cause) {
            return error(reply, cause instanceof Error ? cause.message : "Failed to run boarding warning job", 500);
        }
    });
    app.post("/api/internal/jobs/boarding-close", async (request, reply) => {
        const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
        const authorized = await (0, scheduler_1.verifyQStashRequest)(toWebRequest(request, raw));
        if (!authorized) {
            return error(reply, "Unauthorized", 401);
        }
        try {
            const body = parseJsonBody(request);
            await (0, core_1.finishBoardingJob)(body.flightId, body.channelName, body.lifecycleVersion);
            return { ok: true };
        }
        catch (cause) {
            return error(reply, cause instanceof Error ? cause.message : "Failed to run boarding close job", 500);
        }
    });
    // ── Streamer OAuth ────────────────────────────────────────────────
    app.get("/api/twitch/authorize", async (request, reply) => {
        const state = node_crypto_1.default.randomUUID();
        reply.setCookie("twitch_oauth_state", state, {
            path: "/",
            httpOnly: true,
            signed: true,
            secure: env_1.milesandmorebotEnv.appUrl.startsWith("https"),
            sameSite: "lax",
            maxAge: 600,
        });
        const url = new URL(`${env_1.milesandmorebotEnv.appUrl}${request.url}`);
        const redirectUri = new URL("/api/twitch/callback", url.origin).toString();
        const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
        authUrl.searchParams.set("client_id", env_1.milesandmorebotEnv.twitchAppClientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", "channel:bot");
        authUrl.searchParams.set("force_verify", "true");
        authUrl.searchParams.set("state", state);
        return reply.redirect(authUrl.toString());
    });
    app.get("/api/twitch/callback", async (request, reply) => {
        const qs = request.query;
        if (qs.error) {
            return error(reply, qs.error, 400);
        }
        if (!qs.code) {
            return error(reply, "Missing code parameter", 400);
        }
        const cookieValue = request.cookies.twitch_oauth_state;
        const unsigned = cookieValue ? request.unsignCookie(cookieValue) : { valid: false, value: null };
        reply.clearCookie("twitch_oauth_state", { path: "/" });
        if (!unsigned.valid || unsigned.value !== qs.state) {
            return error(reply, "Invalid or missing OAuth state", 403);
        }
        const url = new URL(`${env_1.milesandmorebotEnv.appUrl}${request.url}`);
        const redirectUri = new URL("/api/twitch/callback", url.origin).toString();
        const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: env_1.milesandmorebotEnv.twitchAppClientId,
                client_secret: env_1.milesandmorebotEnv.twitchAppClientSecret,
                code: qs.code,
                grant_type: "authorization_code",
                redirect_uri: redirectUri,
            }),
        });
        if (!tokenResponse.ok) {
            return error(reply, "Failed to exchange token", 400);
        }
        const tokenData = (await tokenResponse.json());
        const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
            headers: { Authorization: `OAuth ${tokenData.access_token}` },
        });
        if (!validateResponse.ok) {
            return error(reply, "Failed to validate token", 400);
        }
        const validateData = (await validateResponse.json());
        const channelLogin = validateData.login;
        try {
            const currentChannels = await storage_1.repositories.managedChannels.getAll();
            if (currentChannels.find((channel) => channel.channel_name === channelLogin)) {
                await logger_1.milesandmorebotLogger.info(`Streamer ${channelLogin} authorized channel:bot. Ensuring IRC connection...`);
                await (0, irc_1.joinIrcChannel)(channelLogin);
            }
            else {
                await logger_1.milesandmorebotLogger.info(`Streamer ${channelLogin} authorized channel:bot, but channel is not actively managed by bot.`);
            }
            return reply.type("text/html").send(`<html>
  <body>
    <h1 style="font-family: sans-serif;">Erfolgreich!</h1>
    <p style="font-family: sans-serif;">Miles &amp; More hat nun offizielle Rechte als &quot;Chat Bot&quot; in deinem Kanal <strong>${escapeHtml(channelLogin)}</strong>!</p>
    <p style="font-family: sans-serif;">Du kannst diesen Tab schliessen.</p>
  </body>
</html>`);
        }
        catch (cause) {
            const message = cause instanceof Error ? cause.message : "Unknown error";
            await logger_1.milesandmorebotLogger.error(`Error processing callback for ${channelLogin}: ${message}`);
            return error(reply, "Internal Server Error", 500);
        }
    });
    // Separate bot authorization flow using the BOT client ID.
    // Broadcasters must authorize channel:bot against the bot's own application
    // so Twitch associates the permission with the bot's client ID.
    app.get("/api/twitch/bot-authorize", async (request, reply) => {
        const botClientId = env_1.milesandmorebotEnv.twitchBotClientId;
        if (!botClientId) {
            return error(reply, "TWITCH_BOT_CLIENT_ID is not configured", 500);
        }
        const state = node_crypto_1.default.randomUUID();
        reply.setCookie("twitch_bot_oauth_state", state, {
            path: "/",
            httpOnly: true,
            signed: true,
            secure: env_1.milesandmorebotEnv.appUrl.startsWith("https"),
            sameSite: "lax",
            maxAge: 600,
        });
        const url = new URL(`${env_1.milesandmorebotEnv.appUrl}${request.url}`);
        const redirectUri = new URL("/api/twitch/bot-callback", url.origin).toString();
        const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
        authUrl.searchParams.set("client_id", botClientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", "channel:bot");
        authUrl.searchParams.set("force_verify", "true");
        authUrl.searchParams.set("state", state);
        return reply.redirect(authUrl.toString());
    });
    app.get("/api/twitch/bot-callback", async (request, reply) => {
        const qs = request.query;
        if (qs.error) {
            return error(reply, qs.error, 400);
        }
        if (!qs.code) {
            return error(reply, "Missing code parameter", 400);
        }
        const cookieValue = request.cookies.twitch_bot_oauth_state;
        const unsigned = cookieValue ? request.unsignCookie(cookieValue) : { valid: false, value: null };
        reply.clearCookie("twitch_bot_oauth_state", { path: "/" });
        if (!unsigned.valid || unsigned.value !== qs.state) {
            return error(reply, "Invalid or missing OAuth state", 403);
        }
        const botClientId = env_1.milesandmorebotEnv.twitchBotClientId;
        const botClientSecret = env_1.milesandmorebotEnv.twitchBotClientSecret;
        if (!botClientId || !botClientSecret) {
            return error(reply, "TWITCH_BOT_CLIENT_ID and TWITCH_BOT_CLIENT_SECRET must be configured", 500);
        }
        const url = new URL(`${env_1.milesandmorebotEnv.appUrl}${request.url}`);
        const redirectUri = new URL("/api/twitch/bot-callback", url.origin).toString();
        const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: botClientId,
                client_secret: botClientSecret,
                code: qs.code,
                grant_type: "authorization_code",
                redirect_uri: redirectUri,
            }),
        });
        if (!tokenResponse.ok) {
            return error(reply, "Failed to exchange token", 400);
        }
        const tokenData = (await tokenResponse.json());
        const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
            headers: { Authorization: `OAuth ${tokenData.access_token}` },
        });
        if (!validateResponse.ok) {
            return error(reply, "Failed to validate token", 400);
        }
        const validateData = (await validateResponse.json());
        const channelLogin = validateData.login;
        try {
            await logger_1.milesandmorebotLogger.info(`[BotAuth] Streamer ${channelLogin} authorized channel:bot for bot application.`);
            const currentChannels = await storage_1.repositories.managedChannels.getAll();
            if (currentChannels.find((channel) => channel.channel_name === channelLogin)) {
                await (0, irc_1.joinIrcChannel)(channelLogin);
            }
            else {
                await logger_1.milesandmorebotLogger.info(`[BotAuth] Channel ${channelLogin} is not actively managed.`);
            }
            return reply.type("text/html").send(`<html>
  <body>
    <h1 style="font-family: sans-serif;">Erfolgreich!</h1>
    <p style="font-family: sans-serif;">Miles &amp; More hat nun offizielle Rechte als &quot;Chat Bot&quot; in deinem Kanal <strong>${escapeHtml(channelLogin)}</strong>!</p>
    <p style="font-family: sans-serif;">Du kannst diesen Tab schliessen.</p>
  </body>
</html>`);
        }
        catch (cause) {
            const message = cause instanceof Error ? cause.message : "Unknown error";
            await logger_1.milesandmorebotLogger.error(`[BotAuth] Error processing bot-callback for ${channelLogin}: ${message}`);
            return error(reply, "Internal Server Error", 500);
        }
    });
    return app;
}
