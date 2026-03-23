import { Redis } from "@upstash/redis";
import {
  type BotStatus,
  type ChannelRecord,
  type Flight,
  type ManagedChannel,
  type Participant,
} from "../lib/types";

type UserMilesRecord = {
  user_id: string;
  user_name: string;
  total_miles: number;
  total_flights: number;
};

type UserCountryRecord = {
  user_id: string;
  country_code: string;
  country_name: string;
  unlocked_at: number;
  flight_id: number;
};

type AircraftConfigRecord = {
  icao_code: string;
  name: string;
  seat_config: string;
  total_seats: number;
  rows_count: number;
};

type BotCredentialRecord = {
  botClientId: string;
  accessToken: string;
  refreshToken: string;
  botUserId?: string;
  botUsername?: string;
  botDisplayName?: string;
  scopes?: string[];
  updatedAt: number;
  updatedBy?: string;
};

let redisSingleton: Redis | null = null;

export function getRedis(): Redis {
  if (!redisSingleton) {
    redisSingleton = Redis.fromEnv();
  }
  return redisSingleton;
}

function key(...parts: Array<string | number>): string {
  return `mb:${parts.join(":")}`;
}

async function nextId(name: string): Promise<number> {
  return Number(await getRedis().incr(key("seq", name)));
}

async function getObject<T>(objectKey: string): Promise<T | null> {
  return ((await getRedis().get<T>(objectKey)) || null) as T | null;
}

async function setObject(objectKey: string, value: unknown): Promise<void> {
  await getRedis().set(objectKey, value);
}

async function getIdsFromSortedSet(indexKey: string, limit?: number): Promise<string[]> {
  const end = typeof limit === "number" ? Math.max(0, limit - 1) : -1;
  const ids = ((await getRedis().zrange(indexKey, 0, end, { rev: true })) || []) as string[];
  return ids.map(String);
}

async function getIdsFromSet(indexKey: string): Promise<string[]> {
  const ids = ((await getRedis().smembers(indexKey)) || []) as string[];
  return ids.map(String);
}

async function loadMany<T>(ids: Array<string | number>, loader: (id: string) => Promise<T | null>): Promise<T[]> {
  const values = await Promise.all(ids.map((id) => loader(String(id))));
  return values.filter((value) => value !== null) as T[];
}

