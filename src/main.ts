import { createServer } from "./server";
import { milesandmorebotLogger } from "./milesandmorebot/logger";
import { repositories } from "./milesandmorebot/storage";

async function main() {
  const app = createServer();
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || "3001");

  await repositories.ensureBootTimestamp();
  await app.listen({ host, port });
  await milesandmorebotLogger.info(`Miles & More backend listening on ${host}:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
