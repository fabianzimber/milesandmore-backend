"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIrcClient = getIrcClient;
exports.joinIrcChannel = joinIrcChannel;
exports.partIrcChannel = partIrcChannel;
exports.resetIrcClient = resetIrcClient;
const tmi_js_1 = __importDefault(require("tmi.js"));
const core_1 = require("./core");
const logger_1 = require("./logger");
const twitch_1 = require("./twitch");
// Maintain a singleton client for development reloads and long-running processes
const globalForIrc = globalThis;
async function getIrcClient() {
    if (globalForIrc.ircClientPromise) {
        return globalForIrc.ircClientPromise;
    }
    if (globalForIrc.ircClient) {
        const state = globalForIrc.ircClient.readyState();
        if (state === "OPEN" || state === "CONNECTING") {
            return globalForIrc.ircClient;
        }
        globalForIrc.ircClient.removeAllListeners();
        globalForIrc.ircClient = undefined;
    }
    globalForIrc.ircClientPromise = (async () => {
        let settings;
        try {
            settings = await (0, twitch_1.getBotRuntimeSettings)();
        }
        catch {
            return null;
        }
        if (!settings.credentialsValid || !settings.botUsername || !settings.tokenPreview) {
            return null;
        }
        const credentials = await (0, twitch_1.assertValidBotCredentials)();
        const client = new tmi_js_1.default.Client({
            options: { debug: false },
            connection: {
                reconnect: true,
                secure: true,
            },
            identity: {
                username: settings.botUsername,
                password: `oauth:${credentials.accessToken}`,
            },
            channels: [],
        });
        client.on("message", (channel, tags, message, self) => {
            if (self)
                return;
            const channelName = channel.replace(/^#/, "");
            const chatMessage = {
                messageID: tags["id"] || "",
                channelName: channelName,
                channelID: tags["room-id"] || "",
                senderUsername: tags["username"] || "",
                senderUserID: tags["user-id"] || "",
                displayName: tags["display-name"] || tags["username"] || "",
                messageText: message,
                badges: [],
            };
            if (tags.badges) {
                for (const [badgeName, badgeVersion] of Object.entries(tags.badges)) {
                    chatMessage.badges.push({ name: badgeName, version: badgeVersion || "" });
                }
            }
            (0, core_1.handleChatMessage)(chatMessage).catch((e) => {
                logger_1.milesandmorebotLogger.error(`[IRC] Error handling msg in #${channelName}: ${e}`);
            });
        });
        client.on("connected", (address, port) => {
            logger_1.milesandmorebotLogger.info(`[IRC] Connected to ${address}:${port}`);
        });
        client.on("reconnect", () => {
            logger_1.milesandmorebotLogger.warn("[IRC] Reconnecting to Twitch IRC");
        });
        client.on("disconnected", (reason) => {
            logger_1.milesandmorebotLogger.warn(`[IRC] Disconnected: ${reason}`);
            if (globalForIrc.ircClient === client) {
                globalForIrc.ircClient = undefined;
            }
            if (globalForIrc.ircClientPromise) {
                globalForIrc.ircClientPromise = undefined;
            }
        });
        try {
            await client.connect();
            globalForIrc.ircClient = client;
            return client;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger_1.milesandmorebotLogger.error(`[IRC] Connection failed: ${message}`);
            return null;
        }
        finally {
            globalForIrc.ircClientPromise = undefined;
        }
    })();
    return globalForIrc.ircClientPromise;
}
async function joinIrcChannel(channelName) {
    const client = await getIrcClient();
    if (!client)
        return false;
    const currentChannels = client.getChannels();
    if (currentChannels.includes(`#${channelName}`)) {
        return true; // Already joined
    }
    try {
        await client.join(channelName);
        await logger_1.milesandmorebotLogger.info(`[IRC] Joined #${channelName} via IRC fallback`);
        return true;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await logger_1.milesandmorebotLogger.error(`[IRC] Failed to join #${channelName}: ${message}`);
        return false;
    }
}
async function partIrcChannel(channelName) {
    const client = await getIrcClient();
    if (!client)
        return true; // Nothing to part from
    const currentChannels = client.getChannels();
    if (!currentChannels.includes(`#${channelName}`)) {
        return true; // Not joined
    }
    try {
        await client.part(channelName);
        await logger_1.milesandmorebotLogger.info(`[IRC] Left #${channelName} (IRC fallback disabled)`);
        return true;
    }
    catch {
        return false;
    }
}
async function resetIrcClient(reason) {
    globalForIrc.ircClientPromise = undefined;
    const client = globalForIrc.ircClient;
    if (!client) {
        return;
    }
    globalForIrc.ircClient = undefined;
    await logger_1.milesandmorebotLogger.info(`[IRC] Resetting client (${reason})`);
    try {
        const state = client.readyState();
        if (state === "OPEN" || state === "CONNECTING") {
            await client.disconnect();
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await logger_1.milesandmorebotLogger.warn(`[IRC] Client reset disconnect failed: ${message}`);
    }
    finally {
        client.removeAllListeners();
    }
}
