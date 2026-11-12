import { NextResponse } from "next/server";
import { shipGate } from "@/app/shipping/_lib/gate";
import { LIVE, rawFedex, accountLast4 } from "@/app/shipping/_lib/fedex";

// GET /api/shipping/diag/ground -- admin only, SANDBOX only.
// Why does FedEx Ground not come back? Tries Ground several ways and returns
// what FedEx said each time (services, alerts, errors). Creates nothing.
// Remove once Ground is sorted (see claude/shipping.md).

export const runtime = "nodejs";
export const maxDuration = 60;

const PC = { streetLines: ["15851 SW 41st St", "Ste 300"], city: "Davie", stateOrProvinceCode: "FL", postalCode: "33331", countryCode: "US" };
const MEMPHIS = { streetLines: ["3610 Hacks Cross Rd"], city: "Memphis", stateOrProvinceCode: "TN", postalCode: "38125", countryCode: "US" };
const BIZ = { streetLines: ["1 Main St"], city: "Orlando", stateOrProvinceCode: "FL", postalCode: "32801", countryCode: "US" };
const FAR = { streetLines: ["2000 Main St"], city: "Dallas", stateOrProvinceCode: "TX", postalCode: "75201", countryCode: "US" };
const PKG = [{ sequenceNumber: 1, weight: { units: "LB", value: 2 }, dimensions: { length: 10, width: 8, height: 6, units: "IN" } }];

function rateBody(account: string, o: { shipper?: object; recipient?: object; residential?: boolean; serviceType?: string; rateRequestType?: string[]; carrierCodes?: string[]; pickupType?: string }) {
  return {
    accountNumber: { value: account },
    ...(o.carrierCodes ? { carrierCodes: o.carrierCodes } : {}),
    requestedShipment: {
      shipper: { address: o.shipper ?? PC },
      recipient: { address: { ...(o.recipient ?? BIZ), residential: o.residential === true } },
      pickupType: o.pickupType ?? "DROPOFF_AT_FEDEX_LOCATION",
      ...(o.serviceType ? { serviceType: o.serviceType } : {}),
      rateRequestType: o.rateRequestType ?? ["ACCOUNT"],
      requestedPackageLineItems: PKG,
    },
  };
}

export async function GET() {
  const g = await shipGate();
  if (!g.ok || !g.admin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });
  if (LIVE) return NextResponse.json({ ok: false, error: "sandbox_only" }, { status: 400 });
  const account = process.env.FEDEX_ACCOUNT_NUMBER ?? "";

  const variants: Array<[string, object]> = [
    ["A all services (as the app asks)", {}],
    ["B serviceType FEDEX_GROUND", { serviceType: "FEDEX_GROUND" }],
    ["C FEDEX_GROUND + LIST rates", { serviceType: "FEDEX_GROUND", rateRequestType: ["LIST", "ACCOUNT"] }],
    ["D carrierCodes FDXG", { carrierCodes: ["FDXG"] }],
    ["E FEDEX_GROUND, pickup USE_SCHEDULED_PICKUP", { serviceType: "FEDEX_GROUND", pickupType: "USE_SCHEDULED_PICKUP" }],
    ["F FEDEX_GROUND to Dallas TX", { serviceType: "FEDEX_GROUND", recipient: FAR }],
    ["G GROUND_HOME_DELIVERY residential", { serviceType: "GROUND_HOME_DELIVERY", residential: true }],
    ["H FEDEX_GROUND shipper Memphis TN", { serviceType: "FEDEX_GROUND", shipper: MEMPHIS, recipient: FAR }],
    ["I all services, no account (rates without account)", { _noAccount: true }],
  ];

  const results = [];
  for (const [name, o] of variants) {
    const body: any = rateBody(account, o as any);
    if ((o as any)._noAccount) delete body.accountNumber;
    const r = await rawFedex("POST", "/rate/v1/rates/quotes", body);
    if (!r.ok) {
      results.push({ name, ok: false, error: r.error, detail: r.detail ?? null });
      continue;
    }
    const out = r.json?.output ?? {};
    const rows = Array.isArray(out.rateReplyDetails) ? out.rateReplyDetails : [];
    results.push({
      name,
      ok: true,
      services: rows.map((x: any) => {
        const d = Array.isArray(x.ratedShipmentDetails) ? x.ratedShipmentDetails : [];
        return `${x.serviceType} ${d.map((y: any) => `${y.rateType}:${y.totalNetCharge}${y.currency}`).join(",")}`;
      }),
      alerts: (Array.isArray(out.alerts) ? out.alerts : []).map((a: any) => `${a.code ?? ""} ${a.message ?? ""}`.trim()),
    });
  }
  return NextResponse.json({ ok: true, environment: "sandbox", accountLast4: accountLast4(), results }, { headers: { "cache-control": "no-store" } });
}
