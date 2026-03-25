import { nanoid } from "nanoid";
import { getAirportCoords } from "../lib/airports";
import type {
  Flight,
  Participant,
  SimBriefFlightPlan,
  SimLinkIngestPayload,
  TwitchChatMessage,
} from "../lib/types";
import { milesandmorebotEnv } from "./env";
import { milesandmorebotLogger } from "./logger";
import { publishFlightJob } from "./scheduler";
import { repositories } from "./storage";
import {
  getUserByLogin,
  measurePing,
  resolveUserId,
  sendChatMessage,
  sendWhisper,
} from "./twitch";
import { joinIrcChannel, partIrcChannel } from "./irc";

const permissions = {
  default: 0,
  user: 0,
  vip: 1,
  mod: 2,
  broadcaster: 3,
  admin: 4,
  owner: 5,
} as const;

const AIRCRAFT_DEFAULTS = {
  A318: { config: "3-3", seats: 132, name: "Airbus A318" },
  A319: { config: "3-3", seats: 156, name: "Airbus A319" },
  A320: { config: "3-3", seats: 180, name: "Airbus A320" },
  A20N: { config: "3-3", seats: 180, name: "Airbus A320neo" },
  A321: { config: "3-3", seats: 220, name: "Airbus A321" },
  A21N: { config: "3-3", seats: 220, name: "Airbus A321neo" },
  B738: { config: "3-3", seats: 189, name: "Boeing 737-800" },
  B38M: { config: "3-3", seats: 189, name: "Boeing 737 MAX 8" },
  B789: { config: "3-3-3", seats: 381, name: "Boeing 787-9" },
  A359: { config: "3-3-3", seats: 325, name: "Airbus A350-900" },
} as const;

type CommandDefinition = {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  cooldown: { global: number; user: number; channel: number };
  permissionLevel: number;
  execute: (context: CommandContext) => Promise<void>;
};

type CommandContext = {
  args: string[];
  channel: { id: string; login: string };
  command: CommandDefinition;
  displayName: string;
  messageId: string;
  sender: { id: string; login: string; perms: number };
  text: string;
  send: (message: string, reply?: boolean) => Promise<void>;
};

function splitMessage(message: string, maxLength = 450): string[] {
  const messages: string[] = [];
  let rest = message;
  while (rest.length > maxLength) {
    let part = rest.slice(0, maxLength);
    const lastSpace = part.lastIndexOf(" ");
    if (lastSpace > 0) {
      part = part.slice(0, lastSpace);
    }
    messages.push(part);
    rest = rest.slice(part.length).trimStart();
  }
  messages.push(rest);
  return messages;
}

function formatSafeMention(username: string): string {
  return `@\u200B${username.replace(/^@+/, "")}`;
}

function countryCodeToFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  const upper = code.toUpperCase();
  return upper.split("").map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

async function say(channelLogin: string, message: string): Promise<void> {
  for (const part of splitMessage(message)) {
    await sendChatMessage(channelLogin, part);
  }
}

async function getPrefix(channelId: string): Promise<string> {
  return (await repositories.channelSettings.get(channelId, "prefix")) || "&";
}

async function setPrefix(channelId: string, prefix: string): Promise<void> {
  await repositories.channelSettings.set(channelId, "prefix", prefix);
}

