import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isAdmin as checkIsAdmin } from "@/lib/workflows";
import { HUB_HOSTS } from "@/lib/hub-hosts";
import AppHeader from "../_components/AppHeader";
import StatCard from "./StatCard";

// /admin — the one back-office index for the whole ecosystem.
//
// Until 2026-10-07 there were two of these: this page, with its own card
// grid, and packing's /admin with another. Users appeared on both -- this one
// answered "who is an admin", packing's answered "who are the users" -- and an
// admin had to know which host held which screen. Admin spans the apps, so it
// belongs on the apex next to the roadmap, not under the Quote product. The
// hub is served by this same deployment, so pharmacenter.app/admin and
// quote.pharmacenter.app/admin are the same route; the links across the apps
// now point at the hub, and the header wears hub chrome there automatically.
//
// This page is an index and a set of counts. Nothing is edited here -- the
// user management that used to sit inline moved to /admin/users.
//
// Gated twice on purpose: the nav link hides for non-admins, and this redirect
// catches a typed-in URL. RLS is the gate that actually holds.

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

type Card = {
  href: string;
  title: string;
  blurb: string;
  // An absolute link to the other Vercel project. Worth marking, because
  // these are the ones pass 2 is meant to absorb.
  away?: boolean;
};

async function safeCount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  table: string,
): Promise<number> {
  try {
    const { count } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true });
    return typeof count === "number" ? count : 0;
  } catch {
    return 0;
  }
}

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.endsWith("@pharmacenterusa.com")) {
    redirect("/");
  }

  const host = (await headers()).get("host") ?? "";
  const onApexHost = HUB_HOSTS.has(host.split(":")[0].replace(/^www\./, ""));

  const admin = await checkIsAdmin(supabase, user.email);
  if (!admin) {
    // /workflows does not exist on the hub hosts, and middleware rewrites "/"
    // away from it on the formula and order hosts. Send a non-admin somewhere
    // that exists on the host they are actually on.
    redirect(onApexHost ? "/" : "/workflows");
  }

  const [adminsN, usersN, workflowsN, customersN, vendorsN, feedbackN] =
    await Promise.all([
      safeCount(supabase, "admins"),
      safeCount(supabase, "user_directory"),
      safeCount(supabase, "workflows"),
      safeCount(supabase, "customers"),
      safeCount(supabase, "vendors"),
      safeCount(supabase, "feedback"),
    ]);

  const GROUPS: { heading: string; note?: string; cards: Card[] }[] = [
    {
      heading: "People",
      cards: [
        {
          href: "/admin/users",
          title: "Users & admins",
          blurb:
            "Everyone who has signed in to any app, who has elevated access, and what they have been doing.",
        },
      ],
    },
    {
      heading: "Master data",
      note: "Fishbowl is the source of truth for customers and products. These screens are for what Fishbowl does not carry.",
      cards: [
        {
          href: "/admin/raw-materials",
          title: "Raw materials",
          blurb: "The ingredient catalogue the gummy formula calculator prices against.",
        },
        {
          href: "https://packing.pharmacenter.app/admin/customers",
          title: "Customers",
          blurb: "Ship-to defaults and which customers are active.",
          away: true,
        },
        {
          href: "https://packing.pharmacenter.app/admin/products",
          title: "Products",
          blurb: "Finished-good codes, default units, and which products are active.",
          away: true,
        },
      ],
    },
    {
      heading: "Across the apps",
      cards: [
        {
          href: "/roadmap",
          title: "Roadmap",
          blurb: "Features and tools we want to add, and what state each one is in.",
        },
        {
          href: "/feedback",
          title: "Feedback",
          blurb: "What people have reported from any of the four apps.",
        },
      ],
    },
  ];

  return (
    <div className="app-shell">
      <AppHeader user={{ email: user.email! }} />
      <main className="page">
        <div className="page__inner--narrow">
          <div style={{ marginBottom: 18 }}>
            <p className="eyebrow" style={{ marginBottom: 6 }}>
              PharmaCenter
            </p>
            <h1 className="page-header__title" style={{ marginBottom: 6 }}>
              Admin
            </h1>
            <p className="lede" style={{ marginTop: 4, marginBottom: 0 }}>
              Every back-office screen across the four apps, in one place.
            </p>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 10,
              marginBottom: 26,
            }}
          >
            <StatCard label="Admins" value={adminsN} />
            <StatCard label="Users" value={usersN} />
            <StatCard label="Workflows" value={workflowsN} />
            <StatCard label="Customers" value={customersN} />
            <StatCard label="Vendors" value={vendorsN} />
            <StatCard label="Feedback" value={feedbackN} />
          </div>

          {GROUPS.map((group) => (
            <section key={group.heading} style={{ marginBottom: 26 }}>
              <h2
                style={{
                  margin: "0 0 4px",
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--ink-3, #8a9498)",
                }}
              >
                {group.heading}
              </h2>
              {group.note ? (
                <p
                  style={{
                    margin: "0 0 10px",
                    fontSize: 12.5,
                    color: "var(--ink-3, #8a9498)",
                    lineHeight: 1.5,
                  }}
                >
                  {group.note}
                </p>
              ) : (
                <div style={{ height: 10 }} />
              )}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                  gap: 10,
                }}
              >
                {group.cards.map((card) => (
                  <a
                    key={card.href}
                    href={card.href}
                    style={{
                      display: "block",
                      padding: "14px 16px",
                      background: "var(--paper, #fffdf8)",
                      border: "1px solid var(--line, #e3dcc9)",
                      borderRadius: 10,
                      textDecoration: "none",
                      color: "var(--teal-900, #0f4a56)",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        marginBottom: 4,
                      }}
                    >
                      {card.title} &rarr;
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--ink-3, #8a9498)",
                        lineHeight: 1.5,
                      }}
                    >
                      {card.blurb}
                      {card.away ? (
                        <span style={{ display: "block", marginTop: 4, opacity: 0.8 }}>
                          on packing.pharmacenter.app
                        </span>
                      ) : null}
                    </div>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
