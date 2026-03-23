import tmi from "tmi.js";
import { handleChatMessage } from "./core";
import { milesandmorebotLogger } from "./logger";
import { getBotRuntimeSettings, assertValidBotCredentials } from "./twitch";
import type { TwitchChatMessage } from "../lib/types";

// Maintain a singleton client for development reloads and long-running processes
const globalForIrc = globalThis as unknown as {
  ircClient?: tmi.Client;
  ircClientPromise?: Promise<tmi.Client | null>;
};

export async function getIrcClient(): Promise<tmi.Client | null> {
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
      settings = await getBotRuntimeSettings();
    } catch {
      return null;
    }

    if (!settings.credentialsValid || !settings.botUsername || !settings.tokenPreview) {
      return null;
    }

    const credentials = await assertValidBotCredentials();

    const client = new tmi.Client({
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
      if (self) return;

      const channelName = channel.replace(/^#/, "");

      const chatMessage: TwitchChatMessage = {
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

      handleChatMessage(chatMessage).catch((e) => {
        milesandmorebotLogger.error(`[IRC] Error handling msg in #${channelName}: ${e}`);
      });
    });

    client.on("connected", (address, port) => {
      milesandmorebotLogger.info(`[IRC] Connected to ${address}:${port}`);
    });

    client.on("reconnect", () => {
      milesandmorebotLogger.warn("[IRC] Reconnecting to Twitch IRC");
    });

    client.on("disconnected", (reason) => {
      milesandmorebotLogger.warn(`[IRC] Disconnected: ${reason}`);
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      milesandmorebotLogger.error(`[IRC] Connection failed: ${message}`);
      return null;
    } finally {
      globalForIrc.ircClientPromise = undefined;
    }
  })();

  return globalForIrc.ircClientPromise;
}

export async function joinIrcChannel(channelName: string): Promise<boolean> {
  const client = await getIrcClient();
  if (!client) return false;

  const currentChannels = client.getChannels();
  if (currentChannels.includes(`#${channelName}`)) {
    return true; // Already joined
  }

  try {
    await client.join(channelName);
    await milesandmorebotLogger.info(`[IRC] Joined #${channelName}`);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await milesandmorebotLogger.error(`[IRC] Failed to join #${channelName}: ${message}`);
    return false;
  }
}

export async function partIrcChannel(channelName: string): Promise<boolean> {
  const client = await getIrcClient();
  if (!client) return true; // Nothing to part from

  const currentChannels = client.getChannels();
  if (!currentChannels.includes(`#${channelName}`)) {
    return true; // Not joined
  }

  try {
    await client.part(channelName);
    await milesandmorebotLogger.info(`[IRC] Left #${channelName}`);
    return true;
  } catch {
    return false;
  }
}

export async function resetIrcClient(reason: string): Promise<void> {
  globalForIrc.ircClientPromise = undefined;
  const client = globalForIrc.ircClient;
  if (!client) {
    return;
  }

  globalForIrc.ircClient = undefined;
  await milesandmorebotLogger.info(`[IRC] Resetting client (${reason})`);

  try {
    const state = client.readyState();
    if (state === "OPEN" || state === "CONNECTING") {
      await client.disconnect();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await milesandmorebotLogger.warn(`[IRC] Client reset disconnect failed: ${message}`);
  } finally {
    client.removeAllListeners();
  }
}
