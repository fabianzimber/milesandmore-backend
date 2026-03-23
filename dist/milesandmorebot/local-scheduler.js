"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startLocalScheduler = startLocalScheduler;
exports.stopLocalScheduler = stopLocalScheduler;
const storage_1 = require("./storage");
const logger_1 = require("./logger");
const scheduler_1 = require("./scheduler");
const core_1 = require("./core");
const POLL_INTERVAL_MS = 15_000; // check every 15 seconds
const STUCK_BOARDING_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max boarding
const STUCK_FLIGHT_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h max flight
// When QStash is configured, wait this long past the scheduled time before
// the local scheduler steps in. This gives QStash time to deliver the job
// and avoids duplicate actions.
const QSTASH_GRACE_PERIOD_MS = 60_000; // 1 minute grace
let schedulerTimer = null;
// Track which warnings we already sent so we don't spam
const sentWarnings = new Set();
function startLocalScheduler() {
    if (schedulerTimer) {
        return;
    }
    schedulerTimer = setInterval(() => {
        runSchedulerTick().catch((error) => {
            logger_1.milesandmorebotLogger.error(`[LocalScheduler] tick error: ${error instanceof Error ? error.message : "unknown"}`).catch(() => { });
        });
    }, POLL_INTERVAL_MS);
    const mode = (0, scheduler_1.isQStashConfigured)() ? "fallback (QStash primary)" : "primary (no QStash)";
    logger_1.milesandmorebotLogger.info(`[LocalScheduler] started — mode: ${mode}, interval: 15s`).catch(() => { });
}
function stopLocalScheduler() {
    if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
    }
}
/**
 * Returns how long past the deadline we should wait before acting.
 * - QStash configured + flight has a job ID → wait grace period (QStash should handle it)
 * - QStash not configured or no job ID → act immediately
 */
function getGracePeriod(hasQStashJobId) {
    if ((0, scheduler_1.isQStashConfigured)() && hasQStashJobId) {
        return QSTASH_GRACE_PERIOD_MS;
    }
    return 0;
}
async function runSchedulerTick() {
    const now = Date.now();
    // --- Process boarding flights ---
    const boardingFlights = await storage_1.repositories.flights.getByStatus("boarding");
    for (const flight of boardingFlights) {
        const lifecycleVersion = Math.max(1, flight.lifecycle_version || 1);
        const hasCloseJob = !!flight.close_job_id;
        const hasWarningJob = !!flight.warning_job_id;
        // Check if boarding should close (with grace period for QStash)
        if (flight.close_at && flight.close_at + getGracePeriod(hasCloseJob) <= now) {
            await logger_1.milesandmorebotLogger.info(`[LocalScheduler] closing boarding for flight ${flight.id} (#${flight.channel_name})${hasCloseJob ? " [QStash missed]" : ""}`);
            await (0, core_1.finishBoardingJob)(flight.id, flight.channel_name, lifecycleVersion);
            sentWarnings.delete(`warning:${flight.id}`);
            continue;
        }
        // Check if warning should be sent (with grace period for QStash)
        if (flight.warning_at && flight.warning_at + getGracePeriod(hasWarningJob) <= now) {
            const warningKey = `warning:${flight.id}:${lifecycleVersion}`;
            if (!sentWarnings.has(warningKey)) {
                const warningMinutes = flight.close_at && flight.warning_at
                    ? Math.round((flight.close_at - flight.warning_at) / 60_000)
                    : 5;
                await logger_1.milesandmorebotLogger.info(`[LocalScheduler] sending boarding warning for flight ${flight.id} (#${flight.channel_name})${hasWarningJob ? " [QStash missed]" : ""}`);
                await (0, core_1.sendBoardingWarningJob)(flight.id, flight.channel_name, warningMinutes, lifecycleVersion);
                sentWarnings.add(warningKey);
            }
        }
        // Fail-safe: abort boarding that's been open way too long
        const boardingAge = now - (flight.created_at || flight.start_time || now);
        if (boardingAge > STUCK_BOARDING_TIMEOUT_MS && (!flight.close_at || flight.close_at < now - 60_000)) {
            await logger_1.milesandmorebotLogger.warn(`[LocalScheduler] force-closing stuck boarding for flight ${flight.id} (#${flight.channel_name}, age: ${Math.round(boardingAge / 60_000)}min)`);
            await (0, core_1.finishBoardingJob)(flight.id, flight.channel_name, lifecycleVersion);
            sentWarnings.delete(`warning:${flight.id}`);
        }
    }
    // --- Process in-flight flights: fail-safe timeout ---
    const inFlightFlights = await storage_1.repositories.flights.getByStatus("in_flight");
    for (const flight of inFlightFlights) {
        const flightStart = flight.start_time || flight.created_at || now;
        const flightAge = now - flightStart;
        if (flightAge > STUCK_FLIGHT_TIMEOUT_MS) {
            await logger_1.milesandmorebotLogger.warn(`[LocalScheduler] auto-completing stuck flight ${flight.id} (#${flight.channel_name}, age: ${Math.round(flightAge / 3_600_000)}h)`);
            try {
                const { awardFlightRewards, updateFlightStatus } = await Promise.resolve().then(() => __importStar(require("./core")));
                await updateFlightStatus(flight.id, "completed");
                await awardFlightRewards(flight.id);
            }
            catch (error) {
                await logger_1.milesandmorebotLogger.error(`[LocalScheduler] failed to auto-complete flight ${flight.id}: ${error instanceof Error ? error.message : "unknown"}`);
            }
        }
    }
    // Cleanup old warning tracking entries (prevent memory leak)
    if (sentWarnings.size > 200) {
        sentWarnings.clear();
    }
}