async function getUserPermission(userId: string, badges: Array<{ name: string; version: string }>): Promise<number> {
  const saved = await repositories.userPermissions.get(userId);
  const levels = [saved ?? permissions.default];
  for (const badge of badges) {
    if (badge.name === "vip") levels.push(permissions.vip);
    if (badge.name === "moderator") levels.push(permissions.mod);
    if (badge.name === "broadcaster") levels.push(permissions.broadcaster);
  }
  if (userId === milesandmorebotEnv.twitchBotOwnerId) {
    levels.push(permissions.owner);
  }
  if (milesandmorebotEnv.adminTwitchIds.includes(userId)) {
    levels.push(permissions.admin);
  }
  return Math.max(...levels);
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = Math.floor(seconds % 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${restSeconds}s`]
    .filter(Boolean)
    .join(" ");
}

function parseSeatConfig(config: string): number[] {
  const segments = config
    .split("-")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error("Invalid seat configuration");
  }

  const layout = segments.map((segment) => Number.parseInt(segment, 10));
  if (layout.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Invalid seat configuration");
  }

  return layout;
}

function getSeatLetters(layout: number[]): string[] {
  const total = layout.reduce((sum, value) => sum + value, 0);
  return Array.from({ length: total }, (_, index) => String.fromCharCode(65 + index));
}

function getValidSeatIds(seatConfig: string, totalSeats: number): string[] {
  const layout = parseSeatConfig(seatConfig);
  const letters = getSeatLetters(layout);
  const seatsPerRow = letters.length;
  const maxRows = Math.ceil(totalSeats / seatsPerRow);
  const validSeats: string[] = [];

  for (let row = 1; row <= maxRows; row += 1) {
    for (const letter of letters) {
      if (validSeats.length >= totalSeats) {
        return validSeats;
      }
      validSeats.push(`${row}${letter}`);
    }
  }

  return validSeats;
}

function normalizeSeatId(seat: string): string {
  return seat.trim().toUpperCase();
}

function computeWarningConfig(closeAt: number, now = Date.now()) {
  const fiveMinutes = 5 * 60 * 1000;
  const oneMinute = 60 * 1000;
  const remaining = closeAt - now;

  if (remaining > fiveMinutes) {
    return { warningAt: closeAt - fiveMinutes, warningMinutes: 5 };
  }
  if (remaining > oneMinute) {
    return { warningAt: closeAt - oneMinute, warningMinutes: 1 };
  }
  return { warningAt: closeAt, warningMinutes: 0 };
}

function getLifecycleVersion(flight: Pick<Flight, "lifecycle_version">): number {
  return Math.max(1, flight.lifecycle_version || 1);
}

function badRequestError(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}

const FLIGHT_STATUS_TRANSITIONS: Record<Flight["status"], Flight["status"][]> = {
  boarding: ["in_flight", "cancelled"],
  in_flight: ["completed", "aborted"],
  aborted: ["in_flight"],
  completed: [],
  cancelled: [],
};

function canTransitionFlightStatus(current: Flight["status"], next: Flight["status"]): boolean {
  if (current === next) return true;
  return FLIGHT_STATUS_TRANSITIONS[current]?.includes(next) ?? false;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

async function scheduleFlightLifecycle(flight: Flight): Promise<Flight> {
  const warningDelay = Math.max(0, Math.floor(((flight.warning_at || 0) - Date.now()) / 1000));
  const closeDelay = Math.max(0, Math.floor(((flight.close_at || 0) - Date.now()) / 1000));
  const lifecycleVersion = getLifecycleVersion(flight);

  const [warning, close] = await Promise.all([
    publishFlightJob(
      "boarding-warning",
      {
        action: "boarding-warning",
        flightId: flight.id,
        channelName: flight.channel_name,
        warningMinutes: flight.warning_at && flight.close_at ? Math.round((flight.close_at - flight.warning_at) / 60_000) : undefined,
        lifecycleVersion,
      },
      warningDelay,
    ),
    publishFlightJob(
      "boarding-close",
      { action: "boarding-close", flightId: flight.id, channelName: flight.channel_name, lifecycleVersion },
      closeDelay,
    ),
  ]);

  const updated = await repositories.flights.update(flight.id, {
    warning_job_id: warning.messageId || null,
    close_job_id: close.messageId || null,
  });
  return updated || flight;
}

export async function createFlight(
  flightData: Partial<Flight> & Pick<Flight, "channel_name" | "icao_from" | "icao_to">,
): Promise<Flight> {
  if (!flightData.channel_name || !flightData.icao_from || !flightData.icao_to) {
    throw new Error("channel_name, icao_from and icao_to are required");
  }
  if (flightData.icao_from === flightData.icao_to) {
    throw new Error("Departure and arrival airports must be different");
  }

  const lockToken = await repositories.locks.acquire(`flight:create:${flightData.channel_name.toLowerCase()}`, 15);
  if (!lockToken) {
    throw new Error("Another flight creation is already in progress for this channel");
  }

  let flight: Flight;
  try {
    const existing = await repositories.flights.getByChannelAndStatus(flightData.channel_name, ["boarding", "in_flight"]);
    if (existing) {
      throw new Error("There is already an active flight in this channel");
    }

    // Clean up old completed/cancelled/aborted flights in this channel.
    // Participant records are deleted so stale data (e.g. boarding status) does
    // not bleed into the new flight. Awarded miles are stored separately in
    // userMiles and are not affected.
    const oldFlights = await repositories.flights.getAllByChannelAndStatus(
      flightData.channel_name,
      ["completed", "cancelled", "aborted"],
    );
    for (const old of oldFlights) {
      await repositories.participants.deleteByFlight(old.id);
      await repositories.flights.delete(old.id);
    }

    const depCoords = flightData.dep_lat != null
      ? { lat: flightData.dep_lat, lon: flightData.dep_lon! }
      : getAirportCoords(flightData.icao_from);
    const arrCoords = flightData.arr_lat != null
      ? { lat: flightData.arr_lat, lon: flightData.arr_lon! }
      : getAirportCoords(flightData.icao_to);

    const startTime = Date.now();
    const closeAt = startTime + 10 * 60 * 1000;
    const warningConfig = computeWarningConfig(closeAt, startTime);
    flight = await repositories.flights.create({
      channel_name: flightData.channel_name,
      icao_from: flightData.icao_from.toUpperCase(),
      icao_to: flightData.icao_to.toUpperCase(),
      start_time: startTime,
      end_time: closeAt,
      status: "boarding",
      pilot: flightData.pilot || flightData.channel_name,
      simbrief_ofp_id: flightData.simbrief_ofp_id,
      aircraft_icao: flightData.aircraft_icao,
      aircraft_name: flightData.aircraft_name,
      flight_number: flightData.flight_number,
      route: flightData.route,
      cruise_altitude: flightData.cruise_altitude,
      distance_nm: flightData.distance_nm,
      estimated_time_enroute: flightData.estimated_time_enroute,
      dep_name: flightData.dep_name,
      arr_name: flightData.arr_name,
      dep_gate: flightData.dep_gate,
      arr_gate: flightData.arr_gate,
      dep_lat: depCoords?.lat,
      dep_lon: depCoords?.lon,
      arr_lat: arrCoords?.lat,
      arr_lon: arrCoords?.lon,
      aircraft_total_seats: flightData.aircraft_total_seats || 180,
      seat_config: flightData.seat_config || "3-3",
      boarding_hash: nanoid(12),
      dep_country: flightData.dep_country,
      arr_country: flightData.arr_country,
      arr_country_name: flightData.arr_country_name,
      warning_at: warningConfig.warningAt,
      close_at: closeAt,
      lifecycle_version: 1,
      created_at: startTime,
    });
  } finally {
    await repositories.locks.release(`flight:create:${flightData.channel_name.toLowerCase()}`, lockToken);
  }

  let scheduled: Flight;
  try {
    scheduled = await scheduleFlightLifecycle(flight);
  } catch (scheduleErr) {
    // QStash scheduling may fail (e.g. deduplication conflict) – the local
    // fallback scheduler will pick this flight up, so we continue gracefully.
    await milesandmorebotLogger.error(`[Flight] QStash scheduling failed for flight ${flight.id}, local scheduler will handle it: ${scheduleErr}`);
    scheduled = flight;
  }
  await milesandmorebotLogger.info(`[Flight] created ${scheduled.flight_number || scheduled.id} for #${scheduled.channel_name}`);

  // Send boarding start message to chat (regardless of how the flight was started)
  const depName = scheduled.dep_name || scheduled.icao_from;
  const arrName = scheduled.arr_name || scheduled.icao_to;
  const flightNumber = scheduled.flight_number || `SK${scheduled.id}`;
  say(scheduled.channel_name, `✈️ Das Boarding für ${flightNumber} (${depName}→${arrName}) hat begonnen! | 10 Minuten offen | &joinflight peepoHappy`).catch((err) =>
    milesandmorebotLogger.error(`[Flight] failed to send boarding start message: ${err}`),
  );

  return scheduled;
}

export async function getFlightById(id: number): Promise<Flight | null> {
  return repositories.flights.getById(id);
}

export async function getFlights(status?: string): Promise<Flight[]> {
  return status ? repositories.flights.getByStatus(status) : repositories.flights.getRecent();
}

export async function updateFlightStatus(flightId: number, status: Flight["status"]): Promise<Flight | null> {
  const current = await repositories.flights.getById(flightId);
  if (!current) {
    return null;
  }
  if (!canTransitionFlightStatus(current.status, status)) {
    throw badRequestError(`Invalid status transition: ${current.status} -> ${status}`);
  }

  const bumpLifecycle = current.status !== status;
  const updated = await repositories.flights.update(flightId, {
    status,
    lifecycle_version: bumpLifecycle ? getLifecycleVersion(current) + 1 : getLifecycleVersion(current),
    ...(status !== "boarding"
      ? {
          warning_job_id: null,
          close_job_id: null,
          warning_at: 0,
          close_at: 0,
        }
      : {}),
  });
  if (updated && status === "in_flight") {
    await repositories.simlink.setFlightId(flightId);
  }
  if (updated && ["completed", "cancelled", "aborted"].includes(status)) {
    await repositories.simlink.setFlightId(null);
  }
  return updated;
}

export async function resumeBoarding(flightId: number, extraMinutes = 5): Promise<Flight | null> {
  const current = await repositories.flights.getById(flightId);
  if (!current) {
    return null;
  }
  const closeAt = Date.now() + extraMinutes * 60 * 1000;
  const warningConfig = computeWarningConfig(closeAt);
  const updated = await repositories.flights.update(flightId, {
    status: "boarding",
    end_time: closeAt,
    warning_at: warningConfig.warningAt,
    close_at: closeAt,
    lifecycle_version: getLifecycleVersion(current) + 1,
  });
  if (!updated) {
    return null;
  }
  try {
    return await scheduleFlightLifecycle(updated);
  } catch (scheduleErr) {
    await milesandmorebotLogger.error(`[Flight] QStash scheduling failed for resumed flight ${flightId}, local scheduler will handle it: ${scheduleErr}`);
    return updated;
  }
}

export async function resumeFlight(flightId: number): Promise<Flight | null> {
  const updated = await updateFlightStatus(flightId, "in_flight");
  if (updated) {
    await repositories.simlink.setFlightId(flightId);
  }
  return updated;
}

export async function assignSeats(flightId: number) {
  const flight = await repositories.flights.getById(flightId);
  if (!flight) {
    throw new Error("Flight not found");
  }
  const participants = await repositories.participants.getByFlight(flightId);
  if (participants.length === 0) {
    return [];
  }

  const maxSeats = flight.aircraft_total_seats || 180;
  const validSeats = getValidSeatIds(flight.seat_config || "3-3", maxSeats);
  const freeSeats = [...validSeats];
  const seenSeats = new Set<string>();
  const assignments: Array<{ user_name: string; user_id: string; seat: string; participant_hash: string }> = [];

  for (const participant of participants) {
    const currentSeat = participant.seat ? normalizeSeatId(participant.seat) : "";
    if (!currentSeat || !validSeats.includes(currentSeat) || seenSeats.has(currentSeat)) {
      continue;
    }

    seenSeats.add(currentSeat);
    const freeSeatIndex = freeSeats.indexOf(currentSeat);
    if (freeSeatIndex >= 0) {
      freeSeats.splice(freeSeatIndex, 1);
    }
    assignments.push({
      user_name: participant.user_name,
      user_id: participant.user_id,
      seat: currentSeat,
      participant_hash: participant.participant_hash,
    });
  }

  const assignedParticipantIds = new Set(assignments.map((a) => a.user_id));
  for (const participant of participants) {
    if (assignments.length >= maxSeats) {
      break;
    }

    if (assignedParticipantIds.has(participant.user_id)) {
      continue;
    }

    const seat = freeSeats.shift();
    if (!seat) {
      break;
    }

    if (participant.seat !== seat) {
      await repositories.participants.update(participant.id, { seat });
    }
    seenSeats.add(seat);
    assignments.push({
      user_name: participant.user_name,
      user_id: participant.user_id,
      seat,
      participant_hash: participant.participant_hash,
    });
  }

  return assignments;
}

export async function changeSeat(participantHash: string, newSeat: string) {
  const participant = await repositories.participants.getByHash(participantHash);
  if (!participant) {
    throw new Error("Participant not found");
  }
  const flight = await repositories.flights.getById(participant.flight_id);
  if (!flight) {
    throw new Error("Flight not found");
  }
  const requestedSeat = normalizeSeatId(newSeat);
  const allParticipants = await repositories.participants.getByFlight(participant.flight_id);
  const occupant = allParticipants.find(
    (current) => current.seat && normalizeSeatId(current.seat) === requestedSeat && current.id !== participant.id,
  );
  if (occupant) {
    throw new Error("Seat is already occupied");
  }

  const validSeats = getValidSeatIds(flight.seat_config || "3-3", flight.aircraft_total_seats || 180);
  if (!validSeats.includes(requestedSeat)) {
    throw new Error("Invalid seat");
  }
  const oldSeat = participant.seat;
  await repositories.participants.update(participant.id, { seat: requestedSeat });
  return { oldSeat, newSeat: requestedSeat };
}

export async function addParticipant(flightId: number, userId: string, userName: string) {
  const lockToken = await repositories.locks.acquire(`flight:join:${flightId}`, 10);
  if (!lockToken) {
    throw new Error("Boarding is busy right now. Please try again.");
  }

  try {
    const existing = await repositories.participants.getByFlightAndUser(flightId, userId);
    if (existing) {
      return { alreadyJoined: true, participant: existing };
    }

    const flight = await repositories.flights.getById(flightId);
    if (!flight || flight.status !== "boarding") {
      throw new Error("Boarding is no longer active");
    }

    const participantCount = await repositories.participants.countByFlight(flightId);
    if (participantCount >= (flight.aircraft_total_seats || 180)) {
      throw new Error("Dieser Flug ist bereits ausgebucht.");
    }

    const participant = await repositories.participants.create({
      flight_id: flightId,
      user_id: userId,
      user_name: userName,
      participant_hash: nanoid(12),
      seat: undefined,
      joined_at: Date.now(),
      miles_earned: 0,
    });
    if (!participant) {
      const raceWinner = await repositories.participants.getByFlightAndUser(flightId, userId);
      if (!raceWinner) {
        throw new Error(`Race condition: participant key exists but record not found for flight ${flightId}, user ${userId}`);
      }
      return { alreadyJoined: true, participant: raceWinner };
    }
    return { alreadyJoined: false, participant };
  } finally {
    await repositories.locks.release(`flight:join:${flightId}`, lockToken);
  }
}

function generateBoardingPass(participant: Participant, flight: Flight) {
  const now = new Date();
  return {
    passenger_name: participant.user_name.toUpperCase(),
    flight_number: flight.flight_number || `SK${flight.id}`,
    seat: participant.seat || "TBD",
    gate: flight.dep_gate || "A1",
    departure: flight.dep_name || flight.icao_from,
    arrival: flight.arr_name || flight.icao_to,
    dep_code: flight.icao_from,
    arr_code: flight.icao_to,
    date: now.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" }),
    boarding_time: now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }),
    aircraft: flight.aircraft_name || "Aircraft",
  };
}

