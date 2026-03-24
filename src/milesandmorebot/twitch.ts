import type { BotRuntimeSettings } from "../lib/types";
import { milesandmorebotEnv } from "./env";
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

type RefreshClientSecretResolution = {
  clientSecret: string;
  source: string;
} | null;

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
const REQUIRED_BOT_SCOPES = ["user:bot", "user:read:chat", "user:write:chat", "user:manage:whispers"] as const;
const REFRESH_ERROR_HINT_PATTERNS = ["invalid client secret", "invalid refresh token", "invalid client"] as const;

let botCredentialCache: {
  credentials: BotRuntimeCredentials;
  validated: TwitchValidateResponse;
  expiresAt: number;
} | null = null;

const BOT_CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

const userCache = new Map<string, { user: TwitchUser; expiresAt: number }>();
const USER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const USER_CACHE_MAX_SIZE = 500;

function pruneUserCache(): void {
  if (userCache.size <= USER_CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [key, entry] of userCache) {
    if (entry.expiresAt <= now) userCache.delete(key);
  }
  if (userCache.size > USER_CACHE_MAX_SIZE) {
    const excess = userCache.size - USER_CACHE_MAX_SIZE;
    let removed = 0;
    for (const key of userCache.keys()) {
      if (removed >= excess) break;
      userCache.delete(key);
      removed++;
    }
  }
}

function clearBotCredentialCache() {
  botCredentialCache = null;
}

type TwitchRefreshResponse = {
  access_token: string;
  refresh_token: string;
  scope: string[];
  token_type: string;
};

