import { NextResponse } from "next/server";
import { gate, cleanSo } from "../../../_lib/gate";
import { postUpdate } from "@/lib/monday";

// POST /api/orders/[so]/actions/[id]  { op: "send" | "cancel" | "undo" }
//
// The human half of the SO assistant's writes:
//   send    a pending Monday draft -> posts it on the SO's Monday item
//   cancel  a pending Monday draft -> discarded, never posted
//   undo    an applied correction / retraction / meeting-note edit /
//           key-points rewrite -> restored from the `before` recorded
//           when it was applied
//
// Every resolution is stamped with who did it. Anyone on the team may act
// on any action -- the thread is shared -- and the log says who.

export const runtime = "nodejs";

type Params = { params: Promise<{ so: string; id: string }> };

type ActionRow = {
  id: string;
  so_number: string;
  kind: string;
  status: string;
  summary: string | null;
  payload: Record<string, unknown>;
  before: Record<string, unknown> | null;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function POST(request: Request, { params }: Params) {
  const g = await gate();
  if (g.error) return g.error;
  const p = await params;
  const so = cleanSo(p.so);
  const id = /^[0-9a-f-]{36}$/i.test(p.id) ? p.id : null;
  if (!so || !id) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  let op: string;
  try {
    op = String(((await request.json()) as { op?: unknown }).op ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const { data, error } = await g.admin
    .from("so_chat_actions")
    .select("id, so_number, kind, status, summary, payload, before")
    .eq("id", id)
    .eq("so_number", so)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const a = data as ActionRow;

  const resolve = async (status: string, result?: unknown) => {
    await g.admin
      .from("so_chat_actions")
      .update({
        status,
        resolved_by: g.email,
        resolved_at: new Date().toISOString(),
        ...(result !== undefined ? { result } : {}),
      })
      .eq("id", a.id);
    return NextResponse.json({ ok: true, status });
  };
  const fail = (msg: string, code = 409) => NextResponse.json({ ok: false, error: msg }, { status: code });

  // ---- Monday drafts ------------------------------------------------------
  if (a.kind === "monday_post") {
    if (a.status !== "pending") return fail(`already ${a.status}`);
    if (op === "cancel") return resolve("cancelled");
    if (op !== "send") return fail("unsupported op", 400);

    const itemId = String(a.payload.monday_item_id ?? "");
    const text = String(a.payload.body ?? "").trim();
    if (!itemId || !text) return fail("draft is incomplete", 400);
    // Posts appear under the Monday API token's owner, so say who asked.
    const who = g.name ?? g.email;
    const html = `${escapeHtml(text).replace(/\n/g, "<br>")}<br><br><i>— via SO assistant, for ${escapeHtml(who)}</i>`;
    let updateId: string | null = null;
    try {
      updateId = await postUpdate(itemId, html);
    } catch (err) {
      await resolve("failed", { error: err instanceof Error ? err.message : String(err) });
      return fail("monday_post_failed", 502);
    }
    if (!updateId) {
      await resolve("failed", { error: "no update id returned" });
      return fail("monday_post_failed", 502);
    }

    // Show it on the card now rather than after the next Monday sync, which
    // will replace this entry with Monday's own copy (same id).
    const { data: cache } = await g.admin
      .from("so_monday_activity")
      .select("updates")
      .eq("so_number", so)
      .maybeSingle();
    const prior = Array.isArray((cache as { updates?: unknown } | null)?.updates)
      ? ((cache as { updates: unknown[] }).updates)
      : [];
    await g.admin
      .from("so_monday_activity")
      .update({
        updates: [
          {
            id: updateId,
            text_body: `${text}\n\n— via SO assistant, for ${who}`,
            created_at: new Date().toISOString(),
            creator_name: who,
            kind: "update",
            parent_id: null,
          },
          ...prior,
        ].slice(0, 60),
      })
      .eq("so_number", so);

    return resolve("sent", { monday_update_id: updateId });
  }

  // ---- undo of applied changes -------------------------------------------
  if (op !== "undo") return fail("unsupported op", 400);
  if (a.status !== "applied") return fail(`already ${a.status}`);

  if (a.kind === "correction") {
    const cid = String(a.payload.correction_id ?? "");
    const { error: e } = await g.admin
      .from("so_corrections")
      .update({ retracted_at: new Date().toISOString(), retracted_by: g.email })
      .eq("id", cid)
      .eq("so_number", so);
    if (e) return fail(e.message, 500);
    return resolve("undone");
  }

  if (a.kind === "retract_correction") {
    const cid = String(a.payload.correction_id ?? "");
    const { error: e } = await g.admin
      .from("so_corrections")
      .update({ retracted_at: null, retracted_by: null })
      .eq("id", cid)
      .eq("so_number", so);
    if (e) return fail(e.message, 500);
    return resolve("undone");
  }

  if (a.kind === "meeting_note_edit") {
    const b = a.before ?? {};
    const nid = String(b.note_id ?? "");
    if (!nid) return fail("nothing to restore", 500);
    const { error: e } = await g.admin
      .from("meeting_so_notes")
      .update({
        note_md: b.note_md ?? null,
        note_md_es: b.note_md_es ?? null,
        // Restore the mismatch warnings too, when the edit had cleared them.
        ...("customer_mismatch" in b
          ? { customer_mismatch: b.customer_mismatch ?? false, customer_hint: b.customer_hint ?? null }
          : {}),
        ...("product_mismatch" in b
          ? { product_mismatch: b.product_mismatch ?? false, product_hint: b.product_hint ?? null }
          : {}),
      })
      .eq("id", nid)
      .eq("so_number", so);
    if (e) return fail(e.message, 500);
    return resolve("undone");
  }

  if (a.kind === "key_points") {
    const b = a.before;
    const { error: e } = b
      ? await g.admin.from("so_synthesis").upsert(
          {
            so_number: so,
            headline: b.headline ?? null,
            points: b.points ?? [],
            headline_es: b.headline_es ?? null,
            points_es: b.points_es ?? null,
            generated_at: b.generated_at ?? new Date().toISOString(),
            based_on: b.based_on ?? null,
          },
          { onConflict: "so_number" },
        )
      : await g.admin.from("so_synthesis").delete().eq("so_number", so);
    if (e) return fail(e.message, 500);
    return resolve("undone");
  }

  return fail("unsupported action", 400);
}
