import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import {
  addManagedChannel,
  assignSeats,
  awardFlightRewards,
  changeSeat,
  createFlight,
  fetchSimBriefFlightPlan,
  finishBoardingJob,
  getCommandsMetadata,
  getCountryLeaderboard,
  getFlightById,
  getFlightParticipants,
  getFlights,
  getMilesLeaderboard,
  getOccupiedSeats,
  getParticipantByHash,
  getUserStats,
  handleSimLinkIngest,
  removeManagedChannel,
  resumeBoarding,
  resumeFlight,
  saveAircraftConfig,
  sendBoardingWarningJob,
  updateFlightStatus,
} from "./milesandmorebot/core";
import { milesandmorebotEnv } from "./milesandmorebot/env";
import { getRecentBotLogs, milesandmorebotLogger } from "./milesandmorebot/logger";
import { repositories } from "./milesandmorebot/storage";
import {
  getBotRuntimeSettings,
  restartBotRuntime,
} from "./milesandmorebot/twitch";
import { joinIrcChannel } from "./milesandmorebot/irc";
import { verifyQStashRequest } from "./milesandmorebot/scheduler";
import type { Flight, ScheduledFlightJob } from "./lib/types";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseJsonBody<T>(request: FastifyRequest): T {
  const body = request.body;
  if (typeof body === "string") {
    return JSON.parse(body) as T;
  }
  return (body || {}) as T;
}

function error(reply: FastifyReply, message: string, status = 400) {
  return reply.code(status).send({ error: message });
}

function toWebRequest(request: FastifyRequest, rawBody?: string): Request {
  const protocol = (request.headers["x-forwarded-proto"] as string | undefined) || "http";
  const host = (request.headers["x-forwarded-host"] as string | undefined) || request.headers.host || "localhost";
  const url = `${protocol}://${host}${request.url}`;
  return new Request(url, {
    method: request.method,
    headers: new Headers(Object.entries(request.headers).filter(([, value]) => typeof value === "string") as Array<[string, string]>),
    body: rawBody,
  });
}

function isAdminAuthorized(request: FastifyRequest): boolean {
  const configured = milesandmorebotEnv.internalJobSecret;
  if (!configured) {
    return true;
  }
  return request.headers["x-internal-job-secret"] === configured;
}

async function requireAdmin(reply: FastifyReply, request: FastifyRequest): Promise<boolean> {
  if (isAdminAuthorized(request)) {
    return true;
  }
  error(reply, "Unauthorized", 401);
  return false;
}

async function requirePassengerAuth(request: FastifyRequest, reply: FastifyReply, hash: string): Promise<boolean> {
  const raw = request.cookies?.passenger_session;
  if (!raw) {
    error(reply, "Nicht eingeloggt", 401);
    return false;
  }
  const unsigned = (request as any).unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) {
    error(reply, "Ungültige Session", 401);
    return false;
  }
  let session: { user_id: string; hash: string };
  try {
    session = JSON.parse(unsigned.value);
  } catch {
    error(reply, "Ungültige Session", 401);
    return false;
  }
  const participant = await repositories.participants.getByHash(hash);
  if (!participant || participant.user_id !== session.user_id) {
    error(reply, "Kein Zugriff", 403);
    return false;
  }
  return true;
}

