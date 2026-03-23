import crypto from "node:crypto";
import type { BotRuntimeSettings, TwitchChatMessage } from "../lib/types";
import { assertEnv, milesandmorebotEnv } from "./env";
import { milesandmorebotLogger } from "./logger";
import { repositories } from "./storage";

type TwitchUser = {
  id: string;
  login: string;
  display_name: string;
};

type TwitchValidateResponse = {
  client_id: string;
  login: string;
  user_id: string;
  scopes: string[];
};

type TwitchAppAccessTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

type EventSubWebhookPayload = {
  subscription?: {
    id: string;
    type: string;
    version: string;
    status: string;
    condition?: {
      broadcaster_user_id?: string;
      user_id?: string;
    };
    transport?: {
      method: string;
      callback?: string;
    };
    created_at?: string;
  };
  challenge?: string;
  event?: Record<string, unknown>;
};

type BotRuntimeCredentials = {
  botClientId: string;
  accessToken: string;
  refreshToken: string;
  source: "env" | "redis";
  updatedAt: number | null;
  botUserId?: string;
  botUsername?: string;
  botDisplayName?: string;
  scopes?: string[];
};

type BotCredentialInspection = {
  appClientId: string;
  botClientId: string;
  accessToken: string;
  refreshToken: string;
  tokenPreview: string;
  source: "env" | "redis";
  updatedAt: number | null;
  botUserId?: string;
  botUsername?: string;
  botDisplayName?: string;
  scopes: string[];
  credentialsValid: boolean;
  requiredScopesOk: boolean;
  refreshConfigured: boolean;
  issues: string[];
};

type SubscriptionSyncError = {
  channelName: string;
  reason: string;
};

class TwitchRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TwitchRequestError";
  }
}

const TWITCH_API_BASE = "https://api.twitch.tv/helix";
const TWITCH_OAUTH_BASE = "https://id.twitch.tv/oauth2";
const REQUIRED_BOT_SCOPES = ["user:bot", "user:read:chat", "user:write:chat"] as const;

let appAccessTokenCache:
  | {
      token: string;
      expiresAt: number;
    }
  | null = null;

function clearAppAccessTokenCache() {
  appAccessTokenCache = null;
}

function normalizeAccessToken(token: string): string {
  return token.trim().replace(/^oauth:/i, "");
}

function normalizeRefreshToken(token: string): string {
  return token.trim();
}

function maskToken(token: string): string {
  if (!token) {
    return "";
  }
  if (token.length <= 10) {
    return `${token.slice(0, 2)}***`;
  }
  return `${token.slice(0, 5)}...${token.slice(-4)}`;
}

function getAppCredentialSnapshot() {
  return {
    clientId: (milesandmorebotEnv.twitchAppClientId || "").trim(),
    clientSecret: (milesandmorebotEnv.twitchAppClientSecret || "").trim(),
  };
}

function getEnvBotCredentialSnapshot() {
  return {
    botClientId: (milesandmorebotEnv.twitchBotClientId || "").trim(),
    accessToken: normalizeAccessToken(milesandmorebotEnv.twitchBotAccessToken),
    refreshToken: normalizeRefreshToken(milesandmorebotEnv.twitchBotRefreshToken),
  };
}

function hasCompleteBotCredentials(
  credentials: Pick<BotRuntimeCredentials, "botClientId" | "accessToken"> | null | undefined,
): credentials is Pick<BotRuntimeCredentials, "botClientId" | "accessToken"> {
  return !!credentials?.botClientId && !!credentials.accessToken;
}

async function getStoredBotCredentials(): Promise<BotRuntimeCredentials | null> {
  const stored = await repositories.runtimeConfig.getBotCredentials();
  if (!stored) {
    return null;
  }

  const credentials: BotRuntimeCredentials = {
    botClientId: (stored.botClientId || "").trim(),
    accessToken: normalizeAccessToken(stored.accessToken || ""),
    refreshToken: normalizeRefreshToken(stored.refreshToken || ""),
    source: "redis",
    updatedAt: stored.updatedAt ?? null,
    botUserId: stored.botUserId,
    botUsername: stored.botUsername,
    botDisplayName: stored.botDisplayName,
    scopes: stored.scopes || [],
  };

  return hasCompleteBotCredentials(credentials) ? credentials : null;
}

function getEnvBotCredentials(): BotRuntimeCredentials | null {
  const snapshot = getEnvBotCredentialSnapshot();
  if (!hasCompleteBotCredentials(snapshot)) {
    return null;
  }

  return {
    ...snapshot,
    source: "env",
    updatedAt: null,
  };
}

