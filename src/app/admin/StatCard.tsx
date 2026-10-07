// One number in the admin landing's stats row. Plain component, no "use
// client": the landing is a server component and these are just numbers.
export default function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        background: "var(--paper, #fffdf8)",
        border: "1px solid var(--line, #e3dcc9)",
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--ink-3, #8a9498)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: "var(--teal-900, #0f4a56)",
          marginTop: 2,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value.toLocaleString("en-US")}
      </div>
    </div>
  );
}
