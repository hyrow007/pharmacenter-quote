# PharmaCenter Quote

Customer-facing tool for generating PharmaCenter quotes. Architectural twin of the
Packing List generator — same stack, same brand, same dispatch pipeline.

## Stack

- **Next.js 14** (App Router, TypeScript) — frontend + server-rendered PDF generation
- **Supabase** (Postgres + Auth + RLS) — database, Google SSO restricted to the workspace
- **Vercel** — hosting at `quote.pharmacenter.app`
- **Google Drive API** — finalized PDFs land in a shared `Quotes/` folder organized by customer and quote number

## Environments

| Env       | URL                              | Notes                            |
| --------- | -------------------------------- | -------------------------------- |
| Local dev | `http://localhost:3000`          | `npm run dev`                    |
| Preview   | `*.vercel.app`                   | auto-deployed per PR             |
| Prod      | `quote.pharmacenter.app`         | auto-deployed on push to `main`  |

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

Same values as `pharmacenter-packing-list` except `GOOGLE_DRIVE_FOLDER_ID`,
which should point to a new shared `Quotes/` folder in Drive.

## First-time deploy (mirrors packing-list)

1. Create an empty repo: `https://github.com/hyrow007/pharmacenter-quote`
2. Create a Vercel project linked to that repo. Copy env vars from the
   `pharmacenter-packing-list` project; override `GOOGLE_DRIVE_FOLDER_ID`.
3. In the Vercel project's domain settings, add `quote.pharmacenter.app` and
   set the CNAME at your registrar.
4. Make a `C:\q` junction pointing at this folder, then run `init-git.ps1`.
   It clones the repo to `C:\code\pharmacenter-quote`, copies the scaffold,
   archives the v0 bundle into `legacy/`, and pushes — Vercel auto-deploys.

## Legacy artifacts

The `legacy/` folder holds the pre-Next.js standalone HTML bundle and its source
JSX (the v0 customer-facing quote generator). Kept for reference and immediate
visual iteration while the Next.js app reaches feature parity.

The standalone `PharmaCenter Quote Generator.html` in `legacy/` can be opened
directly in any browser — no build step.

## Storage (v0 bundle only)

The legacy/standalone bundle autosaves to `localStorage` under the separate
`pharmacenter-quote` key. The Packing List's data at `pharmacenter-packing-list`
is never touched. See `CLAUDE.md` for the full key table.
