import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadFishbowlLexicon,
  correctPlaudText,
  type Lexicon,
} from "@/lib/plaud/fishbowlLexicon";

// Everything the SO assistant knows about one sales order, gathered in one
// pass so the model can answer most questions without a tool call.
//
// Server-only. Reads go through the caller's RLS client; every table here is
// readable by any signed-in @pharmacenterusa.com user already.
//
// Plaud-sourced meeting text is run through the Fishbowl lexicon before the
// model sees it ("Kunza" -> "Cunsa"), the same correction the pages apply at
// render time. The ORIGINAL text is kept alongside, because a meeting-note
// edit must replace what is actually stored, not the corrected rendering.

type Row = Record<string, unknown>;

export type SoContext = {
  so_number: string;
  found: boolean;
  fishbowl: Row | null;
  purchase_orders: Row[];
  monday: {
    status: unknown;
    monday_url: unknown;
    monday_item_id: unknown;
    item_updated_at: unknown;
    last_synced_at: unknown;
    updates: Row[];
  } | null;
  meeting_notes: Array<{
    id: string;
    session_date: string | null;
    attendees: string[];
    note_md: string | null;
    note_md_stored: string | null;
    action_items: unknown;
    status_flag: unknown;
    customer_mismatch: unknown;
    customer_hint: unknown;
    product_mismatch: unknown;
    product_hint: unknown;
  }>;
  key_points: Row | null;
  corrections: Row[];
  customer_other_open_sos: Row[];
  fishbowl_synced_at: string | null;
};

const SO_COLS =
  "so_number, status_id, status_name, is_open, customer_name, customer_po, " +
  "salesman, note, date_issued, date_created, date_first_ship, " +
  "date_last_modified, subtotal, total_price, items, synced_at";

const PO_COLS =
  "po_number, status_name, is_open, vendor_name, buyer, date_issued, " +
  "date_created, date_completed, subtotal, total_price, items, so_numbers";

// Shipping / tax / discount lines (40 / 50 / 70) carry no product signal.
const SALE_TYPE_IDS = new Set([10, 30]);

function slimItems(items: unknown): Row[] {
  if (!Array.isArray(items)) return [];
  return (items as Row[])
    .filter((it) => {
      const t = Number(it?.type_id);
      return !Number.isFinite(t) || SALE_TYPE_IDS.has(t);
    })
    .map((it) => ({
      line: it.line ?? null,
      product_num: it.product_num ?? it.part_num ?? null,
      description: it.description ?? null,
      qty_ordered: it.qty_ordered ?? it.qty ?? null,
      qty_fulfilled: it.qty_fulfilled ?? null,
      qty_picked: it.qty_picked ?? null,
      uom: it.uom ?? null,
      unit_price: it.unit_price ?? it.unit_cost ?? null,
      total_price: it.total_price ?? it.total_cost ?? null,
      date_scheduled: it.date_scheduled ?? null,
    }));
}

