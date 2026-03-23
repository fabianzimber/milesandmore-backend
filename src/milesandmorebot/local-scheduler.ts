import { repositories } from "./storage";
import { milesandmorebotLogger } from "./logger";
import { isQStashConfigured } from "./scheduler";
import { refreshBotAccessToken } from "./twitch";
import {
  finishBoardingJob,
  sendBoardingWarningJob,
} from "./core";

const POLL_INTERVAL_MS = 15_000; // check every 15 seconds
const STUCK_BOARDING_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max boarding
const STUCK_FLIGHT_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h max flight

// When QStash is configured, wait this long past the scheduled time before
// the local scheduler steps in. This gives QStash time to deliver the job
// and avoids duplicate actions.
const QSTASH_GRACE_PERIOD_MS = 60_000; // 1 minute grace

// Use globalThis to persist across tsx watch reloads and prevent duplicate timers
const globalForScheduler = globalThis as unknown as {
  localSchedulerTimer?: ReturnType<typeof setInterval>;
  localSchedulerWarnings?: Set<string>;
  localSchedulerTickRunning?: boolean;
};

// Track which warnings we already sent so we don't spam
const sentWarnings = globalForScheduler.localSchedulerWarnings ??= new Set<string>();

export function startLocalScheduler(): void {
  if (globalForScheduler.localSchedulerTimer) {
    return;
  }

  globalForScheduler.localSchedulerTimer = setInterval(() => {
    if (globalForScheduler.localSchedulerTickRunning) return;
    globalForScheduler.localSchedulerTickRunning = true;
    runSchedulerTick().catch((error) => {
        milesandmorebotLogger.error(
          `[LocalScheduler] tick error: ${error instanceof Error ? error.message : "unknown"}`,
        ).catch(() => {});
      })
      .finally(() => {
        globalForScheduler.localSchedulerTickRunning = false;
      });
  }, POLL_INTERVAL_MS);

  const mode = isQStashConfigured() ? "fallback (QStash primary)" : "primary (no QStash)";
  milesandmorebotLogger.info(`[LocalScheduler] started — mode: ${mode}, interval: 15s`).catch(() => {});
}

export function stopLocalScheduler(): void {
  if (globalForScheduler.localSchedulerTimer) {
    clearInterval(globalForScheduler.localSchedulerTimer);
    globalForScheduler.localSchedulerTimer = undefined;
  }
}

/**
 * Returns how long past the deadline we should wait before acting.
 * - QStash configured + flight has a job ID → wait grace period (QStash should handle it)
 * - QStash not configured or no job ID → act immediately
 */
function getGracePeriod(hasQStashJobId: boolean): number {
  if (isQStashConfigured() && hasQStashJobId) {
    return QSTASH_GRACE_PERIOD_MS;
  }
  return 0;
}

async function runSchedulerTick(): Promise<void> {
  const now = Date.now();

  // --- Token refresh check ---
  try {
    const nextRefreshAt = await repositories.runtimeConfig.getNextTokenRefreshAt();
    if (nextRefreshAt && nextRefreshAt <= now) {
      await milesandmorebotLogger.info("[LocalScheduler] Bot-Token-Refresh faellig, starte Refresh...");
      const refreshed = await refreshBotAccessToken();
      if (refreshed) {
        // Reconnect IRC with the new token
        const { resetIrcClient, getIrcClient, joinIrcChannel } = await import("./irc");
        await resetIrcClient("token refresh");
        await getIrcClient();
        const channels = await repositories.managedChannels.getAll();
        for (const channel of channels) {
          await joinIrcChannel(channel.channel_name);
        }
        await milesandmorebotLogger.info("[LocalScheduler] IRC nach Token-Refresh neu verbunden.");
      } else {
        // Retry in 5 minutes on failure
        await repositories.runtimeConfig.setNextTokenRefreshAt(now + 5 * 60 * 1000);
        await milesandmorebotLogger.warn("[LocalScheduler] Token-Refresh fehlgeschlagen, Retry in 5 Minuten.");
      }
    }
  } catch (error) {
    await milesandmorebotLogger.error(
      `[LocalScheduler] Token-Refresh-Pruefung fehlgeschlagen: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  // --- Process boarding flights ---
  const boardingFlights = await repositories.flights.getByStatus("boarding");
  for (const flight of boardingFlights) {
    const lifecycleVersion = Math.max(1, flight.lifecycle_version || 1);
    const hasCloseJob = !!flight.close_job_id;
    const hasWarningJob = !!flight.warning_job_id;

    // Check if boarding should close (with grace period for QStash)
    if (flight.close_at && flight.close_at + getGracePeriod(hasCloseJob) <= now) {
      await milesandmorebotLogger.info(
        `[LocalScheduler] closing boarding for flight ${flight.id} (#${flight.channel_name})${hasCloseJob ? " [QStash missed]" : ""}`,
      );
      await finishBoardingJob(flight.id, flight.channel_name, lifecycleVersion);
      sentWarnings.delete(`warning:${flight.id}:${lifecycleVersion}`);
      continue;
    }

    // Check if warning should be sent (with grace period for QStash)
    if (flight.warning_at && flight.warning_at + getGracePeriod(hasWarningJob) <= now) {
      const warningKey = `warning:${flight.id}:${lifecycleVersion}`;
      if (!sentWarnings.has(warningKey)) {
        const warningMinutes =
          flight.close_at && flight.warning_at
            ? Math.round((flight.close_at - flight.warning_at) / 60_000)
            : 5;
        await milesandmorebotLogger.info(
          `[LocalScheduler] sending boarding warning for flight ${flight.id} (#${flight.channel_name})${hasWarningJob ? " [QStash missed]" : ""}`,
        );
        await sendBoardingWarningJob(flight.id, flight.channel_name, warningMinutes, lifecycleVersion);
        sentWarnings.add(warningKey);
      }
    }

    // Fail-safe: abort boarding that's been open way too long
    const boardingAge = now - (flight.created_at || flight.start_time || now);
    if (boardingAge > STUCK_BOARDING_TIMEOUT_MS && (!flight.close_at || flight.close_at < now - 60_000)) {
      await milesandmorebotLogger.warn(
        `[LocalScheduler] force-closing stuck boarding for flight ${flight.id} (#${flight.channel_name}, age: ${Math.round(boardingAge / 60_000)}min)`,
      );
      await finishBoardingJob(flight.id, flight.channel_name, lifecycleVersion);
      sentWarnings.delete(`warning:${flight.id}:${lifecycleVersion}`);
    }
  }

  // --- Process in-flight flights: fail-safe timeout ---
  const inFlightFlights = await repositories.flights.getByStatus("in_flight");
  for (const flight of inFlightFlights) {
    const flightStart = flight.start_time || flight.created_at || now;
    const flightAge = now - flightStart;

    if (flightAge > STUCK_FLIGHT_TIMEOUT_MS) {
      await milesandmorebotLogger.warn(
        `[LocalScheduler] auto-completing stuck flight ${flight.id} (#${flight.channel_name}, age: ${Math.round(flightAge / 3_600_000)}h)`,
      );

      try {
        const { awardFlightRewards, updateFlightStatus } = await import("./core");
        await updateFlightStatus(flight.id, "completed");
        await awardFlightRewards(flight.id);
      } catch (error) {
        await milesandmorebotLogger.error(
          `[LocalScheduler] failed to auto-complete flight ${flight.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
  }

  // Cleanup old warning tracking entries (prevent memory leak)
  if (sentWarnings.size > 200) {
    sentWarnings.clear();
  }
}
