import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";
import { auditFromRow, type GummyFormulaAuditRecord } from "@/lib/formulas";

// GET /api/formulas/[id]/audit
//   → { ok: true, events: GummyFormulaAuditRecord[] }
//
// Returns the full audit timeline for a formula in reverse-chronological
// order (newest first). by_email is resolved to a display_name via
// user_directory so the UI can render "Jairo Osorno" instead of the raw
// email.

type GateResult =
  | { error: NextResponse; supabase?: undefined }
  | { error?: undefined; supabase: Awaited<ReturnType<typeof createClient>> };

async function gatedClient(): Promise<GateResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 }),
    };
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return {
      error: NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 }),
    };
  }
  return { supabase };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await gatedClient();
  if (gated.error) return gated.error;
  const { supabase } = gated;
  const { id } = await params;

  const { data, error } = await supabase
    .from("gummy_formula_audit")
    .select("id, formula_id, at, by_email, kind, version_num, summary, diff")
    .eq("formula_id", id)
    .order("at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Batch-resolve emails → display names in ONE query, then hydrate.
  const emails = Array.from(
    new Set((data ?? []).map((r) => r.by_email).filter((e): e is string => !!e)),
  );
  const displayByEmail = new Map<string, string>();
  if (emails.length > 0) {
    const { data: dirRows } = await supabase
      .from("user_directory")
      .select("email, display_name")
      .in("email", emails);
    (dirRows ?? []).forEach((row) => {
      if (row.email && row.display_name) {
        displayByEmail.set(row.email, row.display_name);
      }
    });
  }

  const events: GummyFormulaAuditRecord[] = (data ?? []).map((row) => {
    const display = row.by_email ? displayByEmail.get(row.by_email) ?? null : null;
    return auditFromRow(row, display);
  });

  return NextResponse.json({ ok: true, events });
}
