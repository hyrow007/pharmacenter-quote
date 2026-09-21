"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/workflows";
import {
  isApp,
  isPriority,
  isStatus,
  type RoadmapApp,
  type RoadmapPriority,
  type RoadmapStatus,
} from "@/lib/roadmap";

// Writes for /roadmap. Admin-only twice over: checked here, and again by the
// RLS policies on public.roadmap_items, which are all gated on is_admin(). The
// check here exists to return a readable error; the policies are what actually
// hold the line.
//
// Results are returned, not thrown. Next redacts thrown errors in production,
// so a failed save would otherwise reach the board as "An error occurred" with
// nothing to act on.

export type RoadmapActionResult = { ok: true } | { ok: false; error: string };

const MAX_TITLE = 200;
const MAX_DETAILS = 4000;

async function adminClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !(await isAdmin(supabase, user.email))) return null;
  return supabase;
}

export async function addRoadmapItem(input: {
  title: string;
  details?: string;
  app: RoadmapApp;
  priority: RoadmapPriority;
}): Promise<RoadmapActionResult> {
  const supabase = await adminClient();
  if (!supabase) return { ok: false, error: "not_admin" };

  const title = (input.title ?? "").trim();
  const details = (input.details ?? "").trim();
  if (!title) return { ok: false, error: "empty_title" };
  if (title.length > MAX_TITLE) return { ok: false, error: "title_too_long" };
  if (details.length > MAX_DETAILS) return { ok: false, error: "details_too_long" };
  if (!isApp(input.app) || !isPriority(input.priority)) {
    return { ok: false, error: "bad_input" };
  }

  // created_by is filled by the column default from the JWT email -- not sent
  // from here, so the client cannot claim someone else added an item.
  const { error } = await supabase.from("roadmap_items").insert({
    title,
    details: details || null,
    app: input.app,
    priority: input.priority,
    status: "idea",
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/roadmap");
  return { ok: true };
}

export async function updateRoadmapItem(
  id: string,
  patch: { status?: RoadmapStatus; priority?: RoadmapPriority },
): Promise<RoadmapActionResult> {
  const supabase = await adminClient();
  if (!supabase) return { ok: false, error: "not_admin" };

  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) {
    if (!isStatus(patch.status)) return { ok: false, error: "bad_status" };
    row.status = patch.status;
    // Shipped carries a date so the column can say "shipped Sep 21"; moving
    // an item back out of Shipped clears it rather than leaving a stale date.
    row.shipped_at = patch.status === "shipped" ? new Date().toISOString() : null;
  }
  if (patch.priority !== undefined) {
    if (!isPriority(patch.priority)) return { ok: false, error: "bad_priority" };
    row.priority = patch.priority;
  }
  if (Object.keys(row).length === 0) return { ok: true };

  const { error } = await supabase.from("roadmap_items").update(row).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/roadmap");
  return { ok: true };
}

export async function deleteRoadmapItem(id: string): Promise<RoadmapActionResult> {
  const supabase = await adminClient();
  if (!supabase) return { ok: false, error: "not_admin" };
  const { error } = await supabase.from("roadmap_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/roadmap");
  return { ok: true };
}
