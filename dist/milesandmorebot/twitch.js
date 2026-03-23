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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertValidBotCredentials = assertValidBotCredentials;
exports.getUsersByLogin = getUsersByLogin;
exports.getUserByLogin = getUserByLogin;
exports.sendChatMessage = sendChatMessage;
exports.measurePing = measurePing;
exports.normalizeEventSubChatMessage = normalizeEventSubChatMessage;
exports.verifyEventSubSignature = verifyEventSubSignature;
exports.isFreshEventSubTimestamp = isFreshEventSubTimestamp;
exports.createChatMessageSubscription = createChatMessageSubscription;
exports.deleteChatMessageSubscription = deleteChatMessageSubscription;
exports.resolveUserId = resolveUserId;
exports.getBotRuntimeSettings = getBotRuntimeSettings;
exports.restartBotRuntime = restartBotRuntime;
const node_crypto_1 = __importDefault(require("node:crypto"));
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
const REQUIRED_BOT_SCOPES = ["user:bot", "user:read:chat", "user:write:chat"];
let appAccessTokenCache = null;
function clearAppAccessTokenCache() {
    appAccessTokenCache = null;
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
async function getAppAccessToken() {
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
            client_id: (0, env_1.assertEnv)("TWITCH_APP_CLIENT_ID", clientId),
            client_secret: (0, env_1.assertEnv)("TWITCH_APP_CLIENT_SECRET", clientSecret),
            grant_type: "client_credentials",
        }),
        cache: "no-store",
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Twitch App-Token konnte nicht erstellt werden: ${response.status} ${text}`);
    }
    const payload = (await response.json());
    appAccessTokenCache = {
        token: payload.access_token,
        expiresAt: now + payload.expires_in * 1000,
    };
    return payload.access_token;
}
async function getAppAuthHeaders(extra) {
    const { clientId } = getAppCredentialSnapshot();
    return {
        "Client-Id": (0, env_1.assertEnv)("TWITCH_APP_CLIENT_ID", clientId),
        Authorization: `Bearer ${await getAppAccessToken()}`,
        ...extra,
    };
}
async function twitchFetch(path, init, authMode = "bot") {
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
        return undefined;
    }
    return (await response.json());
}
async function validateBotToken(clientId, accessToken) {
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
    const credentials = await getBotCredentialInput();
    const validated = await validateBotToken(credentials.botClientId, credentials.accessToken);
    if (credentials.source === "redis") {
        const persisted = await persistBotCredentials(credentials, validated);
        return { credentials: persisted, validated };
    }
    return { credentials, validated };
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
async function syncManagedChannelSubscriptions() {
    const channels = await storage_1.repositories.managedChannels.getAll();
    const errors = [];
    const { joinIrcChannel, partIrcChannel } = await Promise.resolve().then(() => __importStar(require("./irc")));
    for (const channel of channels) {
        try {
            await deleteChatMessageSubscription(channel.channel_name);
        }
        catch (error) {
            await storage_1.repositories.eventSubSubscriptions.removeByChannel(channel.channel_name);
            await logger_1.milesandmorebotLogger.warn(`[Runtime] subscription cleanup failed for #${channel.channel_name}: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        try {
            const eventSubSuccess = await createChatMessageSubscription(channel.channel_name);
            if (eventSubSuccess) {
                await partIrcChannel(channel.channel_name);
            }
            else {
                const joined = await joinIrcChannel(channel.channel_name);
                if (!joined) {
                    errors.push({ channelName: channel.channel_name, reason: "IRC fallback join failed" });
                    await logger_1.milesandmorebotLogger.error(`[Runtime] IRC fallback join failed for #${channel.channel_name}`);
                }
            }
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : "unknown error";
            errors.push({ channelName: channel.channel_name, reason });
            await logger_1.milesandmorebotLogger.error(`[Runtime] subscription re-sync failed for #${channel.channel_name}: ${reason}`);
        }
    }
    return errors;
}
async function getUsersByLogin(logins) {
    if (logins.length === 0) {
        return [];
    }
    const query = logins.map((login) => `login=${encodeURIComponent(login)}`).join("&");
    const response = await twitchFetch(`/users?${query}`, undefined, "app");
    return response.data || [];
}
async function getUserByLogin(login) {
    const users = await getUsersByLogin([login]);
    return users[0] || null;
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
    try {
        // Attempt with App Access Token to get the Chat Bot Badge (requires streamer to have authorized the bot)
        await twitchFetch("/chat/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        }, "app");
    }
    catch (error) {
        if (error instanceof TwitchRequestError && (error.status === 403 || error.status === 401)) {
            // Streamer hasn't authorized channel:bot. Fall back to the bot's own User Access Token.
            await twitchFetch("/chat/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            }, "bot");
        }
        else {
            throw error;
        }
    }
    await logger_1.milesandmorebotLogger.chat(`[OUT] #${channelName}: ${message}`);
}
async function measurePing() {
    const start = performance.now();
    await twitchFetch("/users?login=twitchdev", undefined, "app");
    return Math.round(performance.now() - start);
}
function normalizeEventSubChatMessage(payload) {
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
        messageText: String(event.message?.text || ""),
        badges: Array.isArray(event.badges)
            ? event.badges.map((badge) => ({
                name: badge.set_id,
                version: badge.id,
            }))
            : [],
    };
}
function verifyEventSubSignature(headers, body) {
    const messageId = headers.get("twitch-eventsub-message-id");
    const timestamp = headers.get("twitch-eventsub-message-timestamp");
    const signature = headers.get("twitch-eventsub-message-signature");
    if (!messageId || !timestamp || !signature) {
        return false;
    }
    const expected = `sha256=${node_crypto_1.default
        .createHmac("sha256", (0, env_1.assertEnv)("TWITCH_EVENTSUB_SECRET", env_1.milesandmorebotEnv.eventSubSecret))
        .update(messageId + timestamp + body)
        .digest("hex")}`;
    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);
    if (expectedBuf.length !== signatureBuf.length) {
        return false;
    }
    return node_crypto_1.default.timingSafeEqual(expectedBuf, signatureBuf);
}
function isFreshEventSubTimestamp(headers) {
    const timestamp = headers.get("twitch-eventsub-message-timestamp");
    if (!timestamp) {
        return false;
    }
    const ageMs = Math.abs(Date.now() - Date.parse(timestamp));
    return ageMs <= 10 * 60 * 1000;
}
async function createChatMessageSubscription(channelName) {
    await assertValidBotCredentials();
    const [channel, botUser] = await Promise.all([getUserByLogin(channelName), getBotUser()]);
    if (!channel || !botUser) {
        throw new Error(`Unable to create EventSub subscription for ${channelName}`);
    }
    try {
        const response = await twitchFetch("/eventsub/subscriptions", {
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
                    callback: env_1.milesandmorebotEnv.eventSubCallbackUrl,
                    secret: (0, env_1.assertEnv)("TWITCH_EVENTSUB_SECRET", env_1.milesandmorebotEnv.eventSubSecret),
                },
            }),
        }, "app");
        const subscription = response.data?.[0];
        if (!subscription) {
            throw new Error(`Twitch did not return a subscription for ${channelName}`);
        }
        await storage_1.repositories.eventSubSubscriptions.set(channelName, {
            id: subscription.id,
            status: subscription.status,
            broadcaster_user_id: channel.id,
            channel_name: channelName,
            created_at: subscription.created_at,
        });
        await logger_1.milesandmorebotLogger.info(`[EventSub] subscribed to #${channelName}`);
        return true;
    }
    catch (error) {
        if (error instanceof TwitchRequestError && error.status === 403) {
            await logger_1.milesandmorebotLogger.info(`[EventSub] HTTP 403 for #${channelName} (not authorized). Falling back to IRC.`);
            return false;
        }
        throw error;
    }
}
async function deleteChatMessageSubscription(channelName) {
    const current = await storage_1.repositories.eventSubSubscriptions.get(channelName);
    if (!current) {
        return;
    }
    await twitchFetch(`/eventsub/subscriptions?id=${encodeURIComponent(current.id)}`, {
        method: "DELETE",
    }, "app");
    await storage_1.repositories.eventSubSubscriptions.removeByChannel(channelName);
    await logger_1.milesandmorebotLogger.info(`[EventSub] unsubscribed from #${channelName}`);
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
    clearAppAccessTokenCache();
    const { resetIrcClient } = await Promise.resolve().then(() => __importStar(require("./irc")));
    await resetIrcClient("runtime restart");
    const inspection = await assertValidBotCredentials();
    const syncErrors = await syncManagedChannelSubscriptions();
    if (syncErrors.length > 0) {
        const summary = syncErrors.map(({ channelName, reason }) => `#${channelName}: ${reason}`).join(" | ");
        throw new Error(`Neu laden fehlgeschlagen. ${summary}`);
    }
    const now = Date.now();
    await Promise.all([storage_1.repositories.status.restart(now), storage_1.repositories.runtimeConfig.markRestarted(now)]);
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
