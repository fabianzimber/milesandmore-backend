"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_1 = require("./server");
const logger_1 = require("./milesandmorebot/logger");
const storage_1 = require("./milesandmorebot/storage");
const twitch_1 = require("./milesandmorebot/twitch");
const local_scheduler_1 = require("./milesandmorebot/local-scheduler");
async function main() {
    const app = (0, server_1.createServer)();
    const host = process.env.HOST || "0.0.0.0";
    const port = Number(process.env.PORT || "3001");
    await storage_1.repositories.ensureBootTimestamp();
    await app.listen({ host, port });
    await logger_1.milesandmorebotLogger.info(`Miles & More backend listening on ${host}:${port}`);
    // Auto-restart bot runtime on boot (reconnect IRC/EventSub channels)
    try {
        await (0, twitch_1.restartBotRuntime)();
        await logger_1.milesandmorebotLogger.info("[Startup] Bot runtime initialized successfully");
    }
    catch (error) {
        await logger_1.milesandmorebotLogger.error(`[Startup] Bot runtime init failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    // Start local scheduler for boarding timers and stuck-flight cleanup
    (0, local_scheduler_1.startLocalScheduler)();
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
