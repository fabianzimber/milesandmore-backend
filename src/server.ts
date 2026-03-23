import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
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
  handleChatMessage,
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
  createChatMessageSubscription,
  deleteChatMessageSubscription,
  getBotRuntimeSettings,
  isFreshEventSubTimestamp,
  normalizeEventSubChatMessage,
  restartBotRuntime,
  verifyEventSubSignature,
} from "./milesandmorebot/twitch";
import { partIrcChannel } from "./milesandmorebot/irc";
import { verifyQStashRequest } from "./milesandmorebot/scheduler";
import type { Flight, ScheduledFlightJob } from "./lib/types";

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

export function createServer() {
  const app = Fastify({ logger: true });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && milesandmorebotEnv.appUrl && origin !== milesandmorebotEnv.appUrl) {
      reply.header("access-control-allow-origin", milesandmorebotEnv.appUrl);
    } else if (origin) {
      reply.header("access-control-allow-origin", origin);
    }
    reply.header("access-control-allow-headers", "content-type,x-internal-job-secret,x-simlink-secret");
    reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    if (request.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  app.get("/health", async () => ({ ok: true, service: "milesandmore-backend" }));

  app.get("/commands", async () => getCommandsMetadata());
  app.get("/flights", async (request) => getFlights((request.query as { status?: string }).status));
  app.get("/flights/:id", async (request) => getFlightById(Number((request.params as { id: string }).id)));
  app.get("/flights/:id/participants", async (request) => getFlightParticipants(Number((request.params as { id: string }).id)));
  app.get("/flights/:id/seats", async (request) => getOccupiedSeats(Number((request.params as { id: string }).id)));
  app.get("/participant/:hash", async (request, reply) => {
    const participant = await getParticipantByHash((request.params as { hash: string }).hash);
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
    return createFlight(parseJsonBody(request));
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

  app.post("/api/twitch/eventsub", async (request, reply) => {
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
    const headers = new Headers(Object.entries(request.headers).filter(([, value]) => typeof value === "string") as Array<[string, string]>);
    if (!verifyEventSubSignature(headers, rawBody) || !isFreshEventSubTimestamp(headers)) {
      return error(reply, "Invalid Twitch EventSub signature", 401);
    }

    const payload = JSON.parse(rawBody) as {
      challenge?: string;
      event?: Record<string, unknown>;
      subscription?: { id: string; type: string; status: string };
    };

    const messageType = headers.get("twitch-eventsub-message-type");
    if (messageType === "webhook_callback_verification") {
      return reply.type("text/plain").send(payload.challenge || "");
    }

    if (messageType === "revocation") {
      await milesandmorebotLogger.warn(`[EventSub] subscription revoked ${payload.subscription?.id || "unknown"}`);
      return { ok: true };
    }

    const messageId = headers.get("twitch-eventsub-message-id");
    if (!messageId) {
      return error(reply, "Missing Twitch message id", 400);
    }

    const firstSeen = await repositories.processedEvents.markProcessed(messageId);
    if (!firstSeen) {
      return { duplicate: true };
    }

    const chatMessage = normalizeEventSubChatMessage(payload as Parameters<typeof normalizeEventSubChatMessage>[0]);
    if (!chatMessage) {
      return { ignored: true };
    }

    await repositories.status.setLastEventAt();
    await handleChatMessage(chatMessage);
    return { ok: true };
  });

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
          `Streamer ${channelLogin} authorized channel:bot. Re-subscribing explicitly...`,
        );
        const success = await createChatMessageSubscription(channelLogin);
        if (success) {
          await partIrcChannel(channelLogin);
        }
      } else {
        await milesandmorebotLogger.info(
          `Streamer ${channelLogin} authorized channel:bot, but channel is not actively managed by bot.`,
        );
      }

      return reply.type("text/html").send(`<html>
  <body>
    <h1 style="font-family: sans-serif;">Erfolgreich!</h1>
    <p style="font-family: sans-serif;">MilesAndMore hat nun offizielle Rechte als \"Chat Bot\" in deinem Kanal <strong>${channelLogin}</strong>!</p>
    <p style="font-family: sans-serif;">Du kannst diesen Tab schliessen.</p>
  </body>
</html>`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unknown error";
      await milesandmorebotLogger.error(`Error processing callback for ${channelLogin}: ${message}`);
      return error(reply, "Internal Server Error", 500);
    }
  });

  return app;
}
