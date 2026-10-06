import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/sync/state
//
// The Fishbowl agent calls this once at the end of a run to say WHEN THE DATA
// WAS TRUE, which is not the same thing as when the run happened.
//
// On 2026-10-06 a complete 12:24 UTC run wrote 118 raw materials parsed out of
// the 04:31 nightly dump. Every screen read `max(synced_at)` and reported
// "synced 8:24am", so a part added to Fishbowl at 10:00 was missing with
// nothing anywhere explaining why, and re-running changed nothing because the
// agent re-read the same file. `synced_at` answers "did the job run", and
// nobody was asking that.
//
// So the agent now sends the dump's own mtime as `source_as_of`, and whether
// that dump was taken live or was last night's. One row per entity in
// public.sync_state; the apps render the age of the DATA from it.
//
// Bearer-auth with FISHBOWL_SYNC_SECRET, same as its sibling /api/sync/*
// Fishbowl routes. Writes with the service-role key: public.sync_state grants
// SELECT to authenticated and nothing else, so this is the only writer.
//
// Expected body:
//   {
//     source_as_of: string,            // ISO; the dump's mtime
//     dump_source?: "live" | "backup",
//     entities: { [entity: string]: number }   // rows sent, per entity
//   }

export const runtime = "nodejs";

type StateBody = {
  source_as_of?: unknown;
  dump_source?: unknown;
  entities?: unknown;
};

// Entity names the agent is allowed to report. An allowlist rather than a free
// string: this table is read by freshness indicators in four apps, and a typo
// ("raw_material") would otherwise create a second row that silently never
// updates and ages forever.
const KNOWN_ENTITIES = new Set([
  "customers",
  "products",
  "raw_materials",
  "packaging_components",
  "product_costs",
  "sales_orders",
  "purchase_orders",
  "vendors",
  "labor_rates",
]);

export async function POST(request: Request) {
  const expected = process.env.FISHBOWL_SYNC_SECRET;
  if (!expected) {
    console.error("FISHBOWL_SYNC_SECRET not configured");
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );
  }
  const authz = request.headers.get("authorization") || "";
  const provided = authz.startsWith("Bearer ")
    ? authz.slice("Bearer ".length).trim()
    : "";
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: StateBody;
  try {
    body = (await request.json()) as StateBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const sourceAsOf =
    typeof body.source_as_of === "string" && !Number.isNaN(Date.parse(body.source_as_of))
      ? new Date(body.source_as_of).toISOString()
      : null;
  if (!sourceAsOf) {
    return NextResponse.json(
      { ok: false, error: "missing_source_as_of" },
      { status: 400 },
    );
  }

  const dumpSource =
    body.dump_source === "live" || body.dump_source === "backup"
      ? body.dump_source
      : null;

  if (!body.entities || typeof body.entities !== "object" || Array.isArray(body.entities)) {
    return NextResponse.json({ ok: false, error: "missing_entities" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const rows = Object.entries(body.entities as Record<string, unknown>)
    .filter(([entity, count]) => KNOWN_ENTITIES.has(entity) && typeof count === "number")
    .map(([entity, count]) => ({
      entity,
      source_as_of: sourceAsOf,
      synced_at: now,
      row_count: count as number,
      dump_source: dumpSource,
    }));

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: "no_known_entities" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Supabase env vars missing");
    return NextResponse.json(
      { ok: false, error: "server_misconfigured" },
      { status: 500 },
    );
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { error } = await supabase
    .from("sync_state")
    .upsert(rows, { onConflict: "entity" });
  if (error) {
    console.error("sync_state upsert failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Same call, the job's own liveness row. public.sync_heartbeats already
  // answers "is this job alive" for Plaud, Monday and the daily cron, and the
  // Fishbowl agent was the one source allowed by the CHECK constraint that
  // never wrote one. It cannot post there itself -- that route authenticates
  // on a different scope and the agent holds only FISHBOWL_SYNC_SECRET -- so
  // it is written here rather than widening who may use which secret.
  //
  // Best-effort: the freshness data is already saved and a missing heartbeat
  // must not turn a good sync into a 500.
  const { error: hbError } = await supabase.from("sync_heartbeats").upsert(
    {
      source: "fishbowl",
      ran_at: now,
      status: dumpSource === "live" ? "SYNCED_LIVE" : "SYNCED_BACKUP",
      detail: `data as of ${sourceAsOf}; ${rows.length} entities`,
      exit_code: 0,
    },
    { onConflict: "source" },
  );
  if (hbError) console.error("sync_heartbeats upsert failed:", hbError.message);

  // The gap between the two timestamps is the whole point of the table, so say
  // it out loud in the function log too.
  const lagMin = (Date.parse(now) - Date.parse(sourceAsOf)) / 60000;
  console.log(
    `sync-state: ${rows.length} entities, data as of ${sourceAsOf} ` +
      `(${lagMin.toFixed(0)} min before this run, dump=${dumpSource ?? "unknown"})`,
  );

  return NextResponse.json({ ok: true, entities: rows.length, source_as_of: sourceAsOf });
}