export function createServer() {
  const app = Fastify({ logger: true });

  app.register(cookie, { secret: milesandmorebotEnv.authSecret });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const allowedOrigin = milesandmorebotEnv.frontendUrl || milesandmorebotEnv.appUrl;
    if (origin) {
      if (!allowedOrigin || origin === allowedOrigin || origin === milesandmorebotEnv.appUrl) {
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

  app.get("/commands", async () => getCommandsMetadata());
  app.get("/flights", async (request) => getFlights((request.query as { status?: string }).status));
  app.get("/flights/:id", async (request) => getFlightById(Number((request.params as { id: string }).id)));
  app.get("/flights/:id/participants", async (request) => getFlightParticipants(Number((request.params as { id: string }).id)));
  app.get("/flights/:id/seats", async (request) => getOccupiedSeats(Number((request.params as { id: string }).id)));
  app.get("/participant/:hash", async (request, reply) => {
    const hash = (request.params as { hash: string }).hash;
    const participant = await getParticipantByHash(hash);
    if (!participant) {
      return error(reply, "Participant not found", 404);
    }
    return participant;
  });

  app.get("/channels", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    return repositories.managedChannels.getAll();
  });
  app.post("/channels", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    const body = parseJsonBody<{ channel_name?: string }>(request);
    if (!body.channel_name) {
      return error(reply, "channel_name required");
    }
    try {
      return await addManagedChannel(body.channel_name);
    } catch (cause) {
      return error(reply, cause instanceof Error ? cause.message : "Channel konnte nicht aktiviert werden.");
    }
  });
  app.delete("/channels/:name", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    await removeManagedChannel((request.params as { name: string }).name);
    return { success: true };
  });

  app.get("/bot/logs", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    const limit = Number((request.query as { limit?: string }).limit || "100");
    return getRecentBotLogs(limit);
  });
  app.get("/bot/status", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    return repositories.status.get();
  });
  app.get("/bot/settings", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    return getBotRuntimeSettings();
  });
  app.post("/bot/restart", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    return restartBotRuntime();
  });

  app.get("/leaderboard/countries", async () => getCountryLeaderboard());
  app.get("/leaderboard/miles", async () => getMilesLeaderboard());
  app.get("/user/:id/stats", async (request) => getUserStats((request.params as { id: string }).id));

  app.post("/simbrief/import", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    const body = parseJsonBody<{ pilotId?: string }>(request);
    if (!body.pilotId) {
      return error(reply, "pilotId required");
    }
    return fetchSimBriefFlightPlan(body.pilotId);
  });

  app.post("/aircraft-configs", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    const body = parseJsonBody<{ icaoCode?: string; name?: string; seatConfig?: string; totalSeats?: number }>(request);
    if (!body.icaoCode || !body.name || !body.seatConfig || !body.totalSeats) {
      return error(reply, "Missing aircraft config fields");
    }
    await saveAircraftConfig(body.icaoCode, body.name, body.seatConfig, body.totalSeats);
    return { success: true };
  });

  app.post("/flights", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    try {
      return await createFlight(parseJsonBody(request));
    } catch (cause) {
      return error(reply, cause instanceof Error ? cause.message : "Flight konnte nicht erstellt werden.");
    }
  });
  app.post("/flights/:id/status", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    const flightId = Number((request.params as { id: string }).id);
    const body = parseJsonBody<{ status?: Flight["status"] }>(request);
    if (!body.status) {
      return error(reply, "status required");
    }
    const updated = await updateFlightStatus(flightId, body.status);
    if (!updated) {
      return error(reply, "Flight not found", 404);
    }
    if (body.status === "completed") {
      return { status: body.status, rewards: await awardFlightRewards(flightId) };
    }
    return { status: body.status };
  });
  app.post("/flights/:id/resume-boarding", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    const body = parseJsonBody<{ extraMinutes?: number }>(request);
    return resumeBoarding(Number((request.params as { id: string }).id), body.extraMinutes || 5);
  });
  app.post("/flights/:id/resume-flight", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    return resumeFlight(Number((request.params as { id: string }).id));
  });
  app.post("/flights/:id/assign-seats", async (request, reply) => {
    if (!(await requireAdmin(reply, request))) return;
    return assignSeats(Number((request.params as { id: string }).id));
  });

  app.post("/seats/change", async (request, reply) => {
    const body = parseJsonBody<{ participant_hash?: string; new_seat?: string }>(request);
    if (!body.participant_hash || !body.new_seat) {
      return error(reply, "participant_hash and new_seat required");
    }
    if (!(await requirePassengerAuth(request, reply, body.participant_hash))) return;
    try {
      return await changeSeat(body.participant_hash, body.new_seat);
    } catch (cause) {
      return error(reply, cause instanceof Error ? cause.message : "Seat change failed");
    }
  });

  app.post("/simlink/connect", async () => ({ connected: true }));
  app.post("/simlink/disconnect", async () => ({ connected: false }));
  app.get("/simlink/status", async () => repositories.simlink.getStatus());

  app.post("/api/simlink/ingest", async (request, reply) => {
    if (request.headers["x-simlink-secret"] !== milesandmorebotEnv.simlinkIngestSecret) {
      return error(reply, "Unauthorized", 401);
    }
    return handleSimLinkIngest(parseJsonBody(request));
  });

  app.post("/api/internal/jobs/boarding-warning", async (request, reply) => {
    const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
    const authorized = await verifyQStashRequest(toWebRequest(request, raw));
    if (!authorized) {
      return error(reply, "Unauthorized", 401);
    }
    try {
      const body = parseJsonBody<ScheduledFlightJob>(request);
      await sendBoardingWarningJob(body.flightId, body.channelName, body.warningMinutes, body.lifecycleVersion);
      return { ok: true };
    } catch (cause) {
      return error(reply, cause instanceof Error ? cause.message : "Failed to run boarding warning job", 500);
    }
  });

  app.post("/api/internal/jobs/boarding-close", async (request, reply) => {
    const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
    const authorized = await verifyQStashRequest(toWebRequest(request, raw));
    if (!authorized) {
      return error(reply, "Unauthorized", 401);
    }
    try {
      const body = parseJsonBody<ScheduledFlightJob>(request);
      await finishBoardingJob(body.flightId, body.channelName, body.lifecycleVersion);
      return { ok: true };
    } catch (cause) {
      return error(reply, cause instanceof Error ? cause.message : "Failed to run boarding close job", 500);
    }
  });

  // ── Passenger OAuth ────────────────────────────────────────────────

  app.get("/api/passenger/session", async (request) => {
    const raw = request.cookies?.passenger_session;
    if (!raw) return { authenticated: false };
    const unsigned = (request as any).unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return { authenticated: false };
    try {
      const session = JSON.parse(unsigned.value) as { user_id: string; hash: string };
      return { authenticated: true, user_id: session.user_id, hash: session.hash };
    } catch {
      return { authenticated: false };
    }
  });

  app.get("/api/twitch/passenger/authorize", async (request, reply) => {
    const hash = (request.query as { hash?: string }).hash;
    if (!hash) {
      return error(reply, "hash query parameter required");
    }
    const participant = await repositories.participants.getByHash(hash);
    if (!participant) {
      return error(reply, "Participant not found", 404);
    }
    const url = new URL(`${milesandmorebotEnv.appUrl}${request.url}`);
    const redirectUri = new URL("/api/twitch/passenger/callback", url.origin).toString();
    const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
    authUrl.searchParams.set("client_id", milesandmorebotEnv.twitchAppClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "");
    authUrl.searchParams.set("state", hash);
    authUrl.searchParams.set("force_verify", "true");
    return reply.redirect(authUrl.toString());
  });

  app.get("/api/twitch/passenger/callback", async (request, reply) => {
    const qs = request.query as { code?: string; error?: string; state?: string };
    if (qs.error) {
      return error(reply, qs.error, 400);
    }
    if (!qs.code || !qs.state) {
      return error(reply, "Missing code or state parameter", 400);
    }

    const participantHash = qs.state;
    const participant = await repositories.participants.getByHash(participantHash);
    if (!participant) {
      return error(reply, "Participant not found", 404);
    }

    const url = new URL(`${milesandmorebotEnv.appUrl}${request.url}`);
    const redirectUri = new URL("/api/twitch/passenger/callback", url.origin).toString();

    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: milesandmorebotEnv.twitchAppClientId,
        client_secret: milesandmorebotEnv.twitchAppClientSecret,
        code: qs.code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      return error(reply, "Token-Austausch fehlgeschlagen", 400);
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string };
    const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${tokenData.access_token}` },
    });

    if (!validateResponse.ok) {
      return error(reply, "Token-Validierung fehlgeschlagen", 400);
    }

    const validateData = (await validateResponse.json()) as { user_id: string; login: string };

    if (validateData.user_id !== participant.user_id) {
      return reply.type("text/html").code(403).send(`<html>
  <body style="font-family: sans-serif; text-align: center; margin-top: 80px;">
    <h1>Zugriff verweigert</h1>
    <p>Dein Twitch-Account <strong>${escapeHtml(validateData.login)}</strong> stimmt nicht mit dem Passagier überein.</p>
    <p>Bitte logge dich mit dem richtigen Account ein.</p>
  </body>
</html>`);
    }

    const sessionValue = JSON.stringify({ user_id: validateData.user_id, hash: participantHash });
    const frontendTarget = `${milesandmorebotEnv.frontendUrl || milesandmorebotEnv.appUrl}/flight/${participantHash}`;

    return reply
      .setCookie("passenger_session", sessionValue, {
        path: "/",
        signed: true,
        httpOnly: true,
        secure: milesandmorebotEnv.appUrl.startsWith("https"),
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7, // 7 days
      })
      .redirect(frontendTarget);
  });

  // ── Streamer OAuth ────────────────────────────────────────────────

  app.get("/api/twitch/authorize", async (request, reply) => {
    const url = new URL(`${milesandmorebotEnv.appUrl}${request.url}`);
    const redirectUri = new URL("/api/twitch/callback", url.origin).toString();
    const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
    authUrl.searchParams.set("client_id", milesandmorebotEnv.twitchAppClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "channel:bot");
    authUrl.searchParams.set("force_verify", "true");
    return reply.redirect(authUrl.toString());
  });

  app.get("/api/twitch/callback", async (request, reply) => {
    const qs = request.query as { code?: string; error?: string };
    if (qs.error) {
      return error(reply, qs.error, 400);
    }
    if (!qs.code) {
      return error(reply, "Missing code parameter", 400);
    }

    const url = new URL(`${milesandmorebotEnv.appUrl}${request.url}`);
    const redirectUri = new URL("/api/twitch/callback", url.origin).toString();

    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: milesandmorebotEnv.twitchAppClientId,
        client_secret: milesandmorebotEnv.twitchAppClientSecret,
        code: qs.code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      return error(reply, "Failed to exchange token", 400);
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string };
    const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${tokenData.access_token}` },
    });

    if (!validateResponse.ok) {
      return error(reply, "Failed to validate token", 400);
    }

    const validateData = (await validateResponse.json()) as { login: string };
    const channelLogin = validateData.login;
    try {
      const currentChannels = await repositories.managedChannels.getAll();
      if (currentChannels.find((channel) => channel.channel_name === channelLogin)) {
        await milesandmorebotLogger.info(
          `Streamer ${channelLogin} authorized channel:bot. Ensuring IRC connection...`,
        );
        await joinIrcChannel(channelLogin);
      } else {
        await milesandmorebotLogger.info(
          `Streamer ${channelLogin} authorized channel:bot, but channel is not actively managed by bot.`,
        );
      }

      return reply.type("text/html").send(`<html>
  <body>
    <h1 style="font-family: sans-serif;">Erfolgreich!</h1>
    <p style="font-family: sans-serif;">Miles &amp; More hat nun offizielle Rechte als &quot;Chat Bot&quot; in deinem Kanal <strong>${escapeHtml(channelLogin)}</strong>!</p>
    <p style="font-family: sans-serif;">Du kannst diesen Tab schliessen.</p>
  </body>
</html>`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unknown error";
      await milesandmorebotLogger.error(`Error processing callback for ${channelLogin}: ${message}`);
      return error(reply, "Internal Server Error", 500);
    }
  });

  // Separate bot authorization flow using the BOT client ID.
  // Broadcasters must authorize channel:bot against the bot's own application
  // so Twitch associates the permission with the bot's client ID.
  app.get("/api/twitch/bot-authorize", async (request, reply) => {
    const botClientId = milesandmorebotEnv.twitchBotClientId;
    if (!botClientId) {
      return error(reply, "TWITCH_BOT_CLIENT_ID is not configured", 500);
    }
    const url = new URL(`${milesandmorebotEnv.appUrl}${request.url}`);
    const redirectUri = new URL("/api/twitch/bot-callback", url.origin).toString();
    const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
    authUrl.searchParams.set("client_id", botClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "channel:bot");
    authUrl.searchParams.set("force_verify", "true");
    return reply.redirect(authUrl.toString());
  });

  app.get("/api/twitch/bot-callback", async (request, reply) => {
    const qs = request.query as { code?: string; error?: string };
    if (qs.error) {
      return error(reply, qs.error, 400);
    }
    if (!qs.code) {
      return error(reply, "Missing code parameter", 400);
    }

    const botClientId = milesandmorebotEnv.twitchBotClientId;
    const botClientSecret = milesandmorebotEnv.twitchBotClientSecret;
    if (!botClientId || !botClientSecret) {
      return error(reply, "TWITCH_BOT_CLIENT_ID and TWITCH_BOT_CLIENT_SECRET must be configured", 500);
    }

    const url = new URL(`${milesandmorebotEnv.appUrl}${request.url}`);
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

    const tokenData = (await tokenResponse.json()) as { access_token: string };
    const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${tokenData.access_token}` },
    });

    if (!validateResponse.ok) {
      return error(reply, "Failed to validate token", 400);
    }

    const validateData = (await validateResponse.json()) as { login: string };
    const channelLogin = validateData.login;

    try {
      await milesandmorebotLogger.info(
        `[BotAuth] Streamer ${channelLogin} authorized channel:bot for bot application.`,
      );

      const currentChannels = await repositories.managedChannels.getAll();
      if (currentChannels.find((channel) => channel.channel_name === channelLogin)) {
        await joinIrcChannel(channelLogin);
      } else {
        await milesandmorebotLogger.info(
          `[BotAuth] Channel ${channelLogin} is not actively managed.`,
        );
      }

      return reply.type("text/html").send(`<html>
  <body>
    <h1 style="font-family: sans-serif;">Erfolgreich!</h1>
    <p style="font-family: sans-serif;">Miles &amp; More hat nun offizielle Rechte als &quot;Chat Bot&quot; in deinem Kanal <strong>${escapeHtml(channelLogin)}</strong>!</p>
    <p style="font-family: sans-serif;">Du kannst diesen Tab schliessen.</p>
  </body>
</html>`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unknown error";
      await milesandmorebotLogger.error(`[BotAuth] Error processing bot-callback for ${channelLogin}: ${message}`);
      return error(reply, "Internal Server Error", 500);
    }
  });

  return app;
}
