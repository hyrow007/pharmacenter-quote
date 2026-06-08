"use client";

import { useState, type FormEvent, type ChangeEvent, type CSSProperties } from "react";

type Mode = "existing" | "new";

// MOCK DATA — replace with Fishbowl API once we have credentials.
// See CLAUDE.md for the planned integration shape.
const CUSTOMERS = [
  { id: "greenfield",       name: "Greenfield Apothecary, Inc.",      location: "Frederick, MD" },
  { id: "bay-health",       name: "Bay Health Brands LLC",            location: "Tampa, FL" },
  { id: "coastal-vitamins", name: "Coastal Vitamins Co.",             location: "San Diego, CA" },
  { id: "natures-vault",    name: "Nature's Vault Distribution",      location: "Boulder, CO" },
  { id: "pure-path",        name: "Pure Path Nutrition",              location: "Austin, TX" },
  { id: "liberty-wellness", name: "Liberty Wellness Group",           location: "Philadelphia, PA" },
  { id: "crescent-pharma",  name: "Crescent Pharma Supply",           location: "Chicago, IL" },
  { id: "heritage-nutra",   name: "Heritage Nutraceuticals",          location: "Phoenix, AZ" },
  { id: "aurora-health",    name: "Aurora Health Distributors",       location: "Portland, OR" },
  { id: "summit-supplement", name: "Summit Supplement Co.",           location: "Denver, CO" },
];

export default function Customer() {
  const [mode, setMode] = useState<Mode>("existing");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ name: "", contact: "", email: "" });

  const filtered = CUSTOMERS.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const qs = new URLSearchParams({
      customer: "new",
      name: form.name,
      contact: form.contact,
      email: form.email,
    }).toString();
    window.location.href = `/start?${qs}`;
  };

  const tabBtn = (active: boolean): CSSProperties => ({
    flex: 1,
    padding: "10px 16px",
    border: "none",
    borderRadius: 7,
    background: active ? "var(--teal-900)" : "transparent",
    color: active ? "#fff" : "var(--teal-700)",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    transition: "all 0.15s ease",
    fontFamily: "inherit",
  });

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "10px 14px",
    border: "1.5px solid #e3dcc9",
    borderRadius: 8,
    fontSize: 14,
    background: "#fff",
    color: "var(--ink-1)",
    boxSizing: "border-box",
    fontFamily: "inherit",
  };

  const labelText: CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--ink-3)",
  };

  return (
    <main className="hero">
      <div className="card card--wide">
        <p className="eyebrow">PharmaCenter</p>
        <h1>Who are we quoting?</h1>
        <p className="lede">
          Pick an existing customer from our Fishbowl records, or add a new one.
        </p>

        <div style={{ display: "flex", gap: 0, marginBottom: 20, border: "1.5px solid #e3dcc9", borderRadius: 10, padding: 4, background: "#fffdf8" }}>
          <button type="button" style={tabBtn(mode === "existing")} onClick={() => setMode("existing")}>Existing customer</button>
          <button type="button" style={tabBtn(mode === "new")} onClick={() => setMode("new")}>New customer</button>
        </div>

        {mode === "existing" ? (
          <div>
            <input
              type="text"
              placeholder="Search customers..."
              value={search}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              style={{ ...inputStyle, marginBottom: 14 }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20, maxHeight: 320, overflowY: "auto" }}>
              {filtered.map((c) => (
                <a key={c.id} className="opt" href={`/start?customer=${c.id}`}>
                  <span className="opt__name">{c.name}</span>
                  <span className="opt__desc">{c.location}</span>
                </a>
              ))}
              {filtered.length === 0 ? (
                <p style={{ color: "var(--ink-3)", textAlign: "center", padding: "20px", fontSize: 14 }}>
                  No customers match &quot;{search}&quot;.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <form onSubmit={submitNew} style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 24 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelText}>Company name *</span>
              <input type="text" required value={form.name} onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelText}>Primary contact</span>
              <input type="text" value={form.contact} onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, contact: e.target.value })} style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelText}>Email</span>
              <input type="email" value={form.email} onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, email: e.target.value })} style={inputStyle} />
            </label>
            <button type="submit" className="cta" style={{ alignSelf: "flex-start", marginBottom: 0, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              Continue →
            </button>
          </form>
        )}

        <a href="/" className="backlink">← Back</a>
      </div>
    </main>
  );
}
