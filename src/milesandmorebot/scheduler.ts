import { Client, Receiver } from "@upstash/qstash";
import type { ScheduledFlightJob } from "../lib/types";
import { milesandmorebotEnv } from "./env";

let qstashClient: Client | null = null;
let qstashReceiver: Receiver | null = null;

function getQStashClient(): Client {
  if (!qstashClient) {
    qstashClient = new Client({ token: process.env.QSTASH_TOKEN! });
  }
  return qstashClient;
}

export function getQStashReceiver(): Receiver | null {
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

export async function verifyQStashRequest(request: Request): Promise<boolean> {
  const receiver = getQStashReceiver();
  if (!receiver) {
    return request.headers.get("x-internal-job-secret") === milesandmorebotEnv.internalJobSecret;
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
    return request.headers.get("x-internal-job-secret") === milesandmorebotEnv.internalJobSecret;
  } catch {
    return false;
  }
}

export async function publishFlightJob(action: ScheduledFlightJob["action"], body: ScheduledFlightJob, delaySeconds: number) {
  if (!process.env.QSTASH_TOKEN) {
    return { messageId: null };
  }

  return getQStashClient().publishJSON({
    url: `${milesandmorebotEnv.appUrl}/api/internal/jobs/${action}`,
    body,
    delay: Math.max(0, Math.round(delaySeconds)),
    retries: 3,
    headers: {
      "x-internal-job-secret": milesandmorebotEnv.internalJobSecret,
    },
    deduplicationId: `${action}:${body.flightId}:${body.channelName}:${body.lifecycleVersion || 0}`,
    label: `milesandmorebot-${action}`,
  });
}