export function getDashboardUrl(participantHash: string): string {
  const base = milesandmorebotEnv.frontendUrl || milesandmorebotEnv.appUrl;
  return `${base}/flight/${participantHash}`;
}

export async function awardFlightRewards(flightId: number) {
  const locked = await repositories.flights.tryAcquireRewardLock(flightId);
  if (!locked) {
    return [];
  }
  try {
    const flight = await repositories.flights.getById(flightId);
    if (!flight) {
      throw new Error("Flight not found");
    }
    const participants = await repositories.participants.getByFlight(flightId);
    const miles = Math.round(flight.distance_nm || 100);
    const results = [];
    for (const participant of participants) {
      if ((participant.miles_earned || 0) > 0) {
        continue;
      }

      let milesApplied = false;
      let countryUnlocked = false;

      try {
        await repositories.userMiles.addMiles(participant.user_id, participant.user_name, miles);
        milesApplied = true;

        if (flight.arr_country) {
          countryUnlocked = await repositories.userCountries.unlock(
            participant.user_id,
            flight.arr_country,
            flight.arr_country_name || flight.arr_country,
            flightId,
          );
        }

        const updated = await repositories.participants.update(participant.id, { miles_earned: miles });
        if (!updated) {
          throw new Error(`Participant ${participant.id} disappeared during reward processing`);
        }

        results.push({
          user_name: participant.user_name,
          user_id: participant.user_id,
          miles_earned: miles,
          country_unlocked: countryUnlocked ? flight.arr_country || null : null,
        });
      } catch (error) {
        if (countryUnlocked && flight.arr_country) {
          await repositories.userCountries.remove(participant.user_id, flight.arr_country);
        }
        if (milesApplied) {
          await repositories.userMiles.subtractMiles(participant.user_id, miles);
        }
        throw error;
      }
    }
    return results;
  } finally {
    await repositories.flights.releaseRewardLock(flightId);
  }
}