export async function refreshBotAccessToken(): Promise<boolean> {
  const credentials = await getPreferredBotCredentials();
  if (!credentials || !credentials.refreshToken) {
    await milesandmorebotLogger.error("[TokenRefresh] Kein Refresh-Token vorhanden — Refresh nicht moeglich.");
    return false;
  }

  const refreshLock = await repositories.locks.acquire("twitch:token-refresh", 60);
  if (!refreshLock) {
    await milesandmorebotLogger.info("[TokenRefresh] Ein anderer Prozess erneuert den Token bereits, warte kurz und verwende dann aktualisierte Credentials.");
    // Kurz warten, damit der andere Prozess den Refresh abschliessen und persistieren kann
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // Cache leeren, damit nachfolgende Aufrufe die neuen Credentials laden
    clearBotCredentialCache();
    return true;
  }

  try {
    const params = new URLSearchParams({
      client_id: credentials.botClientId,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    });

    // Include client_secret only when the bot shares the app's Client ID (confidential client).
    // A separate bot Client ID is treated as a public client — no secret needed.
    const clientSecret = getRefreshClientSecret(credentials.botClientId);
    if (clientSecret) {
      params.set("client_secret", clientSecret.clientSecret);
    }

    const response = await fetch(`${TWITCH_OAUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      const hint = getRefreshFailureHint(text);
      const secretHint = clientSecret ? `via ${clientSecret.source}` : "ohne Client-Secret (Public Client)";
      await milesandmorebotLogger.error(
        `[TokenRefresh] Twitch refresh failed ${secretHint}: ${response.status} ${text}${hint ? ` ${hint}` : ""}`,
      );
      return false;
    }

    const payload = (await response.json()) as TwitchRefreshResponse;

    const refreshedCredentials: BotRuntimeCredentials = {
      ...credentials,
      accessToken: normalizeAccessToken(payload.access_token),
      refreshToken: normalizeRefreshToken(payload.refresh_token),
      scopes: payload.scope || credentials.scopes,
      source: "redis",
      updatedAt: Date.now(),
    };

    // Validate the new token immediately
    const validated = await validateBotToken(refreshedCredentials.botClientId, refreshedCredentials.accessToken);
    await persistBotCredentials(refreshedCredentials, validated);
    clearBotCredentialCache();

    // Schedule next refresh
    const nextRefreshAt = Date.now() + TOKEN_REFRESH_INTERVAL_MS;
    await repositories.runtimeConfig.setNextTokenRefreshAt(nextRefreshAt);

    await milesandmorebotLogger.info(
      `[TokenRefresh] Token erfolgreich erneuert. Naechster Refresh: ${new Date(nextRefreshAt).toISOString()}`,
    );
    return true;
  } catch (error) {
    await milesandmorebotLogger.error(
      `[TokenRefresh] Refresh fehlgeschlagen: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  } finally {
    await repositories.locks.release("twitch:token-refresh", refreshLock);
  }
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

function getRefreshClientSecret(botClientId: string): RefreshClientSecretResolution {
  const normalizedClientId = botClientId.trim();
  if (!normalizedClientId) {
    return null;
  }

  // Only include the secret when bot and app share the same Client ID (confidential client).
  const appSnapshot = getAppCredentialSnapshot();
  if (normalizedClientId !== appSnapshot.clientId || !appSnapshot.clientSecret) {
    return null;
  }

  return {
    clientSecret: appSnapshot.clientSecret,
    source: "TWITCH_APP_CLIENT_SECRET",
  };
}

function getMissingRefreshClientSecretMessage(botClientId: string): string {
  return `[TokenRefresh] Bot-Client-ID ${botClientId || "(leer)"} nutzt dieselbe Client-ID wie die App, aber TWITCH_APP_CLIENT_SECRET fehlt. Entweder das Secret setzen oder eine separate TWITCH_BOT_CLIENT_ID (Public Client) verwenden.`;
}

function getRefreshFailureHint(responseText: string): string {
  let lowerCaseResponse = responseText.toLowerCase();
  try {
    const parsed = JSON.parse(responseText) as { error?: string; message?: string };
    const structuredMessage = [parsed.error, parsed.message].filter(Boolean).join(" ").toLowerCase();
    if (structuredMessage) {
      lowerCaseResponse = structuredMessage;
    }
  } catch {
    // Ignore invalid JSON and fall back to the raw response text
  }

  if (REFRESH_ERROR_HINT_PATTERNS.some((pattern) => lowerCaseResponse.includes(pattern))) {
    return "Der Refresh-Token gehoert wahrscheinlich nicht zu einer der hier konfigurierten Twitch-Apps. Tokens von twitchtokengenerator.com oder einer anderen Drittanbieter-App muessen fuer deine eigene Twitch-App neu ausgestellt werden.";
  }
  return "";
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
    throw new Error("TWITCH_BOT_CLIENT_ID (oder TWITCH_APP_CLIENT_ID), TWITCH_BOT_ACCESS_TOKEN und TWITCH_BOT_REFRESH_TOKEN muessen gesetzt sein.");
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
    throw new Error("TWITCH_BOT_CLIENT_ID (oder TWITCH_APP_CLIENT_ID), TWITCH_BOT_ACCESS_TOKEN und TWITCH_BOT_REFRESH_TOKEN muessen gesetzt sein.");
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

async function twitchFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${TWITCH_API_BASE}${path}`, {
    ...init,
    headers: await getAuthHeaders(init?.headers),
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
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twitch OAuth validate failed: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as TwitchValidateResponse;
  if (payload.client_id !== clientId) {
    throw new Error(`Bot-Token Client-ID (${payload.client_id}) passt nicht zur konfigurierten TWITCH_BOT_CLIENT_ID (${clientId}).`);
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
  const now = Date.now();
  if (botCredentialCache && botCredentialCache.expiresAt > now) {
    return { credentials: botCredentialCache.credentials, validated: botCredentialCache.validated };
  }

  const credentials = await getBotCredentialInput();
  try {
    const validated = await validateBotToken(credentials.botClientId, credentials.accessToken);
    if (credentials.source === "redis") {
      const persisted = await persistBotCredentials(credentials, validated);
      botCredentialCache = { credentials: persisted, validated, expiresAt: now + BOT_CREDENTIAL_CACHE_TTL_MS };
      return { credentials: persisted, validated };
    }
    botCredentialCache = { credentials, validated, expiresAt: now + BOT_CREDENTIAL_CACHE_TTL_MS };
    return { credentials, validated };
  } catch (validationError) {
    // Reactive refresh: if validation fails and we have a refresh token, try refreshing
    if (credentials.refreshToken) {
      await milesandmorebotLogger.warn("[TokenRefresh] Token-Validierung fehlgeschlagen, versuche Refresh...");
      const refreshed = await refreshBotAccessToken();
      if (refreshed) {
        // Retry validation with the new token
        const freshCredentials = await getBotCredentialInput();
        const freshValidated = await validateBotToken(freshCredentials.botClientId, freshCredentials.accessToken);
        const persisted = await persistBotCredentials(freshCredentials, freshValidated);
        botCredentialCache = { credentials: persisted, validated: freshValidated, expiresAt: now + BOT_CREDENTIAL_CACHE_TTL_MS };
        return { credentials: persisted, validated: freshValidated };
      }
    }
    throw validationError;
  }
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

  if (!inspection.botClientId) {
    inspection.issues.push("TWITCH_BOT_CLIENT_ID oder TWITCH_APP_CLIENT_ID fehlt.");
  }
  if (!inspection.accessToken) {
    inspection.issues.push("TWITCH_BOT_ACCESS_TOKEN fehlt.");
  }
  if (!inspection.refreshToken) {
    inspection.issues.push("TWITCH_BOT_REFRESH_TOKEN fehlt.");
  }
  // Only warn about missing client secret when bot and app share the same client ID.
  const botUsesAppClientId = inspection.botClientId === appSnapshot.clientId;
  if (botUsesAppClientId && !appSnapshot.clientSecret && inspection.refreshConfigured) {
    inspection.issues.push(getMissingRefreshClientSecretMessage(inspection.botClientId));
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

async function syncManagedIrcChannels(): Promise<void> {
  const channels = await repositories.managedChannels.getAll();
  const { joinIrcChannel } = await import("./irc");
  for (const channel of channels) {
    const joined = await joinIrcChannel(channel.channel_name);
    if (!joined) {
      await milesandmorebotLogger.error(`[Runtime] IRC join failed for #${channel.channel_name}`);
    }
  }
}

