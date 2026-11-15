import { after } from "next/server";
import {
  ENV_FIRE_TOKEN,
  ENV_FIRE_URL,
  fireBody,
  fireHeaders,
  shouldForward,
  verifyNotification,
  type RcEvent,
} from "./relay-core";

// POST /api/ringcentral/sms
//
// RingCentral webhook for Olivia's line, (954) 837-8475, ext 105. Forwards
// each inbound SMS/MMS to Olivia's Claude routine so she wakes up and posts in
// Jairo's chat. Stores nothing. Logic and the env vars are in relay-core.ts.
//
// Auth is RingCentral's, not the house bearer (requireSyncAuth): RingCentral
// cannot send an Authorization header. Same idea, different header —
//   1. Validation-Token on subscription create/renew → echo it, 200, no body.
//   2. Verification-Token on every notification → constant-time compare with
//      RINGCENTRAL_VERIFICATION_TOKEN.
//
// Answer fast. A RingCentral endpoint that fails for ~10 minutes gets its
// subscription blacklisted and every text after that is lost until it is
// renewed. So the 200 goes back first and the forward runs in after().
//
// Logs carry the RingCentral message id and outcome only — never a phone
// number, never message text.

export const runtime = "nodejs";
export const maxDuration = 30;

const empty = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, {
    status,
    // RingCentral rejects a validation reply without a JSON content type
    // (SUB-525), even though the body is empty.
    headers: { "Content-Type": "application/json", ...headers },
  });

export async function POST(request: Request) {
  // 1. Subscription handshake ----------------------------------------------
  const validation = request.headers.get("validation-token");
  if (validation) {
    console.log("ringcentral-sms: validation handshake answered");
    return empty(200, { "Validation-Token": validation });
  }

  // 2. Verify ---------------------------------------------------------------
  const v = verifyNotification(request.headers.get("verification-token"));
  if (!v.ok) {
    (v.status === 500 ? console.error : console.warn)(`ringcentral-sms: ${v.detail}`);
    return empty(v.status);
  }

  // 3. Decide ---------------------------------------------------------------
  let evt: RcEvent;
  try {
    evt = (await request.json()) as RcEvent;
  } catch {
    console.warn("ringcentral-sms: bad_json");
    return empty(200); // never give RingCentral a reason to blacklist us
  }
  const d = shouldForward(evt);
  if (!d.forward) {
    console.log(`ringcentral-sms: skipped reason=${d.reason}`);
    return empty(200);
  }

  // 4. Forward, after the response -----------------------------------------
  after(() => forward(evt, d.messageId));
  return empty(200);
}

async function forward(evt: RcEvent, messageId: string): Promise<void> {
  const url = process.env[ENV_FIRE_URL];
  const token = process.env[ENV_FIRE_TOKEN];
  if (!url || !token) {
    console.error(
      `ringcentral-sms: msg=${messageId} NOT forwarded — ${ENV_FIRE_URL} / ${ENV_FIRE_TOKEN} not set`,
    );
    return;
  }
  const init = {
    method: "POST",
    headers: fireHeaders(token),
    body: JSON.stringify(fireBody(evt)),
  };
  // One retry, on a network error or a 5xx only. A 4xx (bad token, missing
  // beta header) will not fix itself and retrying would just double the log.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        console.log(`ringcentral-sms: msg=${messageId} forwarded status=${res.status}`);
        return;
      }
      console.error(
        `ringcentral-sms: msg=${messageId} fire failed status=${res.status} attempt=${attempt}`,
      );
      if (res.status < 500) return;
    } catch (e) {
      console.error(
        `ringcentral-sms: msg=${messageId} fire error attempt=${attempt}: ${(e as Error).name}`,
      );
    }
  }
}
