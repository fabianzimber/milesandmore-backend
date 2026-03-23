"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getQStashReceiver = getQStashReceiver;
exports.verifyQStashRequest = verifyQStashRequest;
exports.publishFlightJob = publishFlightJob;
const qstash_1 = require("@upstash/qstash");
const env_1 = require("./env");
let qstashClient = null;
let qstashReceiver = null;
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
async function verifyQStashRequest(request) {
    const receiver = getQStashReceiver();
    if (!receiver) {
        return request.headers.get("x-internal-job-secret") === env_1.milesandmorebotEnv.internalJobSecret;
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
        return request.headers.get("x-internal-job-secret") === env_1.milesandmorebotEnv.internalJobSecret;
    }
    catch {
        return false;
    }
}
async function publishFlightJob(action, body, delaySeconds) {
    if (!process.env.QSTASH_TOKEN) {
        return { messageId: null };
    }
    return getQStashClient().publishJSON({
        url: `${env_1.milesandmorebotEnv.appUrl}/api/internal/jobs/${action}`,
        body,
        delay: Math.max(0, Math.round(delaySeconds)),
        retries: 3,
        headers: {
            "x-internal-job-secret": env_1.milesandmorebotEnv.internalJobSecret,
        },
        deduplicationId: `${action}:${body.flightId}:${body.channelName}:${body.lifecycleVersion || 0}`,
        label: `milesandmorebot-${action}`,
    });
}
