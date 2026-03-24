"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isQStashConfigured = isQStashConfigured;
exports.verifyQStashRequest = verifyQStashRequest;
exports.publishFlightJob = publishFlightJob;
const node_crypto_1 = __importDefault(require("node:crypto"));
const qstash_1 = require("@upstash/qstash");
const env_1 = require("./env");
let qstashClient = null;
let qstashReceiver = null;
function getInternalJobHeaderSecret() {
    if (!env_1.milesandmorebotEnv.internalJobSecret) {
        return "";
    }
    return node_crypto_1.default
        .createHash("sha256")
        .update(`${env_1.milesandmorebotEnv.internalJobSecret}:jobs`)
        .digest("hex");
}
/** Returns true when all QStash env vars are present and jobs will actually be published. */
function isQStashConfigured() {
    return !!process.env.QSTASH_TOKEN;
}
function getQStashClient() {
    if (!qstashClient) {
        qstashClient = new qstash_1.Client({ token: process.env.QSTASH_TOKEN });
    }
    return qstashClient;
}
function getQStashReceiver() {
    if (!env_1.milesandmorebotEnv.qstashCurrentSigningKey || !env_1.milesandmorebotEnv.qstashNextSigningKey) {
        return null;
    }
    if (!qstashReceiver) {
        qstashReceiver = new qstash_1.Receiver({
            currentSigningKey: env_1.milesandmorebotEnv.qstashCurrentSigningKey,
            nextSigningKey: env_1.milesandmorebotEnv.qstashNextSigningKey,
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
async function verifyQStashRequest(request) {
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
    }
    catch {
        return false;
    }
}
async function publishFlightJob(action, body, delaySeconds) {
    if (!isQStashConfigured()) {
        return { messageId: null };
    }
    return getQStashClient().publishJSON({
        url: `${env_1.milesandmorebotEnv.appUrl}/api/internal/jobs/${action}`,
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
