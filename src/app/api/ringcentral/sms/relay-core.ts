import { timingSafeEqual } from "node:crypto";

// Decision half of the RingCentral SMS relay. No framework imports, so
// relay-core.test.mjs runs with plain `node --experimental-strip-types`
// (same split as src/lib/sync-auth-core.ts). The HTTP half is route.ts.
//
// ---------------------------------------------------------------------------
// What this relay is
// ---------------------------------------------------------------------------
// RingCentral → POST /api/ringcentral/sms → Olivia's Claude routine (/fire).
// It stores nothing, writes nothing to Supabase, and never logs a phone
// number or a message body. Olivia reads and sends texts herself through her
// own RingCentral connection; this only wakes her up.
//
// Three env vars, one per scope, none in git:
//   RINGCENTRAL_VERIFICATION_TOKEN  the verificationToken the subscription was
//                                   created with; RingCentral echoes it back
//                                   in a Verification-Token header
//   OLIVIA_ROUTINE_FIRE_URL         https://api.anthropic.com/v1/claude_code/
//                                   routines/trig_…/fire
//   OLIVIA_ROUTINE_FIRE_TOKEN       the routine's sk-ant-oat01-… bearer token
//
// The RingCentral JWT is deliberately NOT here. Only the subscription
// watchdog needs it, and it can read every message on ext 105.

export const ENV_VERIFICATION = "RINGCENTRAL_VERIFICATION_TOKEN";
export const ENV_FIRE_URL = "OLIVIA_ROUTINE_FIRE_URL";
export const ENV_FIRE_TOKEN = "OLIVIA_ROUTINE_FIRE_TOKEN";

type Env = Record<string, string | undefined>;

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; detail: string };

/** Checks RingCentral's Verification-Token header against our env var. */
export function verifyNotification(
  header: string | null | undefined,
  env: Env = process.env,
): VerifyResult {
  const expected = env[ENV_VERIFICATION];
  if (!expected) {
    // Misconfiguration, not a bad caller — name the var, never a value.
    return { ok: false, status: 500, detail: `${ENV_VERIFICATION} not set` };
  }
  if (!header) return { ok: false, status: 401, detail: "no Verification-Token" };
  if (!sameSecret(header, expected))
    return { ok: false, status: 401, detail: "Verification-Token mismatch" };
  return { ok: true };
}

// ---- the event ----------------------------------------------------------

type Party = { phoneNumber?: string; extensionNumber?: string; name?: string };

export type RcEvent = {
  uuid?: string;
  event?: string;
  timestamp?: string;
  subscriptionId?: string;
  body?: {
    id?: string | number;
    type?: string;
    direction?: string;
    from?: Party;
    to?: Party[];
    subject?: string;
    creationTime?: string;
    attachments?: Array<{ contentType?: string }>;
  };
};

export type Decision =
  | { forward: true; messageId: string }
  | { forward: false; reason: string };

/**
 * Only inbound SMS/MMS go to Olivia. RingCentral reports MMS as type "SMS"
 * with attachments. The direction check matters: Olivia texts out of this
 * same extension, and forwarding her own outbound message would wake her
 * for something she just sent.
 */
export function shouldForward(evt: RcEvent): Decision {
  if (!evt || typeof evt !== "object") return { forward: false, reason: "not_an_object" };
  if (!evt.event || !evt.event.includes("/message-store"))
    return { forward: false, reason: "not_a_message_event" };
  const b = evt.body;
  if (!b) return { forward: false, reason: "no_body" };
  if (b.type && b.type !== "SMS") return { forward: false, reason: `type_${b.type}` };
  if (b.direction && b.direction !== "Inbound")
    return { forward: false, reason: `direction_${b.direction}` };
  return { forward: true, messageId: String(b.id ?? evt.uuid ?? "unknown") };
}

/**
 * The routine /fire endpoint takes ONE optional field, `text`, and ignores
 * every unknown field. Posting RingCentral's JSON "unchanged" (as the brief
 * asked) would start Olivia with no message at all and return 200 — a silent
 * failure. So the event rides inside `text`: a readable header for Olivia,
 * then the untouched RingCentral JSON for anything she wants to look up.
 */
export function fireBody(evt: RcEvent): { text: string } {
  const b = evt.body ?? {};
  const att = (b.attachments ?? []).filter(
    (a) => a.contentType && !a.contentType.startsWith("text/"),
  ).length;
  const lines = [
    "Incoming text to Olivia's RingCentral line (954) 837-8475, ext 105.",
    `From: ${b.from?.phoneNumber ?? "unknown"}${b.from?.name ? ` (${b.from.name})` : ""}`,
    `Received: ${b.creationTime ?? evt.timestamp ?? "unknown"}`,
    `Message: ${b.subject ?? "(no text)"}`,
  ];
  if (att > 0) lines.push(`Attachments: ${att} (MMS — fetch through RingCentral)`);
  lines.push(`RingCentral message id: ${b.id ?? "unknown"}`);
  lines.push("", "Raw RingCentral event (JSON, unchanged):", JSON.stringify(evt));
  return { text: lines.join("\n") };
}

/** Headers /fire requires; any one missing is a 400. */
export function fireHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "experimental-cc-routine-2026-04-01",
    "Content-Type": "application/json",
  };
}
