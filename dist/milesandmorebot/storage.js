"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.repositories = void 0;
exports.getRedis = getRedis;
const redis_1 = require("@upstash/redis");
let redisSingleton = null;
function getRedis() {
    if (!redisSingleton) {
        redisSingleton = redis_1.Redis.fromEnv();
    }
    return redisSingleton;
}
function key(...parts) {
    return `mb:${parts.join(":")}`;
}
async function nextId(name) {
    return Number(await getRedis().incr(key("seq", name)));
}
async function getObject(objectKey) {
    return ((await getRedis().get(objectKey)) || null);
}
async function setObject(objectKey, value) {
    await getRedis().set(objectKey, value);
}
async function getIdsFromSortedSet(indexKey, limit) {
    const end = typeof limit === "number" ? Math.max(0, limit - 1) : -1;
    const ids = ((await getRedis().zrange(indexKey, 0, end, { rev: true })) || []);
    return ids.map(String);
}
async function getIdsFromSet(indexKey) {
    const ids = ((await getRedis().smembers(indexKey)) || []);
    return ids.map(String);
}
async function loadMany(ids, loader) {
    const values = await Promise.all(ids.map((id) => loader(String(id))));
    return values.filter((value) => value !== null);
}
exports.repositories = {
    async ensureBootTimestamp() {
        const existing = await getRedis().get(key("status", "bootedAt"));
        if (existing) {
            return Number(existing);
        }
        const now = Date.now();
        await getRedis().set(key("status", "bootedAt"), now, { nx: true });
        return Number((await getRedis().get(key("status", "bootedAt"))) || now);
    },
    status: {
        async restart(timestamp = Date.now()) {
            await getRedis().set(key("status", "bootedAt"), timestamp);
        },
        async incrementCommandsExecuted() {
            return Number(await getRedis().incr(key("status", "commandsExecuted")));
        },
        async setLastEventAt(timestamp = Date.now()) {
            await getRedis().set(key("status", "lastEventAt"), timestamp);
        },
        async get() {
            const redis = getRedis();
            const [bootedAt, commandsExecuted, lastEventAt, channels, boarding, inFlight] = await Promise.all([
                exports.repositories.ensureBootTimestamp(),
                redis.get(key("status", "commandsExecuted")),
                redis.get(key("status", "lastEventAt")),
                exports.repositories.managedChannels.getAll(),
                exports.repositories.flights.getByStatus("boarding"),
                exports.repositories.flights.getByStatus("in_flight"),
            ]);
            return {
                uptime: Math.max(0, Date.now() - Number(bootedAt)),
                channels: channels.length,
                commandsExecuted: Number(commandsExecuted || 0),
                wsClients: 0,
                activeFlights: boarding.length + inFlight.length,
                lastEventAt: lastEventAt ? Number(lastEventAt) : null,
            };
        },
    },
    flights: {
        async create(data) {
            const redis = getRedis();
            const id = await nextId("flight");
            const createdAt = data.created_at || Date.now();
            const flight = { ...data, id, created_at: createdAt };
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
        async getById(id) {
            return getObject(key("flight", id));
        },
        async getByHash(hash) {
            const id = await getRedis().get(key("flight", "hash", hash));
            return id ? exports.repositories.flights.getById(Number(id)) : null;
        },
        async getByChannelAndStatus(channel, statuses) {
            const ids = await getIdsFromSortedSet(key("flights", "channel", channel));
            for (const id of ids) {
                const flight = await exports.repositories.flights.getById(Number(id));
                if (flight && statuses.includes(flight.status)) {
                    return flight;
                }
            }
            return null;
        },
        async getByStatus(status) {
            const ids = await getIdsFromSortedSet(key("flights", "status", status));
            return loadMany(ids, (id) => exports.repositories.flights.getById(Number(id)));
        },
        async getRecent(limit = 20) {
            const ids = await getIdsFromSortedSet(key("flights", "all"), limit);
            return loadMany(ids, (id) => exports.repositories.flights.getById(Number(id)));
        },
        async update(id, fields) {
            const redis = getRedis();
            const current = await exports.repositories.flights.getById(id);
            if (!current) {
                return null;
            }
            const updated = { ...current, ...fields };
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
        async delete(id) {
            const redis = getRedis();
            const current = await exports.repositories.flights.getById(id);
            if (!current) {
                return;
            }
            const participants = await exports.repositories.participants.getByFlight(id);
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
        async deleteAll() {
            const flights = await exports.repositories.flights.getRecent(1000);
            await Promise.all(flights.map((flight) => exports.repositories.flights.delete(flight.id)));
        },
    },
    participants: {
        async create(data) {
            const redis = getRedis();
            const id = await nextId("participant");
            const participant = { ...data, id };
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
        async getById(id) {
            return getObject(key("participant", id));
        },
        async getByHash(hash) {
            const id = await getRedis().get(key("participant", "hash", hash));
            return id ? exports.repositories.participants.getById(Number(id)) : null;
        },
        async getByHashWithFlight(hash) {
            const participant = await exports.repositories.participants.getByHash(hash);
            if (!participant) {
                return null;
            }
            const flight = await exports.repositories.flights.getById(participant.flight_id);
            if (!flight) {
                return null;
            }
            return {
                ...participant,
                ...flight,
                flight_status: flight.status,
            };
        },
        async getByFlightAndUser(flightId, userId) {
            const id = await getRedis().get(key("participant", "flightUser", flightId, userId));
            return id ? exports.repositories.participants.getById(Number(id)) : null;
        },
        async getByFlight(flightId) {
            const ids = await getIdsFromSortedSet(key("participants", "flight", flightId));
            return loadMany(ids, (id) => exports.repositories.participants.getById(Number(id)));
        },
        async getActiveByUser(userId) {
            const ids = await getIdsFromSortedSet(key("participants", "user", userId));
            for (const id of ids) {
                const participant = await exports.repositories.participants.getById(Number(id));
                if (!participant) {
                    continue;
                }
                const flight = await exports.repositories.flights.getById(participant.flight_id);
                if (flight && ["boarding", "in_flight"].includes(flight.status)) {
                    return { ...participant, ...flight };
                }
            }
            return null;
        },
        async update(id, fields) {
            const current = await exports.repositories.participants.getById(id);
            if (!current) {
                return null;
            }
            const updated = { ...current, ...fields };
            await setObject(key("participant", id), updated);
            return updated;
        },
        async getOccupiedSeats(flightId) {
            const participants = await exports.repositories.participants.getByFlight(flightId);
            return participants
                .filter((participant) => participant.seat)
                .map((participant) => ({
                user_name: participant.user_name,
                user_id: participant.user_id,
                seat: participant.seat,
                participant_hash: participant.participant_hash,
            }));
        },
        async deleteByFlight(flightId) {
            const participants = await exports.repositories.participants.getByFlight(flightId);
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
        async deleteAll() {
            const flights = await exports.repositories.flights.getRecent(1000);
            await Promise.all(flights.map((flight) => exports.repositories.participants.deleteByFlight(flight.id)));
        },
    },
    userMiles: {
        async get(userId) {
            return getObject(key("userMiles", userId));
        },
        async addMiles(userId, userName, miles) {
            const current = (await exports.repositories.userMiles.get(userId)) || {
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
        async getTopMiles(limit = 5) {
            const ids = await getIdsFromSortedSet(key("leaderboard", "miles"), limit);
            return loadMany(ids, (id) => exports.repositories.userMiles.get(id));
        },
    },
    userCountries: {
        async unlock(userId, countryCode, countryName, flightId) {
            const countryKey = key("userCountry", userId, countryCode);
            const record = {
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
            const currentCount = await exports.repositories.userCountries.countByUser(userId);
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
        async getByUser(userId) {
            const codes = await getIdsFromSortedSet(key("userCountries", "user", userId));
            return loadMany(codes, (code) => getObject(key("userCountry", userId, code)));
        },
        async countByUser(userId) {
            return Number((await getRedis().zcard(key("userCountries", "user", userId))) || 0);
        },
        async getTopCountries(limit = 5) {
            const ids = await getIdsFromSortedSet(key("leaderboard", "countries"), limit);
            const rows = await Promise.all(ids.map(async (userId) => {
                const miles = await exports.repositories.userMiles.get(userId);
                const countriesCount = await exports.repositories.userCountries.countByUser(userId);
                return {
                    user_id: userId,
                    user_name: miles?.user_name || userId,
                    total_miles: miles?.total_miles || 0,
                    total_flights: miles?.total_flights || 0,
                    countries_count: countriesCount,
                };
            }));
            return rows;
        },
        async getLeaderboard(limit = 20) {
            return exports.repositories.userCountries.getTopCountries(limit);
        },
    },
    channels: {
        async add(name, userId) {
            const record = { name, user_id: userId, banned: 0 };
            const exists = await getRedis().exists(key("channel", name));
            if (exists) {
                const error = new Error("Duplicate channel");
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                error.code = "ER_DUP_ENTRY";
                throw error;
            }
            const pipeline = getRedis().pipeline();
            pipeline.set(key("channel", name), record);
            pipeline.set(key("channelByUser", userId), name);
            pipeline.sadd(key("channels"), name);
            await pipeline.exec();
            return record;
        },
        async getAll() {
            const names = await getIdsFromSet(key("channels"));
            return loadMany(names, (name) => getObject(key("channel", name)));
        },
        async updateBanned(userId, banned) {
            const name = await getRedis().get(key("channelByUser", userId));
            if (!name) {
                return;
            }
            const record = await getObject(key("channel", name));
            if (!record) {
                return;
            }
            await setObject(key("channel", name), { ...record, banned: banned ? 1 : 0 });
        },
        async updateName(userId, newName) {
            const previousName = await getRedis().get(key("channelByUser", userId));
            if (!previousName) {
                return;
            }
            const record = await getObject(key("channel", previousName));
            if (!record) {
                return;
            }
            const updated = { ...record, name: newName };
            const pipeline = getRedis().pipeline();
            pipeline.del(key("channel", previousName));
            pipeline.srem(key("channels"), previousName);
            pipeline.set(key("channel", newName), updated);
            pipeline.set(key("channelByUser", userId), newName);
            pipeline.sadd(key("channels"), newName);
            await pipeline.exec();
        },
        async remove(name) {
            const record = await getObject(key("channel", name));
            const pipeline = getRedis().pipeline();
            pipeline.del(key("channel", name));
            pipeline.srem(key("channels"), name);
            if (record) {
                pipeline.del(key("channelByUser", record.user_id));
            }
            await pipeline.exec();
        },
        async removeByUserId(userId) {
            const name = await getRedis().get(key("channelByUser", userId));
            if (name) {
                await exports.repositories.channels.remove(name);
            }
        },
    },
    managedChannels: {
        async add(channelName, channelId) {
            const record = {
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
        async get(channelName) {
            return getObject(key("managedChannel", channelName));
        },
        async getAll() {
            const names = await getIdsFromSet(key("managedChannels"));
            const rows = await loadMany(names, (name) => exports.repositories.managedChannels.get(name));
            return rows.sort((left, right) => right.added_at.localeCompare(left.added_at));
        },
        async remove(channelName) {
            const pipeline = getRedis().pipeline();
            pipeline.del(key("managedChannel", channelName));
            pipeline.srem(key("managedChannels"), channelName);
            await pipeline.exec();
        },
    },
    aircraftConfigs: {
        async get(icaoCode) {
            return getObject(key("aircraftConfig", icaoCode));
        },
        async set(icaoCode, name, seatConfig, totalSeats, rows) {
            await setObject(key("aircraftConfig", icaoCode), {
                icao_code: icaoCode,
                name,
                seat_config: seatConfig,
                total_seats: totalSeats,
                rows_count: rows,
            });
        },
    },
    runtimeConfig: {
        async getBotCredentials() {
            return getObject(key("runtimeConfig", "botCredentials"));
        },
        async setBotCredentials(value) {
            await setObject(key("runtimeConfig", "botCredentials"), value);
        },
        async clearBotCredentials() {
            await getRedis().del(key("runtimeConfig", "botCredentials"));
        },
        async getRestartedAt() {
            const value = await getRedis().get(key("runtimeConfig", "botRestartedAt"));
            return value ? Number(value) : null;
        },
        async markRestarted(timestamp = Date.now()) {
            await getRedis().set(key("runtimeConfig", "botRestartedAt"), timestamp);
        },
    },
    botLogs: {
        async getRecent(limit = 100) {
            const rows = (await getRedis().lrange(key("botLogs"), 0, Math.max(0, limit - 1))) || [];
            return [...rows].reverse();
        },
    },
    ncMessages: {
        async setSent(channelId) {
            await getRedis().set(key("cache", "nc", channelId), "1", { ex: 86400 });
        },
    },
    cache: {
        async get(cacheKey) {
            const value = await getRedis().get(key("cache", cacheKey));
            return value || null;
        },
        async set(cacheKey, value, ttlSeconds) {
            await getRedis().set(key("cache", cacheKey), value, { ex: ttlSeconds });
        },
        async del(cacheKey) {
            await getRedis().del(key("cache", cacheKey));
        },
    },
    cooldowns: {
        async isOnCooldown(cooldownKey) {
            const exists = await getRedis().exists(key("cooldown", cooldownKey));
            return exists === 1;
        },
        async setCooldown(cooldownKey, seconds) {
            await getRedis().set(key("cooldown", cooldownKey), "1", { ex: seconds });
        },
        async clearCooldown(cooldownKey) {
            await getRedis().del(key("cooldown", cooldownKey));
        },
    },
    channelSettings: {
        async get(channelId, settingKey) {
            const value = await getRedis().get(key("channelSetting", channelId, settingKey));
            return value || null;
        },
        async set(channelId, settingKey, value) {
            await getRedis().set(key("channelSetting", channelId, settingKey), value);
        },
        async del(channelId, settingKey) {
            await getRedis().del(key("channelSetting", channelId, settingKey));
        },
        async exists(channelId, settingKey) {
            return (await getRedis().exists(key("channelSetting", channelId, settingKey))) === 1;
        },
    },
    userPermissions: {
        async get(userId) {
            const value = await getRedis().get(key("userPermission", userId));
            return value === null || value === undefined ? null : Number(value);
        },
        async set(userId, permission) {
            await getRedis().set(key("userPermission", userId), permission);
        },
    },
    blacklist: {
        async add(userId) {
            await getRedis().sadd(key("blacklist"), userId);
        },
        async remove(userId) {
            await getRedis().srem(key("blacklist"), userId);
        },
        async has(userId) {
            return (await getRedis().sismember(key("blacklist"), userId)) === 1;
        },
        async getAll() {
            return getIdsFromSet(key("blacklist"));
        },
    },
    processedEvents: {
        async markProcessed(eventId, ttlSeconds = 600) {
            const result = await getRedis().set(key("processedEvent", eventId), "1", { nx: true, ex: ttlSeconds });
            return result === "OK";
        },
    },
    eventSubSubscriptions: {
        async set(channelName, value) {
            const pipeline = getRedis().pipeline();
            pipeline.set(key("eventSubSubscription", channelName), value);
            pipeline.set(key("eventSubSubscriptionById", value.id), channelName);
            await pipeline.exec();
        },
        async get(channelName) {
            return getObject(key("eventSubSubscription", channelName));
        },
        async removeByChannel(channelName) {
            const current = await exports.repositories.eventSubSubscriptions.get(channelName);
            const pipeline = getRedis().pipeline();
            pipeline.del(key("eventSubSubscription", channelName));
            if (current) {
                pipeline.del(key("eventSubSubscriptionById", current.id));
            }
            await pipeline.exec();
        },
    },
    simlink: {
        async updateLastData(data) {
            const pipeline = getRedis().pipeline();
            pipeline.set(key("simlink", "lastData"), data);
            pipeline.set(key("simlink", "lastSeenAt"), Date.now());
            await pipeline.exec();
        },
        async getStatus() {
            const [lastData, lastSeenAt, flightId] = await Promise.all([
                getObject(key("simlink", "lastData")),
                getRedis().get(key("simlink", "lastSeenAt")),
                getRedis().get(key("simlink", "flightId")),
            ]);
            const connected = !!lastSeenAt && Date.now() - Number(lastSeenAt) < 15000;
            return {
                connected,
                lastData,
                flightId: flightId ? Number(flightId) : null,
            };
        },
        async setFlightId(flightId) {
            if (flightId === null) {
                await getRedis().del(key("simlink", "flightId"));
            }
            else {
                await getRedis().set(key("simlink", "flightId"), flightId);
            }
        },
    },
};
