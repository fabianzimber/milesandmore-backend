import { repositories } from "./storage";
import { milesandmorebotLogger } from "./logger";
import {
  finishBoardingJob,
  sendBoardingWarningJob,
} from "./core";

const POLL_INTERVAL_MS = 15_000; // check every 15 seconds
const STUCK_BOARDING_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max boarding
const STUCK_FLIGHT_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h max flight

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

// Track which warnings we already sent so we don't spam
const sentWarnings = new Set<string>();

export function startLocalScheduler(): void {
  if (schedulerTimer) {
    return;
  }

  schedulerTimer = setInterval(() => {
    runSchedulerTick().catch((error) => {
      milesandmorebotLogger.error(
        `[LocalScheduler] tick error: ${error instanceof Error ? error.message : "unknown"}`,
      ).catch(() => {});
    });
  }, POLL_INTERVAL_MS);

  milesandmorebotLogger.info("[LocalScheduler] started (interval: 15s)").catch(() => {});
}

export function stopLocalScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

async function runSchedulerTick(): Promise<void> {
  const now = Date.now();

  // --- Process boarding flights ---
  const boardingFlights = await repositories.flights.getByStatus("boarding");
  for (const flight of boardingFlights) {
    const lifecycleVersion = Math.max(1, flight.lifecycle_version || 1);

    // Check if boarding should close
    if (flight.close_at && flight.close_at <= now) {
      await milesandmorebotLogger.info(
        `[LocalScheduler] closing boarding for flight ${flight.id} (#${flight.channel_name})`,
      );
      await finishBoardingJob(flight.id, flight.channel_name, lifecycleVersion);
      sentWarnings.delete(`warning:${flight.id}`);
      continue;
    }

    // Check if warning should be sent
    if (flight.warning_at && flight.warning_at <= now) {
      const warningKey = `warning:${flight.id}:${lifecycleVersion}`;
      if (!sentWarnings.has(warningKey)) {
        const warningMinutes =
          flight.close_at && flight.warning_at
            ? Math.round((flight.close_at - flight.warning_at) / 60_000)
            : 5;
        await milesandmorebotLogger.info(
          `[LocalScheduler] sending boarding warning for flight ${flight.id} (#${flight.channel_name})`,
        );
        await sendBoardingWarningJob(flight.id, flight.channel_name, warningMinutes, lifecycleVersion);
        sentWarnings.add(warningKey);
      }
    }

    // Fail-safe: abort boarding that's been open too long (no close_at set or way past it)
    const boardingAge = now - (flight.created_at || flight.start_time || now);
    if (boardingAge > STUCK_BOARDING_TIMEOUT_MS && (!flight.close_at || flight.close_at < now - 60_000)) {
      await milesandmorebotLogger.warn(
        `[LocalScheduler] force-closing stuck boarding for flight ${flight.id} (#${flight.channel_name}, age: ${Math.round(boardingAge / 60_000)}min)`,
      );
      await finishBoardingJob(flight.id, flight.channel_name, lifecycleVersion);
      sentWarnings.delete(`warning:${flight.id}`);
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

      // Award rewards before completing
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