export async function finishBoardingJob(
  flightId: number,
  channelName: string,
  lifecycleVersion?: number,
): Promise<void> {
  const flight = await repositories.flights.getById(flightId);
  if (
    !flight ||
    flight.status !== "boarding" ||
    getLifecycleVersion(flight) !== Math.max(1, lifecycleVersion || 1) ||
    (flight.close_at || 0) > Date.now()
  ) {
    return;
  }
  const latestFlight = await repositories.flights.getById(flightId);
  if (
    !latestFlight ||
    latestFlight.status !== "boarding" ||
    getLifecycleVersion(latestFlight) !== Math.max(1, lifecycleVersion || 1) ||
    (latestFlight.close_at || 0) > Date.now()
  ) {
    return;
  }
  const assignments = await assignSeats(flightId);
  await updateFlightStatus(flightId, "in_flight");
  await say(channelName, `✅ Boarding abgeschlossen · ${assignments.length} Passagiere · Guten Flug! peepoLove`);
}

export async function sendBoardingWarningJob(
  flightId: number,
  channelName: string,
  warningMinutes?: number,
  lifecycleVersion?: number,
): Promise<void> {
  const flight = await repositories.flights.getById(flightId);
  if (
    !flight ||
    flight.status !== "boarding" ||
    getLifecycleVersion(flight) !== Math.max(1, lifecycleVersion || 1) ||
    (flight.warning_at || 0) > Date.now()
  ) {
    return;
  }
  const warningLock = await repositories.locks.acquire(
    `flight:warning:${flightId}:${Math.max(1, lifecycleVersion || 1)}`,
    60 * 60,
  );
  if (!warningLock) {
    return;
  }
  const depName = flight.dep_name || flight.icao_from;
  const arrName = flight.arr_name || flight.icao_to;
  if ((warningMinutes || 0) >= 5) {
    await say(channelName, `⏰ Noch 5 Min | ${depName}→${arrName} | &joinflight DinkDonk`);
    return;
  }
  await say(channelName, `⏰ Letzter Aufruf monkaS | ${depName}→${arrName} | &joinflight DinkDonk`);
}

export async function getParticipantByHash(hash: string) {
  return repositories.participants.getByHashWithFlight(hash);
}

export async function getFlightParticipants(flightId: number) {
  return repositories.participants.getByFlight(flightId);
}

export async function getOccupiedSeats(flightId: number) {
  return repositories.participants.getOccupiedSeats(flightId);
}

export async function getUserStats(userId: string) {
  const miles = await repositories.userMiles.get(userId);
  const countries = await repositories.userCountries.getByUser(userId);
  return {
    miles: miles || { total_miles: 0, total_flights: 0, user_id: userId, user_name: userId },
    countries,
  };
}

export async function getCountryLeaderboard(limit = 20) {
  return repositories.userCountries.getLeaderboard(limit);
}

export async function getMilesLeaderboard(limit = 20) {
  return repositories.userMiles.getTopMiles(limit);
}

export async function addManagedChannel(channelName: string) {
  const lower = channelName.toLowerCase();
  const user = await getUserByLogin(lower);
  if (!user) {
    throw new Error(`Unknown Twitch user: ${channelName}`);
  }
  let channelCreated = false;
  await repositories.channels.add(lower, user.id).catch(async (error: Error & { code?: string }) => {
    if (error.code !== "ER_DUP_ENTRY") {
      throw error;
    }
  });

  try {
    const channel = await repositories.managedChannels.add(lower, user.id);
    channelCreated = true;
    await setPrefix(user.id, "&");
    await repositories.cooldowns.clearCooldown(`channel:${user.id}:muted`);
    await joinIrcChannel(lower);
    await say(lower, "Miles & More ist jetzt an Bord. peepoHey");
    return channel;
  } catch (error) {
    if (channelCreated) {
      await repositories.managedChannels.remove(lower);
    }
    await repositories.channels.remove(lower);
    throw error;
  }
}

export async function removeManagedChannel(channelName: string) {
  const lower = channelName.toLowerCase();
  await repositories.managedChannels.remove(lower);
  await repositories.channels.remove(lower);
  await partIrcChannel(lower);
}

