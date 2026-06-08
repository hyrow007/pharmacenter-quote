# PharmaCenter Quote

Customer-facing tool for generating PharmaCenter quotes. Architectural twin of the
Packing List generator — same stack, same brand, same dispatch pipeline.

## Stack

- **Next.js 14** (App Router, TypeScript) — frontend
- **Supabase** (Postgres + Auth + RLS) — database; shared with the other PharmaCenter apps
- **Vercel** — hosting at `quote.pharmacenter.app`

## Environments

| Env       | URL                              | Notes                            |
| --------- | -------------------------------- | -------------------------------- |
| Local dev | `http://localhost:3000`        | `npm run dev`                    |
| Preview   | `*.vercel.app`                 | auto-deployed per PR             |
| Prod      | `quote.pharmacenter.app`       | auto-deployed on push to `main`  |

## Configuration

Required environment variables (set in Vercel project settings — never commit):

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_DRIVE_FOLDER_ID=...
```

The Supabase URL/anon key are **the same values used by `pharmacenter-packing-list`**.
This is intentional — both apps point at the same Supabase project so they share
customer, product, and reference data.

## Shared customer data (Fishbowl source-of-truth)

```
   Fishbowl (on-prem)
         │
         ▼ nightly sync
   Supabase customers table  ◀── single source of truth for all apps
         │
   ┌─────┼─────┐
   ▼     ▼     ▼
quote  packing-list  (future apps)
```

`src/lib/supabase.ts` exports a shared client. `src/app/customer/page.tsx`
queries `from("customers").select("id, name, location")`. If env vars aren't
set or the table is empty, the page falls back to a built-in mock list so dev
and previews still render.

**Customers table schema (Supabase):**

| Column         | Type      | Notes                                          |
| -------------- | --------- | ---------------------------------------------- |
| id             | text PK   | Use Fishbowl customer ID, or generated UUID    |
| name           | text      | Display name                                   |
| location       | text      | "Frederick, MD" — city/state, optional         |
| contact_name   | text      | Optional                                       |
| email          | text      | Optional                                       |
| phone          | text      | Optional                                       |
| fishbowl_id    | text      | Original Fishbowl ID for sync reconciliation   |
| created_at     | timestamp | `default now()`                              |
| updated_at     | timestamp | Updated by sync job                            |

**Fishbowl → Supabase sync** is a separate piece of work. Recommended: a small
Node script running wherever has LAN access to the Fishbowl Server, queried
nightly, upserting to Supabase via the service-role key.

## Legacy artifacts

The `legacy/` folder holds the pre-Next.js standalone HTML bundle and its source
JSX (the v0 customer-facing quote generator). Kept for reference and immediate
visual iteration while the Next.js app reaches feature parity. The standalone
`PharmaCenter Quote Generator.html` in `legacy/` can be opened directly in any
browser — no build step.

## Storage (v0 bundle only)

The legacy/standalone bundle autosaves to `localStorage` under the separate
`pharmacenter-quote` key. The Packing List's data at `pharmacenter-packing-list`
is never touched.
