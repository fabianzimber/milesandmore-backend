function optionalList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function assertEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getAppUrl(): string {
  return process.env.BACKEND_PUBLIC_URL || "http://localhost:8080";
}

// Twitch Developer App credentials (used for streamer OAuth, admin OAuth, and Helix API requests).
// When the bot shares this Client ID, these credentials are also used for token refresh.
const twitchAppClientId = (process.env.TWITCH_APP_CLIENT_ID || "").trim();
const twitchAppClientSecret = (process.env.TWITCH_APP_CLIENT_SECRET || "").trim();

// Bot may use its own Client ID (public client, no client secret needed).
// Falls back to the app Client ID for backward compatibility.
const twitchBotClientId = (process.env.TWITCH_BOT_CLIENT_ID || twitchAppClientId).trim();

export const milesandmorebotEnv = {
  appUrl: getAppUrl(),
  frontendUrl: process.env.FRONTEND_URL || "",
  authSecret: process.env.AUTH_SECRET || "",
  adminTwitchIds: optionalList("ADMIN_TWITCH_IDS"),
  internalJobSecret: process.env.INTERNAL_JOB_SECRET || "",
  simlinkIngestSecret: process.env.SIMLINK_INGEST_SECRET || "",
  twitchAppClientId,
  twitchAppClientSecret,
  twitchBotClientId,
  twitchBotAccessToken: process.env.TWITCH_BOT_ACCESS_TOKEN || "",
  twitchBotRefreshToken: process.env.TWITCH_BOT_REFRESH_TOKEN || "",
  twitchBotOwnerId: process.env.TWITCH_BOT_OWNER_ID || "",
  qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
};
