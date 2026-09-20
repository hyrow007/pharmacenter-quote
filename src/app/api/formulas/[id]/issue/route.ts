import { NextResponse } from "next/server";
import { createClient } from "@/lib/auth/server";

// POST /api/formulas/[id]/issue — stamp the current revision with the
// next official version number (v54 issue/revision split).
//
// Saves cut immutable revision rows in gummy_formula_versions without
// touching the human-facing version number; this endpoint appends a row
// to gummy_formula_issues mapping issue_num (next official number) →
// revision_num (the formula's current latest revision), and audit-logs
// the event. Append-only: issuing never rewrites history.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "not_signed_in" }, { status: 401 });
  }
  if (!user.email?.endsWith("@pharmacenterusa.com")) {
    return NextResponse.json({ ok: false, error: "wrong_domain" }, { status: 403 });
  }
  const { id } = await params;

  const { data: formulaRow, error: formulaErr } = await supabase
    .from("gummy_formulas")
    .select("id, latest_version_num")
    .eq("id", id)
    .maybeSingle();
  if (formulaErr) {
    return NextResponse.json({ ok: false, error: formulaErr.message }, { status: 500 });
  }
  if (!formulaRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (!formulaRow.latest_version_num || formulaRow.latest_version_num < 1) {
    return NextResponse.json(
      { ok: false, error: "nothing_to_issue" },
      { status: 409 },
    );
  }

  // Current latest issue (if any). A missing table means the migration
  // hasn't run — surface that clearly instead of failing cryptically.
  const { data: lastIssue, error: issueErr } = await supabase
    .from("gummy_formula_issues")
    .select("issue_num, revision_num")
    .eq("formula_id", id)
    .order("issue_num", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (issueErr) {
    const migrationMissing = /gummy_formula_issues/.test(issueErr.message);
    return NextResponse.json(
      {
        ok: false,
        error: migrationMissing
          ? "issues_table_missing — run sql/gummy_formula_issues.sql"
          : issueErr.message,
      },
      { status: 500 },
    );
  }

  // Guard: nothing new to issue if the latest revision is already stamped.
  if (lastIssue && lastIssue.revision_num >= formulaRow.latest_version_num) {
    return NextResponse.json(
      {
        ok: true,
        alreadyIssued: true,
        issue: { issueNum: lastIssue.issue_num, revisionNum: lastIssue.revision_num },
      },
      { status: 200 },
    );
  }

  const nextIssueNum = (lastIssue?.issue_num ?? 0) + 1;

  const { data: inserted, error: insertErr } = await supabase
    .from("gummy_formula_issues")
    .insert({
      formula_id: id,
      issue_num: nextIssueNum,
      revision_num: formulaRow.latest_version_num,
      issued_by_email: user.email,
    })
    .select("issue_num, revision_num, issued_at")
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json(
      { ok: false, error: insertErr?.message || "issue_insert_failed" },
      { status: 500 },
    );
  }

  // Timeline event. 'issued' kind requires the migration's widened CHECK;
  // fall back to 'version' if the constraint hasn't been updated yet.
  const auditRow = {
    formula_id: id,
    by_email: user.email,
    kind: "issued",
    version_num: nextIssueNum,
    summary: `Issued v${nextIssueNum} — official version stamped at revision ${formulaRow.latest_version_num}`,
    diff: { issueNum: nextIssueNum, revisionNum: formulaRow.latest_version_num },
  };
  const { error: auditErr } = await supabase
    .from("gummy_formula_audit")
    .insert(auditRow);
  if (auditErr && /kind/.test(auditErr.message)) {
    await supabase
      .from("gummy_formula_audit")
      .insert({ ...auditRow, kind: "version" });
  }

  return NextResponse.json(
    {
      ok: true,
      issue: { issueNum: inserted.issue_num, revisionNum: inserted.revision_num },
    },
    { status: 201 },
  );
}