export async function fetchSimBriefFlightPlan(pilotId: string): Promise<SimBriefFlightPlan> {
  const response = await fetch(
    `https://www.simbrief.com/api/xml.fetcher.php?username=${encodeURIComponent(pilotId)}&json=1`,
  );
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok || !data.origin || !data.destination) {
    throw new Error("Invalid SimBrief response - no flight plan found");
  }

  const aircraftIcao = String((data.aircraft as { icaocode?: string } | undefined)?.icaocode || "A320");
  const defaults = AIRCRAFT_DEFAULTS[aircraftIcao as keyof typeof AIRCRAFT_DEFAULTS] || AIRCRAFT_DEFAULTS.A320;
  const dbConfig = await repositories.aircraftConfigs.get(aircraftIcao);
  const seatConfig = dbConfig?.seat_config || defaults.config;
  const totalSeats = dbConfig?.total_seats || defaults.seats;

  return {
    ofp_id: String((data.params as { ofp_id?: string } | undefined)?.ofp_id || ""),
    flight_number: String(
      (data.general as { flight_number?: string; icao_airline?: string } | undefined)?.flight_number ||
        `${(data.general as { icao_airline?: string } | undefined)?.icao_airline || "SK"}000`,
    ),
    aircraft: {
      icao: aircraftIcao,
      name: String((data.aircraft as { name?: string } | undefined)?.name || defaults.name),
    },
    origin: {
      icao: String((data.origin as { icao_code?: string } | undefined)?.icao_code || ""),
      name: String((data.origin as { name?: string } | undefined)?.name || ""),
      gate: String((data.origin as { plan_rwy?: string } | undefined)?.plan_rwy || ""),
      country: String((data.origin as { country?: string } | undefined)?.country || ""),
      lat: parseFloat(String((data.origin as { pos_lat?: string } | undefined)?.pos_lat || "")) || undefined,
      lon: parseFloat(String((data.origin as { pos_long?: string } | undefined)?.pos_long || "")) || undefined,
    },
    destination: {
      icao: String((data.destination as { icao_code?: string } | undefined)?.icao_code || ""),
      name: String((data.destination as { name?: string } | undefined)?.name || ""),
      gate: String((data.destination as { plan_rwy?: string } | undefined)?.plan_rwy || ""),
      country: String((data.destination as { country?: string } | undefined)?.country || ""),
      country_name: String((data.destination as { country_name?: string; country?: string } | undefined)?.country_name || (data.destination as { country?: string } | undefined)?.country || ""),
      lat: parseFloat(String((data.destination as { pos_lat?: string } | undefined)?.pos_lat || "")) || undefined,
      lon: parseFloat(String((data.destination as { pos_long?: string } | undefined)?.pos_long || "")) || undefined,
    },
    route: String((data.general as { route?: string } | undefined)?.route || ""),
    cruise_altitude: Number.parseInt(String((data.general as { initial_altitude?: string } | undefined)?.initial_altitude || "35000"), 10),
    distance_nm: Number.parseInt(String((data.general as { air_distance?: string } | undefined)?.air_distance || "0"), 10),
    estimated_time_enroute: Number.parseInt(
      String((data.times as { est_time_enroute?: string } | undefined)?.est_time_enroute || "0"),
      10,
    ),
    seat_config: seatConfig,
    total_seats: totalSeats,
  };
}

export async function saveAircraftConfig(
  icaoCode: string,
  name: string,
  seatConfig: string,
  totalSeats: number,
): Promise<void> {
  const seatsPerRow = parseSeatConfig(seatConfig).reduce((sum, value) => sum + value, 0);
  const rows = Math.ceil(totalSeats / seatsPerRow);
  await repositories.aircraftConfigs.set(icaoCode, name, seatConfig, totalSeats, rows);
}

export async function handleSimLinkIngest(payload: SimLinkIngestPayload): Promise<{ connected: boolean; lastData: Record<string, unknown> }> {
  const lat = parseFiniteNumber(payload.latitude ?? payload.lat);
  const lon = parseFiniteNumber(payload.longitude ?? payload.lon);
  const altitude = parseFiniteNumber(payload.altitude ?? payload.alt);
  const speed = parseFiniteNumber(payload.ground_speed ?? payload.speed ?? payload.groundSpeed);
  const heading = parseFiniteNumber(payload.heading ?? payload.hdg);
  const onGround = parseBooleanLike(payload.on_ground ?? payload.onGround);

  const normalized = {
    ...(lat !== undefined ? { lat } : {}),
    ...(lon !== undefined ? { lon } : {}),
    ...(altitude !== undefined ? { alt: Math.round(altitude) } : {}),
    ...(speed !== undefined ? { speed: Math.round(speed) } : {}),
    ...(heading !== undefined ? { heading: Math.round(heading) } : {}),
    ...(onGround !== undefined ? { on_ground: onGround } : {}),
  };
  await repositories.simlink.updateLastData(normalized);
  const status = await repositories.simlink.getStatus();
  if (status.flightId) {
    await repositories.flights.update(status.flightId, {
      ...(lat !== undefined ? { current_lat: lat } : {}),
      ...(lon !== undefined ? { current_lon: lon } : {}),
      ...(altitude !== undefined ? { current_alt: Math.round(altitude) } : {}),
      ...(speed !== undefined ? { current_speed: Math.round(speed) } : {}),
      ...(heading !== undefined ? { current_heading: Math.round(heading) } : {}),
    });
  }
  return {
    connected: true,
    lastData: normalized,
  };
}

