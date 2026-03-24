import crypto from "node:crypto";
import { Client, Receiver } from "@upstash/qstash";
import type { ScheduledFlightJob } from "../lib/types";
import { milesandmorebotEnv } from "./env";

let qstashClient: Client | null = null;
let qstashReceiver: Receiver | null = null;

function getInternalJobHeaderSecret(): string {
  if (!milesandmorebotEnv.internalJobSecret) {
    return "";
  }
  return crypto
    .createHash("sha256")
    .update(`${milesandmorebotEnv.internalJobSecret}:jobs`)
    .digest("hex");
}

/** Returns true when all QStash env vars are present and jobs will actually be published. */
export function isQStashConfigured(): boolean {
  return !!process.env.QSTASH_TOKEN;
}

function getQStashClient(): Client {
  if (!qstashClient) {
    qstashClient = new Client({ token: process.env.QSTASH_TOKEN! });
  }
  return qstashClient;
}

function getQStashReceiver(): Receiver | null {
  if (!milesandmorebotEnv.qstashCurrentSigningKey || !milesandmorebotEnv.qstashNextSigningKey) {
    return null;
  }
  if (!qstashReceiver) {
    qstashReceiver = new Receiver({
      currentSigningKey: milesandmorebotEnv.qstashCurrentSigningKey,
      nextSigningKey: milesandmorebotEnv.qstashNextSigningKey,
    });
  }
  return qstashReceiver;
}

/**
 * Verify an incoming job request.
 * - When QStash signing keys are configured: verify the Upstash signature.
 * - Always accepts requests that carry the correct x-internal-job-secret
 *   (used by the local fallback scheduler calling the same endpoints).
 */
export async function verifyQStashRequest(request: Request): Promise<boolean> {
  // Always allow internal-secret-only auth (local scheduler, manual calls)
  const derivedSecret = getInternalJobHeaderSecret();
  if (derivedSecret && request.headers.get("x-internal-job-secret") === derivedSecret) {
    return true;
  }

  // If QStash signing keys are configured, verify the Upstash signature
  const receiver = getQStashReceiver();
  if (!receiver) {
    return false;
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return false;
  }

  try {
    await receiver.verify({
      signature,
      body: await request.clone().text(),
      url: request.url,
    });
    return true;
  } catch {
    return false;
  }
}

export async function publishFlightJob(
  action: ScheduledFlightJob["action"],
  body: ScheduledFlightJob,
  delaySeconds: number,
): Promise<{ messageId: string | null }> {
  if (!isQStashConfigured()) {
    return { messageId: null };
  }

  return getQStashClient().publishJSON({
    url: `${milesandmorebotEnv.appUrl}/api/internal/jobs/${action}`,
    body,
    delay: Math.max(0, Math.round(delaySeconds)),
    retries: 3,
    headers: {
      "x-internal-job-secret": getInternalJobHeaderSecret(),
    },
    deduplicationId: `${action}-${body.flightId}-${body.channelName}-${body.lifecycleVersion || 0}-${Date.now()}`,
    label: `milesandmorebot-${action}`,
  });
}