export async function getUsersByLogin(logins: string[]): Promise<TwitchUser[]> {
  if (logins.length === 0) {
    return [];
  }
  const query = logins.map((login) => `login=${encodeURIComponent(login)}`).join("&");
  const response = await twitchFetch<{ data: TwitchUser[] }>(`/users?${query}`);
  return response.data || [];
}

export async function getUserByLogin(login: string): Promise<TwitchUser | null> {
  const now = Date.now();
  const cached = userCache.get(login.toLowerCase());
  if (cached && cached.expiresAt > now) {
    return cached.user;
  }

  const users = await getUsersByLogin([login]);
  const user = users[0] || null;
  if (user) {
    pruneUserCache();
    userCache.set(login.toLowerCase(), { user, expiresAt: now + USER_CACHE_TTL_MS });
  }
  return user;
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

  await twitchFetch<{ data: Array<{ message_id: string }> }>("/chat/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  await milesandmorebotLogger.chat(`[OUT] #${channelName}: ${message}`);
}

export async function sendWhisper(toUserId: string, message: string): Promise<void> {
  const botUser = await getBotUser();
  const params = new URLSearchParams({ from_user_id: botUser.id, to_user_id: toUserId });
  await twitchFetch(`/whispers?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export async function measurePing(): Promise<number> {
  const start = performance.now();
  await twitchFetch<{ data: TwitchUser[] }>("/users?login=twitchdev");
  return Math.round(performance.now() - start);
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
  clearBotCredentialCache();

  const { resetIrcClient } = await import("./irc");
  await resetIrcClient("runtime restart");

  const inspection = await assertValidBotCredentials();
  await syncManagedIrcChannels();

  const now = Date.now();
  await Promise.all([repositories.status.restart(now), repositories.runtimeConfig.markRestarted(now)]);

  // Seed next token refresh time if not already scheduled
  const existingRefreshAt = await repositories.runtimeConfig.getNextTokenRefreshAt();
  if (!existingRefreshAt || existingRefreshAt <= now) {
    await repositories.runtimeConfig.setNextTokenRefreshAt(now + TOKEN_REFRESH_INTERVAL_MS);
  }
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