const commands: CommandDefinition[] = [
  {
    name: "abortflight",
    aliases: ["af"],
    description: "Breche das Boarding oder den Flug ab.",
    usage: "&abortflight",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.mod,
    async execute(context) {
      const flight = await repositories.flights.getByChannelAndStatus(context.channel.login, ["boarding", "in_flight"]);
      if (!flight) {
        await context.send("Es gibt aktuell keinen aktiven Flug zum Abbrechen. modCheck");
        return;
      }
      {
        const depName = flight.dep_name || flight.icao_from;
        const arrName = flight.arr_name || flight.icao_to;
        if (flight.status === "boarding") {
          await updateFlightStatus(flight.id, "cancelled");
          await context.send(`❌ Das Boarding für den Flug von ${depName} nach ${arrName} wurde abgebrochen. NOPERS`);
        } else {
          await updateFlightStatus(flight.id, "aborted");
          await context.send(`❌ Der Flug von ${depName} nach ${arrName} wurde abgebrochen. Es wurden keine Meilen vergeben. Sadge`);
        }
      }
    },
  },
  {
    name: "clearflights",
    description: "Lösche alle Flüge.",
    usage: "&clearflights",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.owner,
    async execute(context) {
      await repositories.participants.deleteAll();
      await repositories.flights.deleteAll();
      await context.send("Alle Flüge wurden gelöscht. 🗑️ KEKW");
    },
  },
  {
    name: "countries",
    aliases: ["laender"],
    description: "Zeigt deine freigeschalteten Länder.",
    usage: "&countries",
    cooldown: { global: 0, user: 10, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const countries = await repositories.userCountries.getByUser(context.sender.id);
      if (countries.length === 0) {
        await context.send("🌍 Du hast leider noch keine Länder freigeschaltet. YEP");
        return;
      }
      const display = countries.map((country) => `${countryCodeToFlag(country.country_code)} ${country.country_name}`).join(" | ");
      const trimmed = display.length > 400 ? `${display.slice(0, 400)}...` : display;
      await context.send(`🌍 Du hast bereits ${countries.length} Länder bereist: ${trimmed} Clap`);
    },
  },
  {
    name: "endflight",
    aliases: ["ef"],
    description: "Beende deinen aktuellen Flug und vergebe Meilen.",
    usage: "&endflight",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.mod,
    async execute(context) {
      const flight = await repositories.flights.getByChannelAndStatus(context.channel.login, ["in_flight"]);
      if (!flight) {
        await context.send("Du befindest dich derzeit in keinem aktiven Flug. modCheck");
        return;
      }
      const rewards = await awardFlightRewards(flight.id);
      await updateFlightStatus(flight.id, "completed");
      const depName = flight.dep_name || flight.icao_from;
      const arrName = flight.arr_name || flight.icao_to;
      const miles = rewards.length > 0 ? rewards[0].miles_earned : 0;
      const parts = [`🏁 ${depName}→${arrName} ist gelandet Clap`];
      if (rewards.length > 0) parts.push(`| ${rewards.length} Pax | +${miles} Meilen peepoHappy`);
      if (flight.arr_country_name) parts.push(`| ${countryCodeToFlag(flight.arr_country || "")} ${flight.arr_country_name}`);
      await say(context.channel.login, parts.join(" "));
    },
  },
  {
    name: "flight",
    aliases: ["flug"],
    description: "Zeigt den aktuellen Flug im Channel.",
    usage: "&flight",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const flight = await repositories.flights.getByChannelAndStatus(context.channel.login, ["boarding", "in_flight"]);
      if (!flight) {
        await context.send("Es gibt aktuell keinen aktiven Flug. modCheck");
        return;
      }
      const dep = flight.dep_name || flight.icao_from;
      const arr = flight.arr_name || flight.icao_to;
      const pax = await repositories.participants.getByFlight(flight.id);
      const parts = [
        `✈️ ${flight.flight_number || flight.id} ${dep}→${arr}`,
        flight.aircraft_name ? `(${flight.aircraft_name})` : "",
        `| ${flight.status === "boarding" ? "Boarding" : "In Flight"}`,
        `| ${pax.length} Pax`,
      ].filter(Boolean);
      await context.send(parts.join(" "));
    },
  },
  {
    name: "passengers",
    aliases: ["pax"],
    description: "Zeigt die Passagierliste des aktuellen Flugs ohne Pings.",
    usage: "&passengers",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const flight = await repositories.flights.getByChannelAndStatus(context.channel.login, ["boarding", "in_flight"]);
      if (!flight) {
        await context.send("Es gibt aktuell keinen aktiven Flug. modCheck");
        return;
      }

      const passengers = await repositories.participants.getByFlight(flight.id);
      if (passengers.length === 0) {
        await context.send("Es sind noch keine Passagiere an Bord. monkaW");
        return;
      }

      const manifest = passengers.map((passenger) => formatSafeMention(passenger.user_name)).join(", ");
      await context.send(`🧾 ${passengers.length} Pax: ${manifest}`);
    },
  },
  {
    name: "flights",
    description: "Zeige alle laufenden Flüge.",
    usage: "&flights",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.owner,
    async execute(context) {
      const all = [...(await repositories.flights.getByStatus("boarding")), ...(await repositories.flights.getByStatus("in_flight"))];
      if (all.length === 0) {
        await context.send("Es gibt derzeit keine aktiven Flüge. zzz");
        return;
      }
      const list = all
        .map((flight) => `${flight.flight_number || flight.id}: ${flight.dep_name || flight.icao_from}→${flight.arr_name || flight.icao_to} (${flight.status})`)
        .join(" | ");
      await context.send(`✈️ ${all.length} Flüge: ${list}`);
    },
  },
  {
    name: "join",
    aliases: ["addbot"],
    description: "Add the bot to your channel.",
    usage: "&join [username]",
    cooldown: { global: 0, user: 3, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      let channelName = context.sender.login;
      if (context.sender.perms >= permissions.admin && context.args[0]) {
        channelName = context.args[0].toLowerCase();
      }
      try {
        await addManagedChannel(channelName);
      } catch (err) {
        await context.send(err instanceof Error ? err.message : "Konnte den Kanal nicht hinzufügen.");
        return;
      }
    },
  },
  {
    name: "joinflight",
    aliases: ["jf"],
    description: "Tritt einem aktiven Flug bei.",
    usage: "&joinflight",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.user,
    async execute(context) {
      const activeFlight = await repositories.flights.getByChannelAndStatus(context.channel.login, ["boarding"]);
      if (!activeFlight || (activeFlight.end_time || 0) < Date.now()) {
        await context.send("Es gibt aktuell keinen aktiven Flug, dem du beitreten könntest. NOPERS");
        return;
      }
      const result = await addParticipant(activeFlight.id, context.sender.id, context.sender.login);
      if (result.alreadyJoined) {
        await context.send(`Du bist bereits an Bord, ${context.sender.login}! KEKW`);
        return;
      }
      const boardingPass = generateBoardingPass(result.participant, activeFlight);
      await repositories.participants.update(result.participant.id, { boarding_pass_data: boardingPass });
      const dashboardUrl = getDashboardUrl(result.participant.participant_hash);
      await context.send(`✈️ ${context.sender.login} ist an Bord! Den persönlichen Boarding Pass gibt's per Whisper.`);
      try {
        await sendWhisper(context.sender.id, `✈️ Dein persönlicher Boarding Pass: ${dashboardUrl}`);
      } catch (err) {
        await milesandmorebotLogger.error(`[Whisper] Konnte Whisper an ${context.sender.login} nicht senden: ${err instanceof Error ? err.message : err}`);
        await context.send(`@${context.sender.login} Whisper fehlgeschlagen – bitte aktiviere Twitch-Whispers und versuche den Befehl erneut.`);
      }
    },
  },
  {
    name: "miles",
    aliases: ["meilen", "stats"],
    description: "Zeigt deine Meilen und Flüge.",
    usage: "&miles",
    cooldown: { global: 0, user: 10, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const stats = await repositories.userMiles.get(context.sender.id);
      const countries = await repositories.userCountries.countByUser(context.sender.id);
      if (!stats) {
        await context.send("Du hast bisher noch keine absolvierten Flüge. ✈️ KEKW");
        return;
      }
      await context.send(`✈️ ${stats.user_name}: ${stats.total_miles.toLocaleString()} Meilen | ${stats.total_flights} Flüge | ${countries} Länder`);
    },
  },
  {
    name: "mute",
    aliases: ["shutup", "silence", "pausebot", "stopbot", "disablebot", "off"],
    description: "Schaltet den Bot für 12 Stunden in diesem Channel stumm.",
    usage: "&mute",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.mod,
    async execute(context) {
      await repositories.cooldowns.setCooldown(`channel:${context.channel.id}:muted`, 12 * 60 * 60);
      await context.send("🔇 Der Bot ist nun für 12 Stunden stummgeschaltet. Modge");
    },
  },
  {
    name: "ping",
    aliases: ["uptime"],
    description: "Shows infos about the bot.",
    usage: "&ping",
    cooldown: { global: 0, user: 3, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const [latency, status] = await Promise.all([measurePing(), repositories.status.get()]);
      const uptime = process.uptime();
      const memoryMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
      await context.send(
        [
          `Uptime: ${formatUptime(uptime)}`,
          `Ping: ${latency}ms`,
          `RAM: ${memoryMb}MB`,
          `${status.channels} Ch`,
          `${status.commandsExecuted} Cmds`,
          `${commands.length} Commands`,
        ].join(" | "),
      );
    },
  },
  {
    name: "seat",
    aliases: ["sitz", "sitzplatz"],
    description: "Zeigt deinen Sitzplatz im aktuellen Flug.",
    usage: "&seat",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const participant = await repositories.participants.getActiveByUser(context.sender.id);
      if (!participant) {
        await context.send("Du bist derzeit keinem aktiven Flug zugeordnet. modCheck");
        return;
      }
      const dep = participant.dep_name || participant.icao_from || "";
      const arr = participant.arr_name || participant.icao_to || "";
      const seat = participant.seat || "TBD";
      await context.send(`🪑 Sitz ${seat} | ${participant.flight_number || "Flug"} ${dep}→${arr} | Dashboard-Link: &passenger`);
    },
  },
  {
    name: "passenger",
    aliases: ["boardingpass", "mylink", "link"],
    description: "Schickt dir deinen persönlichen Dashboard-Link per Whisper.",
    usage: "&passenger",
    cooldown: { global: 0, user: 10, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const participant = await repositories.participants.getActiveByUser(context.sender.id);
      if (!participant) {
        await context.send(`@${context.sender.login} Du bist derzeit keinem aktiven Flug zugeordnet. modCheck`);
        return;
      }
      const dashboardUrl = getDashboardUrl(participant.participant_hash);
      try {
        await sendWhisper(context.sender.id, `✈️ Dein persönlicher Boarding Pass: ${dashboardUrl}`);
        await context.send(`@${context.sender.login} Dein Dashboard-Link wurde dir per Whisper geschickt! ✈️`);
      } catch (err) {
        await milesandmorebotLogger.error(`[Whisper] Konnte Whisper an ${context.sender.login} nicht senden: ${err instanceof Error ? err.message : err}`);
        await context.send(`@${context.sender.login} Whisper fehlgeschlagen – bitte aktiviere Whispers von Fremden in deinen Twitch-Einstellungen.`);
      }
    },
  },
  {
    name: "status",
    aliases: ["botstatus"],
    description: "Zeigt den aktuellen Bot- und Flugstatus.",
    usage: "&status",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const flight = await repositories.flights.getByChannelAndStatus(context.channel.login, ["boarding", "in_flight"]);
      if (!flight) {
        const botStatus = await repositories.status.get();
        await context.send(`Status: bereit · In ${botStatus.channels} Channels aktiv. peepoHappy`);
        return;
      }

      const pax = await repositories.participants.getByFlight(flight.id);
      if (flight.status === "boarding") {
        const remainingMinutes = Math.max(0, Math.ceil(((flight.end_time || Date.now()) - Date.now()) / 60_000));
        await context.send(
          `Status: Boarding ${flight.icao_from}→${flight.icao_to} | noch ${remainingMinutes} Min | ${pax.length} Pax.`,
        );
        return;
      }

      await context.send(`Status: In der Luft ${flight.icao_from}→${flight.icao_to} | ${pax.length} Pax.`);
    },
  },
  {
    name: "startflight",
    aliases: ["sf"],
    description: "Kündigt den Beginn des Boardings für einen Flug an.",
    usage: "&startflight [ICAO von] [ICAO nach]",
    cooldown: { global: 0, user: 10, channel: 0 },
    permissionLevel: permissions.admin,
    async execute(context) {
      if (context.args.length < 2) {
        await context.send("Bitte gib sowohl den ICAO-Code des Abflughafens als auch des Zielhafens an.");
        return;
      }
      await createFlight({
        channel_name: context.channel.login,
        icao_from: context.args[0].toUpperCase(),
        icao_to: context.args[1].toUpperCase(),
        pilot: context.sender.login,
      });
    },
  },
  {
    name: "topcountries",
    aliases: ["laenderlb", "countrieslb"],
    description: "Top 5 Länder-Leaderboard.",
    usage: "&topcountries",
    cooldown: { global: 0, user: 15, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const top = await repositories.userCountries.getTopCountries(5);
      if (top.length === 0) {
        await context.send("Es sind noch keine Daten verfügbar. Sadge");
        return;
      }
      const list = top.map((entry, index) => `${index + 1}. ${entry.user_name} (${entry.countries_count})`).join(" | ");
      await context.send(`🌍 Top Länder: ${list}`);
    },
  },
  {
    name: "topmiles",
    aliases: ["meilenlb", "mileslb"],
    description: "Top 5 Meilen-Leaderboard.",
    usage: "&topmiles",
    cooldown: { global: 0, user: 15, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const top = await repositories.userMiles.getTopMiles(5);
      if (top.length === 0) {
        await context.send("Es sind noch keine Daten verfügbar. Sadge");
        return;
      }
      const list = top.map((entry, index) => `${index + 1}. ${entry.user_name} (${entry.total_miles.toLocaleString()})`).join(" | ");
      await context.send(`🏆 Top Meilen: ${list}`);
    },
  },
  {
    name: "uid",
    aliases: ["userid"],
    description: "Gives you the UID of a User",
    usage: "&uid <Username>",
    cooldown: { global: 0, user: 3, channel: 0 },
    permissionLevel: permissions.default,
    async execute(context) {
      const username = context.args[0] || context.sender.login;
      const userId = await resolveUserId(username);
      if (!userId) {
        await context.send(`User ${username} not found.`, false);
        return;
      }
      await context.send(`👉 @${username} - ${userId}`);
    },
  },
  {
    name: "unmute",
    aliases: ["unpausebot", "enablebot", "on", "turnon"],
    description: "Hebt die Stummschaltung des Bots in diesem Channel auf.",
    usage: "&unmute",
    cooldown: { global: 0, user: 5, channel: 0 },
    permissionLevel: permissions.mod,
    async execute(context) {
      const key = `channel:${context.channel.id}:muted`;
      const wasMuted = await repositories.cooldowns.isOnCooldown(key);
      await repositories.cooldowns.clearCooldown(key);
      await context.send(wasMuted ? "🔊 Der Bot ist wieder aktiv. PogChamp" : "Der Bot war nicht stummgeschaltet. KEKW");
    },
  },
];