export const repositories = {
  async ensureBootTimestamp(): Promise<number> {
    const existing = await getRedis().get<number>(key("status", "bootedAt"));
    if (existing) {
      return Number(existing);
    }
    const now = Date.now();
    await getRedis().set(key("status", "bootedAt"), now, { nx: true });
    return Number((await getRedis().get<number>(key("status", "bootedAt"))) || now);
  },

  status: {
    async restart(timestamp = Date.now()): Promise<void> {
      await getRedis().set(key("status", "bootedAt"), timestamp);
    },
    async incrementCommandsExecuted(): Promise<number> {
      return Number(await getRedis().incr(key("status", "commandsExecuted")));
    },
    async setLastEventAt(timestamp = Date.now()): Promise<void> {
      await getRedis().set(key("status", "lastEventAt"), timestamp);
    },
    async get(): Promise<BotStatus> {
      const redis = getRedis();
      const [bootedAt, commandsExecuted, lastEventAt, channels, boarding, inFlight] = await Promise.all([
        repositories.ensureBootTimestamp(),
        redis.get<number>(key("status", "commandsExecuted")),
        redis.get<number>(key("status", "lastEventAt")),
        repositories.managedChannels.getAll(),
        repositories.flights.getByStatus("boarding"),
        repositories.flights.getByStatus("in_flight"),
      ]);

      return {
        uptime: Math.max(0, Date.now() - Number(bootedAt)),
        channels: channels.length,
        commandsExecuted: Number(commandsExecuted || 0),
        activeFlights: boarding.length + inFlight.length,
        lastEventAt: lastEventAt ? Number(lastEventAt) : null,
      };
    },
  },

  flights: {
    async create(data: Omit<Flight, "id">): Promise<Flight> {
      const redis = getRedis();
      const id = await nextId("flight");
      const createdAt = data.created_at || Date.now();
      const flight: Flight = { ...data, id, created_at: createdAt };

      const pipeline = redis.pipeline();
      pipeline.set(key("flight", id), flight);
      pipeline.zadd(key("flights", "all"), { score: createdAt, member: String(id) });
      pipeline.zadd(key("flights", "status", flight.status), { score: createdAt, member: String(id) });
      pipeline.zadd(key("flights", "channel", flight.channel_name), { score: createdAt, member: String(id) });
      if (flight.boarding_hash) {
        pipeline.set(key("flight", "hash", flight.boarding_hash), id);
      }
      await pipeline.exec();
      return flight;
    },

    async getById(id: number): Promise<Flight | null> {
      return getObject<Flight>(key("flight", id));
    },

    async getByHash(hash: string): Promise<Flight | null> {
      const id = await getRedis().get<number>(key("flight", "hash", hash));
      return id ? repositories.flights.getById(Number(id)) : null;
    },

    async getByChannelAndStatus(channel: string, statuses: string[]): Promise<Flight | null> {
      const ids = await getIdsFromSortedSet(key("flights", "channel", channel));
      for (const id of ids) {
        const flight = await repositories.flights.getById(Number(id));
        if (flight && statuses.includes(flight.status)) {
          return flight;
        }
      }
      return null;
    },

    async getByStatus(status: string): Promise<Flight[]> {
      const ids = await getIdsFromSortedSet(key("flights", "status", status));
      return loadMany(ids, (id) => repositories.flights.getById(Number(id)));
    },

    async getRecent(limit = 20): Promise<Flight[]> {
      const ids = await getIdsFromSortedSet(key("flights", "all"), limit);
      return loadMany(ids, (id) => repositories.flights.getById(Number(id)));
    },

    async update(id: number, fields: Partial<Flight>): Promise<Flight | null> {
      const redis = getRedis();
      const current = await repositories.flights.getById(id);
      if (!current) {
        return null;
      }
      const updated: Flight = { ...current, ...fields };
      const pipeline = redis.pipeline();
      pipeline.set(key("flight", id), updated);

      if (current.status !== updated.status) {
        pipeline.zrem(key("flights", "status", current.status), String(id));
        pipeline.zadd(key("flights", "status", updated.status), {
          score: updated.created_at || Date.now(),
          member: String(id),
        });
      }
      if (current.channel_name !== updated.channel_name) {
        pipeline.zrem(key("flights", "channel", current.channel_name), String(id));
        pipeline.zadd(key("flights", "channel", updated.channel_name), {
          score: updated.created_at || Date.now(),
          member: String(id),
        });
      }
      if (updated.boarding_hash && current.boarding_hash !== updated.boarding_hash) {
        if (current.boarding_hash) {
          pipeline.del(key("flight", "hash", current.boarding_hash));
        }
        pipeline.set(key("flight", "hash", updated.boarding_hash), id);
      }
      await pipeline.exec();
      return updated;
    },

    async delete(id: number): Promise<void> {
      const redis = getRedis();
      const current = await repositories.flights.getById(id);
      if (!current) {
        return;
      }

      const participants = await repositories.participants.getByFlight(id);
      const pipeline = redis.pipeline();
      for (const participant of participants) {
        pipeline.del(key("participant", participant.id));
        pipeline.del(key("participant", "hash", participant.participant_hash));
        pipeline.del(key("participant", "flightUser", id, participant.user_id));
        pipeline.zrem(key("participants", "flight", id), String(participant.id));
        pipeline.zrem(key("participants", "user", participant.user_id), String(participant.id));
      }
      pipeline.del(key("flight", id));
      pipeline.zrem(key("flights", "all"), String(id));
      pipeline.zrem(key("flights", "status", current.status), String(id));
      pipeline.zrem(key("flights", "channel", current.channel_name), String(id));
      if (current.boarding_hash) {
        pipeline.del(key("flight", "hash", current.boarding_hash));
      }
      await pipeline.exec();
    },

    async deleteAll(): Promise<void> {
      const flights = await repositories.flights.getRecent(1000);
      await Promise.all(flights.map((flight) => repositories.flights.delete(flight.id)));
    },
  },

  participants: {
    async create(data: Omit<Participant, "id">): Promise<Participant> {
      const redis = getRedis();
      const id = await nextId("participant");
      const participant: Participant = { ...data, id };
      const pipeline = redis.pipeline();
      pipeline.set(key("participant", id), participant);
      pipeline.set(key("participant", "hash", participant.participant_hash), id);
      pipeline.set(key("participant", "flightUser", participant.flight_id, participant.user_id), id);
      pipeline.zadd(key("participants", "flight", participant.flight_id), {
        score: participant.joined_at,
        member: String(id),
      });
      pipeline.zadd(key("participants", "user", participant.user_id), {
        score: participant.joined_at,
        member: String(id),
      });
      await pipeline.exec();
      return participant;
    },

    async getById(id: number): Promise<Participant | null> {
      return getObject<Participant>(key("participant", id));
    },

    async getByHash(hash: string): Promise<Participant | null> {
      const id = await getRedis().get<number>(key("participant", "hash", hash));
      return id ? repositories.participants.getById(Number(id)) : null;
    },

    async getByHashWithFlight(hash: string): Promise<(Participant & Record<string, unknown>) | null> {
      const participant = await repositories.participants.getByHash(hash);
      if (!participant) {
        return null;
      }
      const flight = await repositories.flights.getById(participant.flight_id);
      if (!flight) {
        return null;
      }
      return {
        ...participant,
        flight_id: flight.id,
        flight_status: flight.status,
        channel_name: flight.channel_name,
        icao_from: flight.icao_from,
        icao_to: flight.icao_to,
        dep_name: flight.dep_name,
        arr_name: flight.arr_name,
        flight_number: flight.flight_number,
        aircraft_name: flight.aircraft_name,
        aircraft_icao: flight.aircraft_icao,
        seat_config: flight.seat_config,
        aircraft_total_seats: flight.aircraft_total_seats,
        boarding_hash: flight.boarding_hash,
        dep_gate: flight.dep_gate,
        arr_gate: flight.arr_gate,
        start_time: flight.start_time,
        end_time: flight.end_time,
      };
    },

    async getByFlightAndUser(flightId: number, userId: string): Promise<Participant | null> {
      const id = await getRedis().get<number>(key("participant", "flightUser", flightId, userId));
      return id ? repositories.participants.getById(Number(id)) : null;
    },

    async getByFlight(flightId: number): Promise<Participant[]> {
      const ids = await getIdsFromSortedSet(key("participants", "flight", flightId));
      return loadMany(ids, (id) => repositories.participants.getById(Number(id)));
    },

    async getActiveByUser(userId: string): Promise<(Participant & Partial<Flight>) | null> {
      const ids = await getIdsFromSortedSet(key("participants", "user", userId));
      for (const id of ids) {
        const participant = await repositories.participants.getById(Number(id));
        if (!participant) {
          continue;
        }
        const flight = await repositories.flights.getById(participant.flight_id);
        if (flight && ["boarding", "in_flight"].includes(flight.status)) {
          return { ...participant, ...flight };
        }
      }
      return null;
    },

    async update(id: number, fields: Partial<Participant>): Promise<Participant | null> {
      const current = await repositories.participants.getById(id);
      if (!current) {
        return null;
      }
      const updated: Participant = { ...current, ...fields };
      await setObject(key("participant", id), updated);
      return updated;
    },

    async getOccupiedSeats(flightId: number): Promise<Array<Pick<Participant, "user_name" | "user_id" | "participant_hash"> & { seat?: string }>> {
      const participants = await repositories.participants.getByFlight(flightId);
      return participants
        .filter((participant) => participant.seat)
        .map((participant) => ({
          user_name: participant.user_name,
          user_id: participant.user_id,
          seat: participant.seat,
          participant_hash: participant.participant_hash,
        }));
    },

    async deleteByFlight(flightId: number): Promise<void> {
      const participants = await repositories.participants.getByFlight(flightId);
      const pipeline = getRedis().pipeline();
      for (const participant of participants) {
        pipeline.del(key("participant", participant.id));
        pipeline.del(key("participant", "hash", participant.participant_hash));
        pipeline.del(key("participant", "flightUser", participant.flight_id, participant.user_id));
        pipeline.zrem(key("participants", "flight", participant.flight_id), String(participant.id));
        pipeline.zrem(key("participants", "user", participant.user_id), String(participant.id));
      }
      await pipeline.exec();
    },

    async deleteAll(): Promise<void> {
      const flights = await repositories.flights.getRecent(1000);
      await Promise.all(flights.map((flight) => repositories.participants.deleteByFlight(flight.id)));
    },
  },

  userMiles: {
    async get(userId: string): Promise<UserMilesRecord | null> {
      return getObject<UserMilesRecord>(key("userMiles", userId));
    },

    async addMiles(userId: string, userName: string, miles: number): Promise<UserMilesRecord> {
      const current = (await repositories.userMiles.get(userId)) || {
        user_id: userId,
        user_name: userName,
        total_miles: 0,
        total_flights: 0,
      };
      const updated = {
        ...current,
        user_name: userName,
        total_miles: current.total_miles + miles,
        total_flights: current.total_flights + 1,
      };
      const pipeline = getRedis().pipeline();
      pipeline.set(key("userMiles", userId), updated);
      pipeline.zadd(key("leaderboard", "miles"), { score: updated.total_miles, member: userId });
      await pipeline.exec();
      return updated;
    },

    async getTopMiles(limit = 5): Promise<UserMilesRecord[]> {
      const ids = await getIdsFromSortedSet(key("leaderboard", "miles"), limit);
      return loadMany(ids, (id) => repositories.userMiles.get(id));
    },
  },

  userCountries: {
    async unlock(userId: string, countryCode: string, countryName: string, flightId: number): Promise<boolean> {
      const countryKey = key("userCountry", userId, countryCode);
      const record: UserCountryRecord = {
        user_id: userId,
        country_code: countryCode,
        country_name: countryName,
        unlocked_at: Date.now(),
        flight_id: flightId,
      };
      const wasSet = await getRedis().set(countryKey, record, { nx: true });
      if (!wasSet) {
        return false;
      }
      const currentCount = await repositories.userCountries.countByUser(userId);
      const pipeline = getRedis().pipeline();
      pipeline.zadd(key("userCountries", "user", userId), {
        score: record.unlocked_at,
        member: countryCode,
      });
      pipeline.zadd(key("leaderboard", "countries"), {
        score: currentCount + 1,
        member: userId,
      });
      await pipeline.exec();
      return true;
    },

    async getByUser(userId: string): Promise<UserCountryRecord[]> {
      const codes = await getIdsFromSortedSet(key("userCountries", "user", userId));
      return loadMany(codes, (code) => getObject<UserCountryRecord>(key("userCountry", userId, code)));
    },

    async countByUser(userId: string): Promise<number> {
      return Number((await getRedis().zcard(key("userCountries", "user", userId))) || 0);
    },

    async getTopCountries(limit = 5): Promise<Array<UserMilesRecord & { countries_count: number }>> {
      const ids = await getIdsFromSortedSet(key("leaderboard", "countries"), limit);
      const rows = await Promise.all(
        ids.map(async (userId) => {
          const miles = await repositories.userMiles.get(userId);
          const countriesCount = await repositories.userCountries.countByUser(userId);
          return {
            user_id: userId,
            user_name: miles?.user_name || userId,
            total_miles: miles?.total_miles || 0,
            total_flights: miles?.total_flights || 0,
            countries_count: countriesCount,
          };
        }),
      );
      return rows;
    },

    async getLeaderboard(limit = 20): Promise<Array<UserMilesRecord & { countries_count: number }>> {
      return repositories.userCountries.getTopCountries(limit);
    },
  },

  channels: {
    async add(name: string, userId: string): Promise<ChannelRecord> {
      const record: ChannelRecord = { name, user_id: userId, banned: 0 };
      const exists = await getRedis().exists(key("channel", name));
      if (exists) {
        const error = new Error("Duplicate channel");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (error as any).code = "ER_DUP_ENTRY";
        throw error;
      }
      const pipeline = getRedis().pipeline();
      pipeline.set(key("channel", name), record);
      pipeline.set(key("channelByUser", userId), name);
      pipeline.sadd(key("channels"), name);
      await pipeline.exec();
      return record;
    },

    async getAll(): Promise<ChannelRecord[]> {
      const names = await getIdsFromSet(key("channels"));
      return loadMany(names, (name) => getObject<ChannelRecord>(key("channel", name)));
    },

    async remove(name: string): Promise<void> {
      const record = await getObject<ChannelRecord>(key("channel", name));
      const pipeline = getRedis().pipeline();
      pipeline.del(key("channel", name));
      pipeline.srem(key("channels"), name);
      if (record) {
        pipeline.del(key("channelByUser", record.user_id));
      }
      await pipeline.exec();
    },

  },

  managedChannels: {
    async add(channelName: string, channelId?: string): Promise<ManagedChannel> {
      const record: ManagedChannel = {
        id: channelId || channelName,
        channel_name: channelName,
        channel_id: channelId,
        added_at: new Date().toISOString(),
        active: true,
      };
      const pipeline = getRedis().pipeline();
      pipeline.set(key("managedChannel", channelName), record);
      pipeline.sadd(key("managedChannels"), channelName);
      await pipeline.exec();
      return record;
    },

    async get(channelName: string): Promise<ManagedChannel | null> {
      return getObject<ManagedChannel>(key("managedChannel", channelName));
    },

    async getAll(): Promise<ManagedChannel[]> {
      const names = await getIdsFromSet(key("managedChannels"));
      const rows = await loadMany(names, (name) => repositories.managedChannels.get(name));
      return rows.sort((left, right) => right.added_at.localeCompare(left.added_at));
    },

    async remove(channelName: string): Promise<void> {
      const pipeline = getRedis().pipeline();
      pipeline.del(key("managedChannel", channelName));
      pipeline.srem(key("managedChannels"), channelName);
      await pipeline.exec();
    },
  },

  aircraftConfigs: {
    async get(icaoCode: string): Promise<AircraftConfigRecord | null> {
      return getObject<AircraftConfigRecord>(key("aircraftConfig", icaoCode));
    },

    async set(
      icaoCode: string,
      name: string,
      seatConfig: string,
      totalSeats: number,
      rows: number,
    ): Promise<void> {
      await setObject(key("aircraftConfig", icaoCode), {
        icao_code: icaoCode,
        name,
        seat_config: seatConfig,
        total_seats: totalSeats,
        rows_count: rows,
      } satisfies AircraftConfigRecord);
    },
  },

  runtimeConfig: {
    async getBotCredentials(): Promise<BotCredentialRecord | null> {
      return getObject<BotCredentialRecord>(key("runtimeConfig", "botCredentials"));
    },
    async setBotCredentials(value: BotCredentialRecord): Promise<void> {
      await setObject(key("runtimeConfig", "botCredentials"), value);
    },
    async clearBotCredentials(): Promise<void> {
      await getRedis().del(key("runtimeConfig", "botCredentials"));
    },
    async getRestartedAt(): Promise<number | null> {
      const value = await getRedis().get<number>(key("runtimeConfig", "botRestartedAt"));
      return value ? Number(value) : null;
    },
    async markRestarted(timestamp = Date.now()): Promise<void> {
      await getRedis().set(key("runtimeConfig", "botRestartedAt"), timestamp);
    },
  },

  cache: {
    async get(cacheKey: string): Promise<string | null> {
      const value = await getRedis().get<string>(key("cache", cacheKey));
      return value || null;
    },
    async set(cacheKey: string, value: string, ttlSeconds: number): Promise<void> {
      await getRedis().set(key("cache", cacheKey), value, { ex: ttlSeconds });
    },
    async del(cacheKey: string): Promise<void> {
      await getRedis().del(key("cache", cacheKey));
    },
  },

  cooldowns: {
    async isOnCooldown(cooldownKey: string): Promise<boolean> {
      const exists = await getRedis().exists(key("cooldown", cooldownKey));
      return exists === 1;
    },
    async setCooldown(cooldownKey: string, seconds: number): Promise<void> {
      await getRedis().set(key("cooldown", cooldownKey), "1", { ex: seconds });
    },
    async clearCooldown(cooldownKey: string): Promise<void> {
      await getRedis().del(key("cooldown", cooldownKey));
    },
  },

  channelSettings: {
    async get(channelId: string, settingKey: string): Promise<string | null> {
      const value = await getRedis().get<string>(key("channelSetting", channelId, settingKey));
      return value || null;
    },
    async set(channelId: string, settingKey: string, value: string): Promise<void> {
      await getRedis().set(key("channelSetting", channelId, settingKey), value);
    },
    async del(channelId: string, settingKey: string): Promise<void> {
      await getRedis().del(key("channelSetting", channelId, settingKey));
    },
    async exists(channelId: string, settingKey: string): Promise<boolean> {
      return (await getRedis().exists(key("channelSetting", channelId, settingKey))) === 1;
    },
  },

  userPermissions: {
    async get(userId: string): Promise<number | null> {
      const value = await getRedis().get<number>(key("userPermission", userId));
      return value === null || value === undefined ? null : Number(value);
    },
    async set(userId: string, permission: number): Promise<void> {
      await getRedis().set(key("userPermission", userId), permission);
    },
  },

  blacklist: {
    async add(userId: string): Promise<void> {
      await getRedis().sadd(key("blacklist"), userId);
    },
    async remove(userId: string): Promise<void> {
      await getRedis().srem(key("blacklist"), userId);
    },
    async has(userId: string): Promise<boolean> {
      return (await getRedis().sismember(key("blacklist"), userId)) === 1;
    },
    async getAll(): Promise<string[]> {
      return getIdsFromSet(key("blacklist"));
    },
  },

  simlink: {
    async updateLastData(data: Record<string, unknown>): Promise<void> {
      const pipeline = getRedis().pipeline();
      pipeline.set(key("simlink", "lastData"), data);
      pipeline.set(key("simlink", "lastSeenAt"), Date.now());
      await pipeline.exec();
    },
    async getStatus(): Promise<{ connected: boolean; lastData: Record<string, unknown> | null; flightId: number | null }> {
      const [lastData, lastSeenAt, flightId] = await Promise.all([
        getObject<Record<string, unknown>>(key("simlink", "lastData")),
        getRedis().get<number>(key("simlink", "lastSeenAt")),
        getRedis().get<number>(key("simlink", "flightId")),
      ]);
      const connected = !!lastSeenAt && Date.now() - Number(lastSeenAt) < 15000;
      return {
        connected,
        lastData,
        flightId: flightId ? Number(flightId) : null,
      };
    },
    async setFlightId(flightId: number | null): Promise<void> {
      if (flightId === null) {
        await getRedis().del(key("simlink", "flightId"));
      } else {
        await getRedis().set(key("simlink", "flightId"), flightId);
      }
    },
  },
};

export type Repositories = typeof repositories;
