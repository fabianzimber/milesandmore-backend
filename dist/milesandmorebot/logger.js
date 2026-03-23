"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.milesandmorebotLogger = void 0;
exports.getRecentBotLogs = getRecentBotLogs;
const storage_1 = require("./storage");
const BOT_LOGS_KEY = "mb:botLogs";
const BOT_LOG_LIMIT = 1000;
async function pushLog(level, message) {
    const entry = {
        id: Date.now(),
        level,
        message,
        timestamp: new Date().toISOString(),
    };
    const redis = (0, storage_1.getRedis)();
    await redis.lpush(BOT_LOGS_KEY, entry);
    await redis.ltrim(BOT_LOGS_KEY, 0, BOT_LOG_LIMIT - 1);
    const line = `[${level.toUpperCase()}] ${message}`;
    if (level === "error") {
        console.error(line);
    }
    else if (level === "warn") {
        console.warn(line);
    }
    else {
        console.log(line);
    }
}
exports.milesandmorebotLogger = {
    debug(message) {
        return pushLog("debug", message);
    },
    info(message) {
        return pushLog("info", message);
    },
    warn(message) {
        return pushLog("warn", message);
    },
    error(message) {
        return pushLog("error", message);
    },
    api(message) {
        return pushLog("api", message);
    },
    irc(message) {
        return pushLog("irc", message);
    },
    chat(message) {
        return pushLog("chat", message);
    },
};
async function getRecentBotLogs(limit = 100) {
    const redis = (0, storage_1.getRedis)();
    const rows = (await redis.lrange(BOT_LOGS_KEY, 0, Math.max(0, limit - 1))) || [];
    return [...rows].reverse();
}
