import { redirect } from "next/navigation";

// /meetings — retired 2026-11-28.
//
// This was the hub that meeting.pharmacenter.app fronted: one card per
// meeting type, each linking into its own sessions area. It existed because
// the weekly sales-order review was recorded to Plaud and the record WAS the
// product. That stopped in November 2026 -- orders are now updated by typing
// into the assistant on each SO -- which left a front door listing a single
// meeting type whose feed no longer runs.
//
// Everything underneath is still live and still reachable:
//   /meetings/sales-orders           the type's own page + session history
//   /meetings/sales-orders/all       the working board
//   /meetings/sales-orders/orders/*  the SO pages, linked from Monday and
//                                    from the assistant -- do not move these
//                                    without redirects
//
// Only the hub is gone, because a menu with one item is not a menu. Anyone
// landing here goes where the work actually happens.
//
// The host rewrite that points meeting.pharmacenter.app at this route lives
// in middleware.ts, which this chat does not own. Until that is folded into
// the orders host, this redirect is what retires the front door.

export const metadata = { title: "Sales Orders" };

export default function MeetingsHubPage() {
  redirect("https://orders.pharmacenter.app/");
}
