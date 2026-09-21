// Finished Product pricing = two tools, one quote.
//
// A Finished Product takes bulk and packaging and combines them into a
// retail-ready unit. Each half is priced by the tool that already prices it
// — the Pricing Calculator for bulk, the bottle / blister / pouch board for
// packaging — and this strip is what makes the pair read as one calculator:
// the same two tabs across the top of both pages.
//
// The tabs are links, not client state. Each page keeps its own Save, and
// the Packaging tab reads the Bulk tab's SAVED cost — so switching tabs is a
// navigation, and the note below says to save first.

const PACKAGING_LABEL: Record<string, string> = {
  bottles: "Bottles",
  blisters: "Blisters",
  pouches: "Pouches",
  sachets: "Sachets",
};

export function finishedProductPackagingHref(
  workflowId: string,
  packagingType: string | null | undefined,
): string | null {
  if (packagingType === "bottles") return `/workflow/${workflowId}/bottle-costing`;
  if (packagingType === "blisters") return `/workflow/${workflowId}/blister-costing`;
  if (packagingType === "pouches") return `/workflow/${workflowId}/pouch-costing`;
  if (packagingType === "sachets") return `/workflow/${workflowId}/sachet-costing`;
  return null;
}

export default function FinishedProductTabs({
  workflowId,
  packagingType,
  active,
}: {
  workflowId: string;
  packagingType: string | null | undefined;
  active: "bulk" | "packaging";
}) {
  const packagingHref = finishedProductPackagingHref(workflowId, packagingType);
  const tab = (on: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 18px",
    borderRadius: "10px 10px 0 0",
    border: "1px solid var(--teal-700, #1d6c7b)",
    borderBottom: on ? "1px solid var(--paper, #fffdf8)" : "1px solid var(--teal-700, #1d6c7b)",
    marginBottom: -1,
    background: on ? "var(--paper, #fffdf8)" : "var(--cream, #f6efe3)",
    color: "var(--teal-900, #0f4a56)",
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    textDecoration: "none",
    cursor: on ? "default" : "pointer",
    opacity: on ? 1 : 0.85,
  });
  const step: React.CSSProperties = {
    display: "inline-grid",
    placeItems: "center",
    width: 20,
    height: 20,
    borderRadius: 999,
    fontSize: 11,
    background: "var(--teal-700, #1d6c7b)",
    color: "#fff",
  };

  return (
    <div className="bc-noprint" style={{ marginBottom: 18 }}>
      <div
        role="tablist"
        aria-label="Finished product pricing"
        style={{
          display: "flex",
          gap: 6,
          borderBottom: "1px solid var(--teal-700, #1d6c7b)",
        }}
      >
        {active === "bulk" ? (
          <span role="tab" aria-selected="true" style={tab(true)}>
            <span style={step}>1</span> Bulk
          </span>
        ) : (
          <a role="tab" aria-selected="false" href={`/pricing?from=${workflowId}`} style={tab(false)}>
            <span style={step}>1</span> Bulk
          </a>
        )}
        {active === "packaging" ? (
          <span role="tab" aria-selected="true" style={tab(true)}>
            <span style={step}>2</span> Packaging
            {packagingType ? ` · ${PACKAGING_LABEL[packagingType] ?? packagingType}` : ""}
          </span>
        ) : packagingHref ? (
          <a role="tab" aria-selected="false" href={packagingHref} style={tab(false)}>
            <span style={step}>2</span> Packaging
            {packagingType ? ` · ${PACKAGING_LABEL[packagingType] ?? packagingType}` : ""}
          </a>
        ) : (
          <span
            role="tab"
            aria-disabled="true"
            title="Pick a packaging type on the quote first (Edit)."
            style={{ ...tab(false), opacity: 0.45, cursor: "not-allowed" }}
          >
            <span style={step}>2</span> Packaging
          </span>
        )}
      </div>
      <p
        style={{
          margin: "8px 2px 0",
          fontSize: 12.5,
          color: "var(--ink-3, #7b7364)",
        }}
      >
        {active === "bulk"
          ? "Price the bulk here and Save. Its landed cost (before this tab's margin and commissions) becomes the Bulk row on the Packaging tab, where one margin prices the finished unit."
          : "The Bulk row takes its cost from the Bulk tab's last save. Changed the bulk? Save it there, then reload this tab."}
      </p>
    </div>
  );
}
