import type { BotLogEntry } from "../lib/types";
import { getRedis } from "./storage";

const BOT_LOGS_KEY = "mb:botLogs";
const BOT_LOG_LIMIT = 1000;

async function pushLog(level: string, message: string): Promise<void> {
  const entry: BotLogEntry = {
    id: Date.now(),
    level,
    message,
    timestamp: new Date().toISOString(),
  };

  const redis = getRedis();
  await redis.lpush(BOT_LOGS_KEY, entry);
  await redis.ltrim(BOT_LOGS_KEY, 0, BOT_LOG_LIMIT - 1);

  const line = `[${level.toUpperCase()}] ${message}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const milesandmorebotLogger = {
  debug(message: string) {
    return pushLog("debug", message);
  },
  info(message: string) {
    return pushLog("info", message);
  },
  warn(message: string) {
    return pushLog("warn", message);
  },
  error(message: string) {
    return pushLog("error", message);
  },
  api(message: string) {
    return pushLog("api", message);
  },
  irc(message: string) {
    return pushLog("irc", message);
  },
  chat(message: string) {
    return pushLog("chat", message);
  },
};

export async function getRecentBotLogs(limit = 100): Promise<BotLogEntry[]> {
  const redis = getRedis();
  const rows = (await redis.lrange<BotLogEntry>(BOT_LOGS_KEY, 0, Math.max(0, limit - 1))) || [];
  return [...rows].reverse();
}
