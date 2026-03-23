import { createServer } from "./server";
import { milesandmorebotLogger } from "./milesandmorebot/logger";
import { repositories } from "./milesandmorebot/storage";
import { restartBotRuntime } from "./milesandmorebot/twitch";
import { startLocalScheduler } from "./milesandmorebot/local-scheduler";

async function main() {
  const app = createServer();
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || "3001");

  await repositories.ensureBootTimestamp();
  await app.listen({ host, port });
  await milesandmorebotLogger.info(`Miles & More backend listening on ${host}:${port}`);

  // Auto-restart bot runtime on boot (reconnect IRC channels)
  try {
    await restartBotRuntime();
    await milesandmorebotLogger.info("[Startup] Bot runtime initialized successfully");
  } catch (error) {
    await milesandmorebotLogger.error(
      `[Startup] Bot runtime init failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  // Start local scheduler for boarding timers and stuck-flight cleanup
  startLocalScheduler();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