async function getPreferredBotCredentials(): Promise<BotRuntimeCredentials | null> {
  const stored = await getStoredBotCredentials();
  if (stored) {
    return stored;
  }
  return getEnvBotCredentials();
}

async function persistBotCredentials(
  credentials: BotRuntimeCredentials,
  validated?: TwitchValidateResponse,
): Promise<BotRuntimeCredentials> {
  const updatedAt = credentials.updatedAt ?? Date.now();
  const next: BotRuntimeCredentials = {
    ...credentials,
    source: "redis",
    updatedAt,
    botUserId: validated?.user_id ?? credentials.botUserId,
    botUsername: validated?.login ?? credentials.botUsername,
    botDisplayName: validated?.login ?? credentials.botDisplayName,
    scopes: validated?.scopes || credentials.scopes || [],
  };

  await repositories.runtimeConfig.setBotCredentials({
    botClientId: next.botClientId,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    botUserId: next.botUserId,
    botUsername: next.botUsername,
    botDisplayName: next.botDisplayName,
    scopes: next.scopes,
    updatedAt,
  });

  return next;
}

async function seedRuntimeBotCredentialsFromEnv(): Promise<BotRuntimeCredentials> {
  const credentials = getEnvBotCredentials();
  if (!credentials) {
    throw new Error("TWITCH_BOT_CLIENT_ID, TWITCH_BOT_ACCESS_TOKEN und TWITCH_BOT_REFRESH_TOKEN muessen gesetzt sein.");
  }
  return persistBotCredentials({
    ...credentials,
    source: "redis",
    updatedAt: Date.now(),
  });
}

async function getBotCredentialInput(): Promise<BotRuntimeCredentials> {
  const credentials = await getPreferredBotCredentials();
  if (!credentials) {
    throw new Error("TWITCH_BOT_CLIENT_ID, TWITCH_BOT_ACCESS_TOKEN und TWITCH_BOT_REFRESH_TOKEN muessen gesetzt sein.");
  }
  return credentials;
}

async function getAuthHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const { credentials } = await ensureValidBotCredentials();
  return {
    "Client-Id": credentials.botClientId,
    Authorization: `Bearer ${credentials.accessToken}`,
    ...extra,
  };
}