export async function loadSoContext(
  supabase: SupabaseClient,
  soNumber: string,
  lexicon?: Lexicon,
): Promise<SoContext> {
  const so = soNumber.trim();

  const [soRes, poRes, mondayRes, notesRes, synRes, corrRes] =
    await Promise.all([
      supabase.from("fishbowl_sales_orders").select(SO_COLS).eq("so_number", so).maybeSingle(),
      supabase
        .from("fishbowl_purchase_orders")
        .select(PO_COLS)
        .contains("so_numbers", [so])
        .order("date_issued", { ascending: false })
        .limit(20),
      supabase
        .from("so_monday_activity")
        .select("status, monday_url, monday_item_id, item_updated_at, last_synced_at, updates")
        .eq("so_number", so)
        .maybeSingle(),
      supabase
        .from("meeting_so_notes")
        .select(
          "id, note_md, action_items, status_flag, customer_mismatch, customer_hint, " +
            "product_mismatch, product_hint, created_at, meeting_sessions(session_date, attendees)",
        )
        .eq("so_number", so)
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("so_synthesis")
        .select("headline, points, headline_es, points_es, generated_at, based_on")
        .eq("so_number", so)
        .maybeSingle(),
      supabase
        .from("so_corrections")
        .select("id, topic, text, text_es, supersedes, created_by, created_by_name, created_at, retracted_at, retracted_by")
        .eq("so_number", so)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

  const fb = (soRes.data ?? null) as unknown as Row | null;
  const lex = lexicon ?? (await loadFishbowlLexicon(supabase));
  const fix = (t: unknown): string | null =>
    typeof t === "string" && t ? correctPlaudText(t, lex).corrected : null;

  let others: Row[] = [];
  const customer = typeof fb?.customer_name === "string" ? fb.customer_name : null;
  if (customer) {
    const { data } = await supabase
      .from("fishbowl_sales_orders")
      .select("so_number, status_name, customer_po, date_issued, date_first_ship, total_price")
      .eq("customer_name", customer)
      .eq("is_open", true)
      .neq("so_number", so)
      .order("so_number", { ascending: true })
      .limit(40);
    others = (data ?? []) as unknown as Row[];
  }

  const monday = (mondayRes.data ?? null) as unknown as Row | null;
  const notes = ((notesRes.data ?? []) as unknown as Row[]).map((n) => {
    const s = (n.meeting_sessions ?? null) as Row | null;
    return {
      id: String(n.id),
      session_date: typeof s?.session_date === "string" ? s.session_date : null,
      attendees: Array.isArray(s?.attendees) ? (s!.attendees as string[]) : [],
      note_md: fix(n.note_md),
      note_md_stored: typeof n.note_md === "string" ? n.note_md : null,
      action_items: n.action_items ?? [],
      status_flag: n.status_flag ?? null,
      customer_mismatch: n.customer_mismatch ?? false,
      customer_hint: n.customer_hint ?? null,
      product_mismatch: n.product_mismatch ?? false,
      product_hint: n.product_hint ?? null,
    };
  });

  return {
    so_number: so,
    found: !!fb,
    fishbowl: fb
      ? { ...fb, items: slimItems(fb.items) }
      : null,
    purchase_orders: ((poRes.data ?? []) as unknown as Row[]).map((p) => ({
      ...p,
      items: Array.isArray(p.items) ? (p.items as Row[]).slice(0, 40) : [],
    })),
    monday: monday
      ? {
          status: monday.status ?? null,
          monday_url: monday.monday_url ?? null,
          monday_item_id: monday.monday_item_id ?? null,
          item_updated_at: monday.item_updated_at ?? null,
          last_synced_at: monday.last_synced_at ?? null,
          updates: Array.isArray(monday.updates) ? (monday.updates as Row[]).slice(0, 60) : [],
        }
      : null,
    meeting_notes: notes,
    key_points: (synRes.data ?? null) as unknown as Row | null,
    corrections: (corrRes.data ?? []) as unknown as Row[],
    customer_other_open_sos: others,
    fishbowl_synced_at: typeof fb?.synced_at === "string" ? fb.synced_at : null,
  };
}

/** Compact search across the Fishbowl SO mirror, for the search tool. */
export async function searchSalesOrders(
  supabase: SupabaseClient,
  query: string,
  includeClosed: boolean,
): Promise<Row[]> {
  const q = query.trim().replace(/[%,()]/g, " ").slice(0, 80);
  if (!q) return [];
  let req = supabase
    .from("fishbowl_sales_orders")
    .select("so_number, status_name, is_open, customer_name, customer_po, date_issued, date_first_ship, total_price")
    .or(`so_number.ilike.%${q}%,customer_name.ilike.%${q}%,customer_po.ilike.%${q}%,note.ilike.%${q}%`)
    .order("so_number", { ascending: false })
    .limit(25);
  if (!includeClosed) req = req.eq("is_open", true);
  const { data } = await req;
  let rows = (data ?? []) as unknown as Row[];

  // Products live inside items jsonb, which .or() cannot reach. If the text
  // search found nothing, fall back to scanning open orders' line items.
  if (rows.length === 0) {
    const { data: all } = await supabase
      .from("fishbowl_sales_orders")
      .select("so_number, status_name, is_open, customer_name, customer_po, items")
      .eq("is_open", true)
      .limit(500);
    const needle = q.toLowerCase();
    rows = ((all ?? []) as unknown as Row[])
      .filter((r) =>
        Array.isArray(r.items) &&
        (r.items as Row[]).some((it) =>
          `${it.product_num ?? ""} ${it.description ?? ""}`.toLowerCase().includes(needle),
        ),
      )
      .slice(0, 25)
      .map((r) => ({ ...r, items: slimItems(r.items).slice(0, 6) }));
  }
  return rows;
}

export async function getPurchaseOrder(
  supabase: SupabaseClient,
  poNumber: string,
): Promise<Row | null> {
  const { data } = await supabase
    .from("fishbowl_purchase_orders")
    .select(PO_COLS)
    .eq("po_number", poNumber.trim())
    .maybeSingle();
  return (data ?? null) as unknown as Row | null;
}
