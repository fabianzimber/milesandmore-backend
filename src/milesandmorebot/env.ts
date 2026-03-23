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

export const milesandmorebotEnv = {
  appUrl: getAppUrl(),
  frontendUrl: process.env.FRONTEND_URL || "",
  authSecret: process.env.AUTH_SECRET || "",
  adminTwitchIds: optionalList("ADMIN_TWITCH_IDS"),
  internalJobSecret: process.env.INTERNAL_JOB_SECRET || "",
  simlinkIngestSecret: process.env.SIMLINK_INGEST_SECRET || "",
  twitchAppClientId: process.env.TWITCH_APP_CLIENT_ID || "",
  twitchAppClientSecret: process.env.TWITCH_APP_CLIENT_SECRET || "",
  twitchBotClientId: process.env.TWITCH_BOT_CLIENT_ID || "",
  twitchBotClientSecret: process.env.TWITCH_BOT_CLIENT_SECRET || "",
  twitchBotAccessToken: process.env.TWITCH_BOT_ACCESS_TOKEN || "",
  twitchBotRefreshToken: process.env.TWITCH_BOT_REFRESH_TOKEN || "",
  twitchBotOwnerId: process.env.TWITCH_BOT_OWNER_ID || "",
  qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
};
