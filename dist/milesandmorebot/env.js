"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.milesandmorebotEnv = void 0;
exports.assertEnv = assertEnv;
exports.getAppUrl = getAppUrl;
function optionalList(name) {
    return (process.env[name] || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}
function assertEnv(name, value) {
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function getAppUrl() {
    return process.env.BACKEND_PUBLIC_URL || "http://localhost:8080";
}
exports.milesandmorebotEnv = {
    appUrl: getAppUrl(),
    frontendUrl: process.env.FRONTEND_URL || "",
    authSecret: process.env.AUTH_SECRET || "",
    adminTwitchIds: optionalList("ADMIN_TWITCH_IDS"),
    internalJobSecret: process.env.INTERNAL_JOB_SECRET || process.env.MILESANDMORE_INTERNAL_API_SECRET || "",
    simlinkIngestSecret: process.env.SIMLINK_INGEST_SECRET || "",
    twitchAppClientId: process.env.TWITCH_APP_CLIENT_ID || "",
    twitchAppClientSecret: process.env.TWITCH_APP_CLIENT_SECRET || "",
    twitchBotClientId: process.env.TWITCH_BOT_CLIENT_ID || "",
    twitchBotClientSecret: process.env.TWITCH_BOT_CLIENT_SECRET || "",
    twitchBotAccessToken: process.env.TWITCH_BOT_ACCESS_TOKEN || "",
    twitchBotRefreshToken: process.env.TWITCH_BOT_REFRESH_TOKEN || "",
    twitchBotUsername: process.env.TWITCH_BOT_USERNAME || "",
    twitchBotOwnerId: process.env.TWITCH_BOT_OWNER_ID || process.env.BOT_OWNER_TWITCH_ID || "",
    qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
    qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
};
