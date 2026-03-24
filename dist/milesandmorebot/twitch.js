"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshBotAccessToken = refreshBotAccessToken;
exports.assertValidBotCredentials = assertValidBotCredentials;
exports.getUsersByLogin = getUsersByLogin;
exports.getUserByLogin = getUserByLogin;
exports.sendChatMessage = sendChatMessage;
exports.sendWhisper = sendWhisper;
exports.measurePing = measurePing;
exports.resolveUserId = resolveUserId;
exports.getBotRuntimeSettings = getBotRuntimeSettings;
exports.restartBotRuntime = restartBotRuntime;
const env_1 = require("./env");
const logger_1 = require("./logger");
const storage_1 = require("./storage");
class TwitchRequestError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "TwitchRequestError";
    }
}
const TWITCH_API_BASE = "https://api.twitch.tv/helix";
const TWITCH_OAUTH_BASE = "https://id.twitch.tv/oauth2";
const REQUIRED_BOT_SCOPES = ["user:bot", "user:read:chat", "user:write:chat", "user:manage:whispers"];
let botCredentialCache = null;
const BOT_CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const userCache = new Map();
const USER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const USER_CACHE_MAX_SIZE = 500;
function pruneUserCache() {
    if (userCache.size <= USER_CACHE_MAX_SIZE)
        return;
    const now = Date.now();
    for (const [key, entry] of userCache) {
        if (entry.expiresAt <= now)
            userCache.delete(key);
    }
    if (userCache.size > USER_CACHE_MAX_SIZE) {
        const excess = userCache.size - USER_CACHE_MAX_SIZE;
        let removed = 0;
        for (const key of userCache.keys()) {
            if (removed >= excess)
                break;
            userCache.delete(key);
            removed++;
        }
    }
}
function clearBotCredentialCache() {
    botCredentialCache = null;
}
async function refreshBotAccessToken() {
    const credentials = await getPreferredBotCredentials();
    if (!credentials || !credentials.refreshToken) {
        await logger_1.milesandmorebotLogger.error("[TokenRefresh] Kein Refresh-Token vorhanden — Refresh nicht moeglich.");
        return false;
    }
    const botClientSecret = (env_1.milesandmorebotEnv.twitchBotClientSecret || "").trim();
    if (!botClientSecret) {
        await logger_1.milesandmorebotLogger.error("[TokenRefresh] TWITCH_BOT_CLIENT_SECRET fehlt — Refresh nicht moeglich.");
        return false;
    }
    const refreshLock = await storage_1.repositories.locks.acquire("twitch:token-refresh", 60);
    if (!refreshLock) {
        await logger_1.milesandmorebotLogger.info("[TokenRefresh] Ein anderer Prozess erneuert den Token bereits.");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        clearBotCredentialCache();
        return true;
    }
    try {
        const params = new URLSearchParams({
            client_id: credentials.botClientId,
            client_secret: botClientSecret,
            grant_type: "refresh_token",
            refresh_token: credentials.refreshToken,
        });
        const response = await fetch(`${TWITCH_OAUTH_BASE}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
        });
        if (!response.ok) {
            const text = await response.text();
            await logger_1.milesandmorebotLogger.error(`[TokenRefresh] Twitch refresh failed: ${response.status} ${text}`);
            return false;
        }
        const payload = (await response.json());
        const refreshedCredentials = {
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
        await storage_1.repositories.runtimeConfig.setNextTokenRefreshAt(nextRefreshAt);
        await logger_1.milesandmorebotLogger.info(`[TokenRefresh] Token erfolgreich erneuert. Naechster Refresh: ${new Date(nextRefreshAt).toISOString()}`);
        return true;
    }
    catch (error) {
        await logger_1.milesandmorebotLogger.error(`[TokenRefresh] Refresh fehlgeschlagen: ${error instanceof Error ? error.message : "unknown"}`);
        return false;
    }
    finally {
        await storage_1.repositories.locks.release("twitch:token-refresh", refreshLock);
    }
}
function normalizeAccessToken(token) {
    return token.trim().replace(/^oauth:/i, "");
}
function normalizeRefreshToken(token) {
    return token.trim();
}
function maskToken(token) {
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
        clientId: (env_1.milesandmorebotEnv.twitchAppClientId || "").trim(),
        clientSecret: (env_1.milesandmorebotEnv.twitchAppClientSecret || "").trim(),
    };
}
function getEnvBotCredentialSnapshot() {
    return {
        botClientId: (env_1.milesandmorebotEnv.twitchBotClientId || "").trim(),
        accessToken: normalizeAccessToken(env_1.milesandmorebotEnv.twitchBotAccessToken),
        refreshToken: normalizeRefreshToken(env_1.milesandmorebotEnv.twitchBotRefreshToken),
    };
}
function hasCompleteBotCredentials(credentials) {
    return !!credentials?.botClientId && !!credentials.accessToken;
}
async function getStoredBotCredentials() {
    const stored = await storage_1.repositories.runtimeConfig.getBotCredentials();
    if (!stored) {
        return null;
    }
    const credentials = {
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
function getEnvBotCredentials() {
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
async function getPreferredBotCredentials() {
    const stored = await getStoredBotCredentials();
    if (stored) {
        return stored;
    }
    return getEnvBotCredentials();
}
async function persistBotCredentials(credentials, validated) {
    const updatedAt = credentials.updatedAt ?? Date.now();
    const next = {
        ...credentials,
        source: "redis",
        updatedAt,
        botUserId: validated?.user_id ?? credentials.botUserId,
        botUsername: validated?.login ?? credentials.botUsername,
        botDisplayName: validated?.login ?? credentials.botDisplayName,
        scopes: validated?.scopes || credentials.scopes || [],
    };
    await storage_1.repositories.runtimeConfig.setBotCredentials({
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
async function seedRuntimeBotCredentialsFromEnv() {
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
async function getBotCredentialInput() {
    const credentials = await getPreferredBotCredentials();
    if (!credentials) {
        throw new Error("TWITCH_BOT_CLIENT_ID, TWITCH_BOT_ACCESS_TOKEN und TWITCH_BOT_REFRESH_TOKEN muessen gesetzt sein.");
    }
    return credentials;
}
async function getAuthHeaders(extra) {
    const { credentials } = await ensureValidBotCredentials();
    return {
        "Client-Id": credentials.botClientId,
        Authorization: `Bearer ${credentials.accessToken}`,
        ...extra,
    };
}
async function twitchFetch(path, init) {
    const response = await fetch(`${TWITCH_API_BASE}${path}`, {
        ...init,
        headers: await getAuthHeaders(init?.headers),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new TwitchRequestError(`Twitch API ${path} failed: ${response.status} ${text}`, response.status);
    }
    if (response.status === 204) {
        return undefined;
    }
    return (await response.json());
}
async function validateBotToken(clientId, accessToken) {
    const response = await fetch(`${TWITCH_OAUTH_BASE}/validate`, {
        headers: {
            Authorization: `OAuth ${accessToken}`,
        },
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Twitch OAuth validate failed: ${response.status} ${text}`);
    }
    const payload = (await response.json());
    if (payload.client_id !== clientId) {
        throw new Error("TWITCH_BOT_CLIENT_ID passt nicht zum Bot-Token.");
    }
    const missingScopes = REQUIRED_BOT_SCOPES.filter((scope) => !payload.scopes?.includes(scope));
    if (missingScopes.length > 0) {
        throw new Error(`Bot-Token ohne Pflicht-Scopes: ${missingScopes.join(", ")}`);
    }
    return payload;
}
async function ensureValidBotCredentials() {
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
    }
    catch (validationError) {
        // Reactive refresh: if validation fails and we have a refresh token, try refreshing
        if (credentials.refreshToken) {
            await logger_1.milesandmorebotLogger.warn("[TokenRefresh] Token-Validierung fehlgeschlagen, versuche Refresh...");
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
async function inspectBotCredentials() {
    const appSnapshot = getAppCredentialSnapshot();
    const stored = await getStoredBotCredentials();
    const envCredentials = getEnvBotCredentials();
    const preferred = stored || envCredentials;
    const inspection = {
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
    }
    catch (error) {
        inspection.issues.push(error instanceof Error ? error.message : "Bot-Credentials konnten nicht geprueft werden.");
    }
    return inspection;
}
async function assertValidBotCredentials() {
    const inspection = await inspectBotCredentials();
    if (!inspection.credentialsValid) {
        throw new Error(inspection.issues[0] || "Bot-Credentials sind ungueltig.");
    }
    return inspection;
}
async function getBotUser() {
    const inspection = await assertValidBotCredentials();
    return {
        id: inspection.botUserId || "",
        login: inspection.botUsername || "",
        display_name: inspection.botDisplayName || inspection.botUsername || "",
    };
}
async function syncManagedIrcChannels() {
    const channels = await storage_1.repositories.managedChannels.getAll();
    const { joinIrcChannel } = await Promise.resolve().then(() => __importStar(require("./irc")));
    for (const channel of channels) {
        const joined = await joinIrcChannel(channel.channel_name);
        if (!joined) {
            await logger_1.milesandmorebotLogger.error(`[Runtime] IRC join failed for #${channel.channel_name}`);
        }
    }
}
async function getUsersByLogin(logins) {
    if (logins.length === 0) {
        return [];
    }
    const query = logins.map((login) => `login=${encodeURIComponent(login)}`).join("&");
    const response = await twitchFetch(`/users?${query}`);
    return response.data || [];
}
async function getUserByLogin(login) {
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
async function sendChatMessage(channelName, message) {
    const [broadcaster, botUser] = await Promise.all([getUserByLogin(channelName), getBotUser()]);
    if (!broadcaster || !botUser) {
        throw new Error(`Unable to resolve Twitch user ids for ${channelName}`);
    }
    const payload = {
        broadcaster_id: broadcaster.id,
        sender_id: botUser.id,
        message,
    };
    await twitchFetch("/chat/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });
    await logger_1.milesandmorebotLogger.chat(`[OUT] #${channelName}: ${message}`);
}
async function sendWhisper(toUserId, message) {
    const botUser = await getBotUser();
    const params = new URLSearchParams({ from_user_id: botUser.id, to_user_id: toUserId });
    await twitchFetch(`/whispers?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
    });
}
async function measurePing() {
    const start = performance.now();
    await twitchFetch("/users?login=twitchdev");
    return Math.round(performance.now() - start);
}
async function resolveUserId(login) {
    const user = await getUserByLogin(login);
    return user?.id || null;
}
async function getBotRuntimeSettings() {
    const [inspection, restartedAt] = await Promise.all([inspectBotCredentials(), storage_1.repositories.runtimeConfig.getRestartedAt()]);
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
async function restartBotRuntime() {
    await storage_1.repositories.runtimeConfig.clearBotCredentials();
    await seedRuntimeBotCredentialsFromEnv();
    clearBotCredentialCache();
    const { resetIrcClient } = await Promise.resolve().then(() => __importStar(require("./irc")));
    await resetIrcClient("runtime restart");
    const inspection = await assertValidBotCredentials();
    await syncManagedIrcChannels();
    const now = Date.now();
    await Promise.all([storage_1.repositories.status.restart(now), storage_1.repositories.runtimeConfig.markRestarted(now)]);
    // Seed next token refresh time if not already scheduled
    const existingRefreshAt = await storage_1.repositories.runtimeConfig.getNextTokenRefreshAt();
    if (!existingRefreshAt || existingRefreshAt <= now) {
        await storage_1.repositories.runtimeConfig.setNextTokenRefreshAt(now + TOKEN_REFRESH_INTERVAL_MS);
    }
    await logger_1.milesandmorebotLogger.info("[Runtime] bot runtime restarted");
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
