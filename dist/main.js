"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_1 = require("./server");
const logger_1 = require("./milesandmorebot/logger");
const storage_1 = require("./milesandmorebot/storage");
async function main() {
    const app = (0, server_1.createServer)();
    const host = process.env.HOST || "0.0.0.0";
    const port = Number(process.env.PORT || "3001");
    await storage_1.repositories.ensureBootTimestamp();
    await app.listen({ host, port });
    await logger_1.milesandmorebotLogger.info(`MilesAndMore backend listening on ${host}:${port}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