async function getAppAccessToken(): Promise<string> {
  const now = Date.now();
  if (appAccessTokenCache && appAccessTokenCache.expiresAt > now + 60_000) {
    return appAccessTokenCache.token;
  }

  const { clientId, clientSecret } = getAppCredentialSnapshot();
  const response = await fetch(`${TWITCH_OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: assertEnv("TWITCH_APP_CLIENT_ID", clientId),
      client_secret: assertEnv("TWITCH_APP_CLIENT_SECRET", clientSecret),
      grant_type: "client_credentials",
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twitch App-Token konnte nicht erstellt werden: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as TwitchAppAccessTokenResponse;
  appAccessTokenCache = {
    token: payload.access_token,
    expiresAt: now + payload.expires_in * 1000,
  };

  return payload.access_token;
}

async function getAppAuthHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const { clientId } = getAppCredentialSnapshot();
  return {
    "Client-Id": assertEnv("TWITCH_APP_CLIENT_ID", clientId),
    Authorization: `Bearer ${await getAppAccessToken()}`,
    ...extra,
  };
}

async function twitchFetch<T>(path: string, init?: RequestInit, authMode: "bot" | "app" = "bot"): Promise<T> {
  const response = await fetch(`${TWITCH_API_BASE}${path}`, {
    ...init,
    headers: authMode === "app" ? await getAppAuthHeaders(init?.headers) : await getAuthHeaders(init?.headers),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new TwitchRequestError(`Twitch API ${path} failed: ${response.status} ${text}`, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function validateBotToken(clientId: string, accessToken: string): Promise<TwitchValidateResponse> {
  const response = await fetch(`${TWITCH_OAUTH_BASE}/validate`, {
    headers: {
      Authorization: `OAuth ${accessToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twitch OAuth validate failed: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as TwitchValidateResponse;
  if (payload.client_id !== clientId) {
    throw new Error("TWITCH_BOT_CLIENT_ID passt nicht zum Bot-Token.");
  }

  const missingScopes = REQUIRED_BOT_SCOPES.filter((scope) => !payload.scopes?.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Bot-Token ohne Pflicht-Scopes: ${missingScopes.join(", ")}`);
  }

  return payload;
}

async function ensureValidBotCredentials(): Promise<{
  credentials: BotRuntimeCredentials;
  validated: TwitchValidateResponse;
}> {
  const credentials = await getBotCredentialInput();
  const validated = await validateBotToken(credentials.botClientId, credentials.accessToken);
  if (credentials.source === "redis") {
    const persisted = await persistBotCredentials(credentials, validated);
    return { credentials: persisted, validated };
  }
  return { credentials, validated };
}

async function inspectBotCredentials(): Promise<BotCredentialInspection> {
  const appSnapshot = getAppCredentialSnapshot();
  const stored = await getStoredBotCredentials();
  const envCredentials = getEnvBotCredentials();
  const preferred = stored || envCredentials;

  const inspection: BotCredentialInspection = {
    appClientId: appSnapshot.clientId,
    botClientId: preferred?.botClientId || getEnvBotCredentialSnapshot().botClientId,
    accessToken: preferred?.accessToken || getEnvBotCredentialSnapshot().accessToken,
    refreshToken: preferred?.refreshToken || getEnvBotCredentialSnapshot().refreshToken,
    tokenPreview: maskToken(preferred?.accessToken || getEnvBotCredentialSnapshot().accessToken),
    source: preferred?.source || "env",
    updatedAt: preferred?.updatedAt ?? null,
    scopes: preferred?.scopes || [],
    credentialsValid: false,
    requiredScopesOk: false,
    refreshConfigured: !!(preferred?.refreshToken || getEnvBotCredentialSnapshot().refreshToken),
    issues: [],
  };

  if (!appSnapshot.clientId) {
    inspection.issues.push("TWITCH_APP_CLIENT_ID fehlt.");
  }
  if (!appSnapshot.clientSecret) {
    inspection.issues.push("TWITCH_APP_CLIENT_SECRET fehlt.");
  }
  if (!inspection.botClientId) {
    inspection.issues.push("TWITCH_BOT_CLIENT_ID fehlt.");
  }
  if (!inspection.accessToken) {
    inspection.issues.push("TWITCH_BOT_ACCESS_TOKEN fehlt.");
  }
  if (inspection.issues.length > 0) {
    return inspection;
  }

  try {
    const { credentials, validated } = await ensureValidBotCredentials();
    inspection.botClientId = credentials.botClientId;
    inspection.accessToken = credentials.accessToken;
    inspection.refreshToken = credentials.refreshToken;
    inspection.tokenPreview = maskToken(credentials.accessToken);
    inspection.source = credentials.source;
    inspection.updatedAt = credentials.updatedAt;
    inspection.refreshConfigured = !!credentials.refreshToken;
    inspection.botUserId = validated.user_id;
    inspection.botUsername = validated.login;
    inspection.botDisplayName = validated.login;
    inspection.scopes = validated.scopes || [];
    inspection.requiredScopesOk = REQUIRED_BOT_SCOPES.every((scope) => inspection.scopes.includes(scope));
    inspection.credentialsValid = inspection.requiredScopesOk;
    if (!inspection.requiredScopesOk) {
      const missingScopes = REQUIRED_BOT_SCOPES.filter((scope) => !inspection.scopes.includes(scope));
      inspection.issues.push(`Pflicht-Scopes fehlen: ${missingScopes.join(", ")}`);
    }
  } catch (error) {
    inspection.issues.push(error instanceof Error ? error.message : "Bot-Credentials konnten nicht geprueft werden.");
  }

  return inspection;
}

export async function assertValidBotCredentials(): Promise<BotCredentialInspection> {
  const inspection = await inspectBotCredentials();
  if (!inspection.credentialsValid) {
    throw new Error(inspection.issues[0] || "Bot-Credentials sind ungueltig.");
  }
  return inspection;
}

async function getBotUser(): Promise<TwitchUser> {
  const inspection = await assertValidBotCredentials();
  return {
    id: inspection.botUserId || "",
    login: inspection.botUsername || "",
    display_name: inspection.botDisplayName || inspection.botUsername || "",
  };
}

async function syncManagedChannelSubscriptions(): Promise<SubscriptionSyncError[]> {
  const channels = await repositories.managedChannels.getAll();
  const errors: SubscriptionSyncError[] = [];
  const { joinIrcChannel, partIrcChannel } = await import("./irc");

  for (const channel of channels) {
    try {
      await deleteChatMessageSubscription(channel.channel_name);
    } catch (error) {
      await repositories.eventSubSubscriptions.removeByChannel(channel.channel_name);
      await milesandmorebotLogger.warn(
        `[Runtime] subscription cleanup failed for #${channel.channel_name}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }

    try {
      const eventSubSuccess = await createChatMessageSubscription(channel.channel_name);
      if (eventSubSuccess) {
        await partIrcChannel(channel.channel_name);
      } else {
        const joined = await joinIrcChannel(channel.channel_name);
        if (!joined) {
          errors.push({ channelName: channel.channel_name, reason: "IRC fallback join failed" });
          await milesandmorebotLogger.error(
            `[Runtime] IRC fallback join failed for #${channel.channel_name}`,
          );
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      errors.push({ channelName: channel.channel_name, reason });
      await milesandmorebotLogger.error(
        `[Runtime] subscription re-sync failed for #${channel.channel_name}: ${reason}`,
      );
    }
  }
  return errors;
}

export async function getUsersByLogin(logins: string[]): Promise<TwitchUser[]> {
  if (logins.length === 0) {
    return [];
  }
  const query = logins.map((login) => `login=${encodeURIComponent(login)}`).join("&");
  const response = await twitchFetch<{ data: TwitchUser[] }>(`/users?${query}`, undefined, "app");
  return response.data || [];
}

export async function getUserByLogin(login: string): Promise<TwitchUser | null> {
  const users = await getUsersByLogin([login]);
  return users[0] || null;
}

export async function sendChatMessage(channelName: string, message: string): Promise<void> {
  const [broadcaster, botUser] = await Promise.all([getUserByLogin(channelName), getBotUser()]);

  if (!broadcaster || !botUser) {
    throw new Error(`Unable to resolve Twitch user ids for ${channelName}`);
  }

  const payload = {
    broadcaster_id: broadcaster.id,
    sender_id: botUser.id,
    message,
  };

  try {
    // Attempt with App Access Token to get the Chat Bot Badge (requires streamer to have authorized the bot)
    await twitchFetch<{ data: Array<{ message_id: string }> }>("/chat/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }, "app");
  } catch (error: unknown) {
    if (error instanceof TwitchRequestError && (error.status === 403 || error.status === 401)) {
      // Streamer hasn't authorized channel:bot. Fall back to the bot's own User Access Token.
      await twitchFetch<{ data: Array<{ message_id: string }> }>("/chat/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }, "bot");
    } else {
      throw error;
    }
  }

  await milesandmorebotLogger.chat(`[OUT] #${channelName}: ${message}`);
}

export async function measurePing(): Promise<number> {
  const start = performance.now();
  await twitchFetch<{ data: TwitchUser[] }>("/users?login=twitchdev", undefined, "app");
  return Math.round(performance.now() - start);
}

export function normalizeEventSubChatMessage(payload: EventSubWebhookPayload): TwitchChatMessage | null {
  const event = payload.event;
  if (!event) {
    return null;
  }
  return {
    messageID: String(event.message_id || ""),
    channelName: String(event.broadcaster_user_login || ""),
    channelID: String(event.broadcaster_user_id || ""),
    senderUsername: String(event.chatter_user_login || ""),
    senderUserID: String(event.chatter_user_id || ""),
    displayName: String(event.chatter_user_name || event.chatter_user_login || ""),
    messageText: String((event.message as { text?: string } | undefined)?.text || ""),
    badges: Array.isArray(event.badges)
      ? (event.badges as Array<{ set_id: string; id: string }>).map((badge) => ({
          name: badge.set_id,
          version: badge.id,
        }))
      : [],
  };
}

export function verifyEventSubSignature(headers: Headers, body: string): boolean {
  const messageId = headers.get("twitch-eventsub-message-id");
  const timestamp = headers.get("twitch-eventsub-message-timestamp");
  const signature = headers.get("twitch-eventsub-message-signature");
  if (!messageId || !timestamp || !signature) {
    return false;
  }
  const expected = `sha256=${crypto
    .createHmac("sha256", assertEnv("TWITCH_EVENTSUB_SECRET", milesandmorebotEnv.eventSubSecret))
    .update(messageId + timestamp + body)
    .digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

export function isFreshEventSubTimestamp(headers: Headers): boolean {
  const timestamp = headers.get("twitch-eventsub-message-timestamp");
  if (!timestamp) {
    return false;
  }
  const ageMs = Math.abs(Date.now() - Date.parse(timestamp));
  return ageMs <= 10 * 60 * 1000;
}

export async function createChatMessageSubscription(channelName: string): Promise<boolean> {
  await assertValidBotCredentials();
  const [channel, botUser] = await Promise.all([getUserByLogin(channelName), getBotUser()]);
  if (!channel || !botUser) {
    throw new Error(`Unable to create EventSub subscription for ${channelName}`);
  }

  try {
    const response = await twitchFetch<{
      data: Array<{
        id: string;
        status: string;
        condition: { broadcaster_user_id: string };
        created_at: string;
      }>;
    }>("/eventsub/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: channel.id,
          user_id: botUser.id,
        },
        transport: {
          method: "webhook",
          callback: milesandmorebotEnv.eventSubCallbackUrl,
          secret: assertEnv("TWITCH_EVENTSUB_SECRET", milesandmorebotEnv.eventSubSecret),
        },
      }),
    }, "app");

    const subscription = response.data?.[0];
    if (!subscription) {
      throw new Error(`Twitch did not return a subscription for ${channelName}`);
    }
    await repositories.eventSubSubscriptions.set(channelName, {
      id: subscription.id,
      status: subscription.status,
      broadcaster_user_id: channel.id,
      channel_name: channelName,
      created_at: subscription.created_at,
    });
    await milesandmorebotLogger.info(`[EventSub] subscribed to #${channelName}`);
    return true;
  } catch (error: unknown) {
    if (error instanceof TwitchRequestError && error.status === 403) {
      await milesandmorebotLogger.info(`[EventSub] HTTP 403 for #${channelName} (not authorized). Falling back to IRC.`);
      return false;
    }
    throw error;
  }
}

export async function deleteChatMessageSubscription(channelName: string): Promise<void> {
  const current = await repositories.eventSubSubscriptions.get(channelName);
  if (!current) {
    return;
  }

  await twitchFetch<void>(`/eventsub/subscriptions?id=${encodeURIComponent(current.id)}`, {
    method: "DELETE",
  }, "app");
  await repositories.eventSubSubscriptions.removeByChannel(channelName);
  await milesandmorebotLogger.info(`[EventSub] unsubscribed from #${channelName}`);
}

export async function resolveUserId(login: string): Promise<string | null> {
  const user = await getUserByLogin(login);
  return user?.id || null;
}

export async function getBotRuntimeSettings(): Promise<BotRuntimeSettings> {
  const [inspection, restartedAt] = await Promise.all([inspectBotCredentials(), repositories.runtimeConfig.getRestartedAt()]);

  return {
    appClientId: inspection.appClientId,
    botClientId: inspection.botClientId,
    tokenPreview: inspection.tokenPreview,
    source: inspection.source,
    botUserId: inspection.botUserId,
    botUsername: inspection.botUsername,
    botDisplayName: inspection.botDisplayName,
    scopes: inspection.scopes,
    updatedAt: inspection.updatedAt,
    restartedAt,
    credentialsValid: inspection.credentialsValid,
    requiredScopesOk: inspection.requiredScopesOk,
    refreshConfigured: inspection.refreshConfigured,
    issues: inspection.issues,
  };
}

export async function restartBotRuntime(): Promise<BotRuntimeSettings> {
  await repositories.runtimeConfig.clearBotCredentials();
  await seedRuntimeBotCredentialsFromEnv();
  clearAppAccessTokenCache();

  const { resetIrcClient } = await import("./irc");
  await resetIrcClient("runtime restart");

  const inspection = await assertValidBotCredentials();
  const syncErrors = await syncManagedChannelSubscriptions();
  if (syncErrors.length > 0) {
    const summary = syncErrors.map(({ channelName, reason }) => `#${channelName}: ${reason}`).join(" | ");
    throw new Error(`Neu laden fehlgeschlagen. ${summary}`);
  }

  const now = Date.now();
  await Promise.all([repositories.status.restart(now), repositories.runtimeConfig.markRestarted(now)]);
  await milesandmorebotLogger.info("[Runtime] bot runtime restarted");

  return {
    appClientId: inspection.appClientId,
    botClientId: inspection.botClientId,
    tokenPreview: inspection.tokenPreview,
    source: inspection.source,
    botUserId: inspection.botUserId,
    botUsername: inspection.botUsername,
    botDisplayName: inspection.botDisplayName,
    scopes: inspection.scopes,
    updatedAt: inspection.updatedAt,
    restartedAt: now,
    credentialsValid: inspection.credentialsValid,
    requiredScopesOk: inspection.requiredScopesOk,
    refreshConfigured: inspection.refreshConfigured,
    issues: inspection.issues,
  };
}