const commandMap = new Map<string, CommandDefinition>();
for (const command of commands) {
  commandMap.set(command.name, command);
  for (const alias of command.aliases || []) {
    commandMap.set(alias, command);
  }
}

export function getCommandsMetadata() {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    usage: command.usage,
    aliases: command.aliases || [],
    cooldown: command.cooldown,
    permissionLevel:
      command.permissionLevel === permissions.owner
        ? "Owner"
        : command.permissionLevel === permissions.admin
          ? "Admin"
          : command.permissionLevel === permissions.broadcaster
            ? "Broadcaster"
            : command.permissionLevel === permissions.mod
              ? "Moderator"
              : command.permissionLevel === permissions.vip
                ? "VIP"
                : "Everyone",
  }));
}

export async function handleChatMessage(ircMessage: TwitchChatMessage): Promise<boolean> {
  const prefix = await getPrefix(ircMessage.channelID);
  if (!ircMessage.messageText.startsWith(prefix)) {
    return false;
  }

  const commandString = ircMessage.messageText.slice(prefix.length).trimStart();
  const args = commandString.split(/\s+/).filter(Boolean);
  const trigger = (args.shift() || "").toLowerCase();
  if (!trigger) {
    return false;
  }

  const command = commandMap.get(trigger);
  if (!command) {
    return false;
  }

  const userPermission = await getUserPermission(ircMessage.senderUserID, ircMessage.badges);
  const send = async (message: string, _reply = true) => {
    await say(ircMessage.channelName, message);
  };

  if (command.name !== "unmute" && (await repositories.cooldowns.isOnCooldown(`channel:${ircMessage.channelID}:muted`))) {
    if (!(await repositories.cooldowns.isOnCooldown(`notice:muted:${ircMessage.channelID}:${ircMessage.senderUserID}`))) {
      await repositories.cooldowns.setCooldown(`notice:muted:${ircMessage.channelID}:${ircMessage.senderUserID}`, 30);
      await send(`Bot ist aktuell stummgeschaltet. Nutze ${prefix}unmute.`);
    }
    return true;
  }

  if (userPermission < permissions.admin && (await repositories.channelSettings.exists(ircMessage.channelID, `disabledCmd:${command.name}`))) {
    await send("This Command is disabled in this Channel");
    return true;
  }

  if (await repositories.blacklist.has(ircMessage.senderUserID)) {
    const blacklistKey = `ignoredUsers:${ircMessage.senderUserID}:${command.name}`;
    if (!(await repositories.cooldowns.isOnCooldown(`cooldown:user:${blacklistKey}`))) {
      await repositories.cooldowns.setCooldown(`cooldown:user:${blacklistKey}`, 10);
      await send("You are on the Blacklist of the Bot");
    }
    return true;
  }

  if (userPermission < command.permissionLevel) {
    await send(
      command.permissionLevel === permissions.vip
        ? "You need to be VIP to use that Command"
        : command.permissionLevel === permissions.mod
          ? "You need to be Mod to use that Command"
          : command.permissionLevel === permissions.broadcaster
            ? "You need to be Broadcaster to use that Command"
            : command.permissionLevel === permissions.admin
              ? "You need to be Admin to use that Command"
              : command.permissionLevel === permissions.owner
                ? "You need to be Owner to use that Command"
                : "You need to be Everyone to use that Command",
    );
    return true;
  }

  const isExempt = userPermission >= permissions.admin;
  const cooldownKeys: string[] = [];
  if (!isExempt && command.cooldown.global && (await repositories.cooldowns.isOnCooldown(`global:${command.name}`))) {
    if (!(await repositories.cooldowns.isOnCooldown(`notice:cooldown:global:${command.name}:${ircMessage.channelID}`))) {
      await repositories.cooldowns.setCooldown(`notice:cooldown:global:${command.name}:${ircMessage.channelID}`, 3);
      await send("Bitte kurz warten. (Cooldown) DinkDonk", false);
    }
    return true;
  }
  if (!isExempt && command.cooldown.user && (await repositories.cooldowns.isOnCooldown(`user:${command.name}:${ircMessage.senderUserID}`))) {
    if (!(await repositories.cooldowns.isOnCooldown(`notice:cooldown:user:${command.name}:${ircMessage.senderUserID}`))) {
      await repositories.cooldowns.setCooldown(`notice:cooldown:user:${command.name}:${ircMessage.senderUserID}`, 3);
      await send("Bitte kurz warten. (Cooldown) DinkDonk", false);
    }
    return true;
  }
  if (!isExempt && command.cooldown.channel && (await repositories.cooldowns.isOnCooldown(`channel:${command.name}:${ircMessage.channelID}`))) {
    if (!(await repositories.cooldowns.isOnCooldown(`notice:cooldown:channel:${command.name}:${ircMessage.channelID}`))) {
      await repositories.cooldowns.setCooldown(`notice:cooldown:channel:${command.name}:${ircMessage.channelID}`, 3);
      await send("Bitte kurz warten. (Cooldown) DinkDonk", false);
    }
    return true;
  }

  if (!isExempt) {
    if (command.cooldown.global) {
      const key = `global:${command.name}`;
      await repositories.cooldowns.setCooldown(key, command.cooldown.global);
      cooldownKeys.push(key);
    }
    if (command.cooldown.user) {
      const key = `user:${command.name}:${ircMessage.senderUserID}`;
      await repositories.cooldowns.setCooldown(key, command.cooldown.user);
      cooldownKeys.push(key);
    }
    if (command.cooldown.channel) {
      const key = `channel:${command.name}:${ircMessage.channelID}`;
      await repositories.cooldowns.setCooldown(key, command.cooldown.channel);
      cooldownKeys.push(key);
    }
  }

  try {
    await command.execute({
      args,
      channel: { id: ircMessage.channelID, login: ircMessage.channelName },
      command,
      displayName: ircMessage.displayName,
      messageId: ircMessage.messageID,
      sender: { id: ircMessage.senderUserID, login: ircMessage.senderUsername, perms: userPermission },
      text: ircMessage.messageText,
      send,
    });
  } catch (error) {
    await Promise.all(cooldownKeys.map((key) => repositories.cooldowns.clearCooldown(key)));
    await milesandmorebotLogger.error(
      `[#${ircMessage.channelName}] command ${command.name} failed for ${ircMessage.senderUsername}: ${error instanceof Error ? error.message : String(error)}`,
    );
    await send("Interner Fehler beim Ausfuehren des Commands.");
    return true;
  }

  await repositories.status.incrementCommandsExecuted();
  await repositories.status.setLastEventAt();
  await milesandmorebotLogger.irc(`[#${ircMessage.channelName}] ${ircMessage.displayName}: ${ircMessage.messageText}`);
  return true;
}
