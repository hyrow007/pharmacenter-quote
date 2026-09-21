// Shared vocabulary for the roadmap (src/app/roadmap). Lives outside the
// "use server" actions file because a server-actions module may export only
// async functions -- constants exported from it break the build.
//
// Every list here mirrors a CHECK constraint on public.roadmap_items
// (pharmacenter-db, 20260921150000_roadmap_items.sql). Change one, change the
// other: the database is the last word, and a value it rejects surfaces as a
// save error rather than a silent drop.

import type { DictKey } from "@/lib/i18n/dict";

export const ROADMAP_STATUSES = [
  "idea",
  "planned",
  "in_progress",
  "shipped",
  "dropped",
] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const ROADMAP_APPS = [
  "hub",
  "quote",
  "packing",
  "formula",
  "orders",
  "meetings",
  "sync",
  "new",
] as const;
export type RoadmapApp = (typeof ROADMAP_APPS)[number];

export type RoadmapPriority = 1 | 2 | 3;

export type RoadmapItem = {
  id: string;
  title: string;
  details: string | null;
  app: RoadmapApp;
  status: RoadmapStatus;
  priority: RoadmapPriority;
  created_by: string;
  created_at: string;
  shipped_at: string | null;
};

export const STATUS_LABEL: Record<RoadmapStatus, DictKey> = {
  idea: "rmStatusIdea",
  planned: "rmStatusPlanned",
  in_progress: "rmStatusInProgress",
  shipped: "rmStatusShipped",
  dropped: "rmStatusDropped",
};

// App labels reuse the hub's tile names where one exists, so a tool is called
// the same thing on the roadmap as on the tile that opens it.
export const APP_LABEL: Record<RoadmapApp, DictKey> = {
  hub: "rmAppHub",
  quote: "hubQuoteName",
  packing: "hubListsName",
  formula: "hubFormulasName",
  orders: "hubOrdersName",
  meetings: "hubMeetingsName",
  sync: "rmAppSync",
  new: "rmAppNew",
};

export const PRIORITY_LABEL: Record<RoadmapPriority, DictKey> = {
  1: "rmPriorityHigh",
  2: "rmPriorityMedium",
  3: "rmPriorityLow",
};

export function isStatus(v: unknown): v is RoadmapStatus {
  return typeof v === "string" && (ROADMAP_STATUSES as readonly string[]).includes(v);
}
export function isApp(v: unknown): v is RoadmapApp {
  return typeof v === "string" && (ROADMAP_APPS as readonly string[]).includes(v);
}
export function isPriority(v: unknown): v is RoadmapPriority {
  return v === 1 || v === 2 || v === 3;
}
