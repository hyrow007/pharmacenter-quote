// v50: in-app translations for the quote/formula app. Mirrors the
// packing list's i18n pattern (one dictionary, makeT(lang), a language
// cookie readable on both server and client) so the two codebases feel
// like one system. Spanish strings reuse the packing list's vocabulary
// where the same concept appears (navFeedback → "Comentarios", etc.).
//
// Unlike the packing list — whose customer-facing sheet is always
// English — the formula PRINT SHEET here is internal (bench operators),
// so print-sheet labels are translated too (slice 2).

export type Lang = "en" | "es";

// One preference across every PharmaCenter app: the cookie is written
// with domain=.pharmacenter.app (see LangToggle) so quote, formulas,
// and — once its LangToggle writes the same cookie — the packing list
// all flip together.
export const LANG_COOKIE_NAME = "pc-lang";

const en = {
  // ---- Header / nav ----
  navWorkflows: "Workflows",
  navFormulas: "Formulas",
  navLists: "Lists",
  navFeedback: "Feedback",
  navAdmin: "Admin",

  // ---- Formulas catalog ----
  catalogTitle: "Gummy Formula Catalog",
  catalogLede:
    "Every gummy design PharmaCenter has authored, indexed by PC-BK code (or held as TBD until R&D assigns one). Open a formula to view or edit its bench-top recipe, scale-up, and material costing.",
  catalogSearch: "Search customer, product code, name, flavor, or preparer…",
  allShapes: "All shapes",
  newFormula: "+ New formula",
  colFormula: "Formula",
  colProductCode: "Product code",
  colName: "Name",
  colCustomer: "Customer",
  colShape: "Shape",
  colFlavor: "Flavor",
  colVersion: "Version",
  colUpdated: "Updated",
  colActions: "Actions",
  deleteAction: "Delete",
  perPage: "Per page:",
  previous: "← Previous",
  next: "Next →",
  pageXofY: "Page {x} of {y}",
  backToFormulas: "← Back to formulas",
  backToWorkflows: "← Back to workflows",

  // ---- Editor chrome ----
  printPdf: "Print / PDF",
  saved: "Saved",
  tabBenchTop: "Bench top",
  tabScaleUp: "Scale up",
  tabMaterialCosting: "Material costing",
  addIngredient: "+ Add ingredient",
  addSolution: "+ Add solution",
  change: "Change",

  // ---- Meetings hub ----
  navMeetings: "Meetings",
  navOrders: "Sales Orders",
  meetingsBreadcrumb: "PharmaCenter · Meetings",
  meetingsTitle: "Meetings",
  meetingsHubLede:
    "A hub for PharmaCenter's recurring meetings. Pick a meeting type to see its weekly sessions and cross-referenced Fishbowl state.",
  meetingsNoTypes:
    "No meeting types configured yet. Add one to public.meeting_types to see it here.",
  meetingsSessionsCount: "sessions",
  meetingsSessionCountOne: "session",
  meetingsLastHeld: "Last held {date}",
  meetingsNoSessionsYet: "No sessions yet",

  // ---- Sales-orders landing ----
  backMeetings: "← Meetings",
  salesOrdersBreadcrumb: "PharmaCenter · Meetings · Sales Orders",
  salesOrdersTitle: "Sales Orders",
  salesOrdersLede: "Weekly review of open Fishbowl sales orders.",
  workingDocument: "WORKING DOCUMENT",
  cardOpenOrders: "Open orders",
  cardOpenOrdersBody:
    "Every open Fishbowl SO right now — search, sort, expand for line items. This is what you drive the meeting from.",
  cardComingWithPlaud: "COMING WITH PLAUD",
  cardWeeklySessions: "Weekly sessions",
  cardWeeklySessionsBody:
    "Each Plaud recording of the meeting becomes a session below. Notes are extracted per SO and cross-referenced against current Fishbowl state.",
  sessionHistory: "Session history",
  noSessionsPlaud:
    "No sessions yet. Once Plaud is wired up, each weekly recording will appear here automatically.",
  soCountPlural: "SOs",
  soCountSingle: "SO",
  plaudRecording: "Plaud recording",
  manualEntry: "Manual entry",
  seedNeeded:
    "Meeting type sales-orders isn't seeded yet. Run sql/meetings.sql against the shared Supabase project.",

  // ---- Open orders (table) ----
  backSalesOrders: "← Sales Orders",
  openOrdersTitle: "Open orders",
  openOrdersLede:
    "Every open Fishbowl SO. History begins Sep 15, 2026 — closed-order rows fill in nightly from that date forward.",
  colSo: "SO #",
  colCustomer2: "Customer",
  colPo: "PO",
  colStatus: "Status",
  colSalesman: "Salesman",
  colIssued: "Issued",
  colScheduledShip: "Scheduled ship",
  colTotal: "Total",
  colItems: "Items",
  colDescription: "Description",
  colOrdered: "Ordered",
  colPicked: "Picked",
  colFulfilled: "Fulfilled",
  colUnitDollar: "Unit $",
  colExtDollar: "Ext $",
  colScheduled: "Scheduled",
  colProductNum: "Product #",
  colQty: "Qty",
  searchOrders: "Search SO #, customer, PO, salesman, or status…",
  includeClosed: "Include closed & estimates",
  printSavePdf: "Print / Save PDF",
  showingAllOrders: "Showing all orders",
  showingOpenOnly: "Open orders",
  rowsWord: "rows",
  rowWord: "row",
  syncedLabel: "Synced",
  loadingSuffix: "loading…",
  syncStale:
    "Last night's Fishbowl sync did not run — this data is {rel}. Check the sync job.",
  noOpenOrdersMatch: "No open orders match those filters.",
  noOrdersMatchWithClosed:
    "No orders match those filters. History begins Sep 15, 2026 — closed-order rows fill in nightly from that date forward.",
  openDetail: "Open detail →",
  noteLabel: "NOTE",
  noSaleItems: "No sale/drop-ship line items.",

  // ---- Session detail ----
  attendeesLabel: "Attendees",
  salesOrdersDiscussed: "Sales orders discussed",
  otherBusiness: "Other business",
  noSoNotesYet: "No SO notes on this session yet.",
  notInFishbowl: "(not in current Fishbowl mirror)",
  nowLabel: "Now:",
  shipLabel: "ship",
  keyPointsLabel: "KEY POINTS",
  fishbowlMemoLabel: "FISHBOWL MEMO",
  mondayActivityLabel: "MONDAY ACTIVITY",
  openInMonday: "Open in Monday →",
  generatedRelative: "Generated {date}",

  // ---- SO detail ----
  backOpenOrders: "← Open orders",
  soPrefix: "SO",
  syncedAgo: "Synced {rel}",
  syncedStaleShort: "last night's sync did not run",
  factStatus: "Status",
  factPo: "PO",
  factSalesman: "Salesman",
  factIssued: "Issued",
  factScheduledShip: "Scheduled ship",
  factTotal: "Total",
  orderNoteLabel: "Order note (Fishbowl)",
  lineItemsTitle: "Line items",
  noLineItemsForSo: "No sale or drop-ship line items on this SO.",
  meetingHistoryTitle: "Meeting history",
  mondayActivityTitle: "Monday activity",
  purchaseOrdersTitle: "Purchase orders",
  poPrefix: "PO",
  poPlacedOn: "Placed {date}",
  colReceived: "Received",
  colEta: "ETA",

  // ---- Orders landing (sales-order status tracker) ----
  ordersEyebrow: "PHARMACENTER · SALES ORDERS",
  ordersTitle: "Sales Order Tracker",
  ordersLede:
    "Every open sales order across Fishbowl, grouped by customer, with the latest meeting mention, Monday chatter, and AI key points at a glance.",
  ordersOpenCount: "open",
  ordersEstimateCount: "estimates",
  ordersCustomerCount: "{n} customers",
  ordersMeetingsLink: "Weekly meeting sessions",
  ordersNoOpen:
    "No open sales orders in Fishbowl right now (statuses Estimate / Issued / In Progress).",
  touchPlaud: "Plaud",
  touchMonday: "Monday",
  touchFishbowl: "Fishbowl",
  warnShipOverdue: "ship date passed",
  warnShipImminent: "ships in {days}d",
  warnCustomerMismatchShort: "customer mismatch",
  warnProductMismatchShort: "product mismatch",
  warnStale: "no touch in {days}d",
  shipPrefix: "Ship",
  shipOverdueLabel: "overdue",
  shipInDaysLabel: "in {days}d",
  // Fishbowl SO/PO status labels — Fishbowl only sends English, we map
  // to Spanish at render time.
  statusEstimate: "Estimate",
  statusIssued: "Issued",
  statusInProgress: "In Progress",
  statusFulfilled: "Fulfilled",
  statusInProcess: "In Process",
  statusUnfulfilled: "Unfulfilled",
  statusPartial: "Partial",
  statusClosedShort: "Closed Short",
  statusVoid: "Void",
  statusCancelled: "Cancelled",
  // Relative time — used by describeFreshness()
  syncNever: "never",
  timeJustNow: "just now",
  timeMinAgo: "{n} min ago",
  timeHrAgo: "{n}h ago",
  timeDayAgo: "{n}d ago",
  noMeetingsForSo:
    "This SO hasn't been discussed in a recorded meeting yet. Once Plaud ingestion is live, weekly mentions will appear here alongside the Fishbowl state at that time.",
  dueLabel: "due",

  // ---- Mismatch warnings — code-emitted, localized in the UI ----
  warnCustomerHint:
    '⚠ Plaud text and Fishbowl customer disagree — likely "{hint}" per Fishbowl. Verify before acting.',
  warnCustomerNoHint:
    "⚠ Plaud text mentions a customer that doesn't match Fishbowl ({customer}). Verify.",
  warnProduct:
    '⚠ Plaud text mentions "{said}" but this SO\'s line items are {has}. Verify.',
  noMatchingProduct: "no matching product on file",

  // ---- Workflow inbox (/workflows) ----
  // Finding I3: the nav was translated but the page under it was not, so on
  // the Spanish setting this screen rendered "Flujos de trabajo" in the nav
  // above an entirely English page. Half-translated reads worse than
  // untranslated.
  workflowsTitle: "Work Flows",
  workflowsLede: "Your drafts and every pushed workflow across the workspace.",
  newWorkflow: "+ New workflow",
  workflowsSearch: "Search quote #, customer, description, type, or submitter…",
  workflowsEmpty: "No workflows yet",
  colQuoteNumber: "Quote #",
  colQuoteType: "Quote type",
  colSubmitter: "Submitter",
  deleteWorkflow: "Delete workflow",
  deleteNamed: "Delete {name}",
  addShortDescription: "Add a short description",
  workflowDescriptionAria: "Workflow description",
  savingEllipsis: "Saving…",
  statusWon: "Won",
  statusLost: "Lost",

  // Quote type / dosage form. Values are stored in English in the DB; these
  // are display labels only.
  quoteTypeBulk: "Bulk",
  quoteTypeContractPackaging: "Contract Packaging",
  quoteTypeFinishedProduct: "Finished Product",
  quoteTypeOther: "Other",
  formSoftgel: "Softgels",
  formGummy: "Gummies",
  formTablet: "Tablets",
  formCapsule: "Capsules",
  formOther: "Other",

  // Packaging types (Contract Packaging). state.form is overloaded: it holds
  // a dosage form for bulk/finished-product quotes and a packaging type for
  // contract-packaging ones. Two id namespaces in one column, disambiguated
  // by state.type -- see DESCRIPTION_PACKAGING_LABELS in lib/workflows.ts.
  packagingBottles: "Bottles",
  packagingBlisters: "Blisters",
  packagingSachets: "Sachets",
  packagingPouches: "Pouches",
  packagingKitting: "Kitting",
  packagingOther: "Other",

  // Relative time, longer buckets. timeJustNow/timeMinAgo/timeHrAgo/
  // timeDayAgo already exist above and are reused.
  timeWeekAgo: "{n}w ago",
  timeMonthAgo: "{n}mo ago",
  timeYearAgo: "{n}y ago",
  // Spanish needs a singular form ("hace 1 mes", not "hace 1 meses"). English
  // reads fine either way, so these are the same string -- kept as separate
  // keys so the es side has somewhere to differ.
  timeMonthAgoOne: "{n}mo ago",
  timeYearAgoOne: "{n}y ago",
  newCustomerPlaceholder: "New customer",
  unknownCustomer: "Unknown customer",
  createYourFirst: "+ Create your first",
  noWorkflowsMatch: 'No workflows match "{q}".',
  confirmDeleteWorkflow:
    "Delete {name}? This cannot be undone. Files in storage will remain.",
  deleteForbidden: "Only the workflow owner or an admin can delete this.",
  deleteFailed: "Delete failed: {reason}",

  // ---- Hub (pharmacenter.app apex) ----
  // Tile titles get their OWN keys rather than reusing the nav keys, because
  // the two are doing different jobs. A nav label is read inside a product,
  // underneath a wordmark that already says which product it is -- "Lists" is
  // unambiguous there. On a directory of five tools, standing alone, it is
  // not. The first version of this page reused navLists and the tile read
  // "Lists"; the fix is a name that works without the wordmark above it.
  //
  // The set is deliberately parallel -- plural, no "Generator"/"Tracker"
  // suffixes -- matching the convention H3 settled on for tab titles.
  hubQuoteName: "Quotes",
  hubListsName: "Packing Lists",
  hubFormulasName: "Formulas",
  hubOrdersName: "Sales Orders",
  hubMeetingsName: "Meetings",
  hubEyebrow: "PharmaCenter · Tools",
  hubTitle: "Your tools",
  hubLede: "Everything we use for work, in one place.",
  hubOpen: "Open",
  hubQuoteDesc: "Build a customer quote and push it to monday.",
  hubListsDesc: "Generate packing lists for outbound shipments.",
  hubFormulasDesc: "Gummy formula catalog, scale-up and costing.",
  hubOrdersDesc: "Open sales orders, synced nightly from Fishbowl.",
  hubMeetingsDesc: "Weekly sales order review — notes and action items.",
  hubSignInLede:
    "One place for the tools we use for work. Sign in with your PharmaCenter Google account to continue.",
  // Roadmap (/roadmap, admin-only, linked from the hub nav).
  navRoadmap: "Roadmap",
  rmEyebrow: "PharmaCenter · Admin",
  rmTitle: "Roadmap",
  rmLede: "Features and tools we want to add. Only admins can see this page.",
  rmStatusIdea: "Ideas",
  rmStatusPlanned: "Planned",
  rmStatusInProgress: "In progress",
  rmStatusShipped: "Shipped",
  rmStatusDropped: "Dropped",
  rmAddHeading: "Add to the roadmap",
  rmFieldTitle: "What should we build?",
  rmFieldDetails: "Details (optional)",
  rmFieldApp: "App",
  rmFieldPriority: "Priority",
  rmFieldStatus: "Status",
  rmPriorityHigh: "High",
  rmPriorityMedium: "Medium",
  rmPriorityLow: "Low",
  rmAppHub: "Hub",
  rmAppSync: "Fishbowl sync",
  rmAppNew: "New tool",
  rmAdd: "Add",
  rmDelete: "Delete",
  rmDeleteConfirm: "Click again to delete",
  rmEmpty: "Nothing here yet.",
  rmShowDropped: "Show dropped ({n})",
  rmHideDropped: "Hide dropped",
  rmAddedOn: "Added {date}",
  rmShippedOn: "Shipped {date}",
  rmSaveError: "Couldn't save: {msg}",
  rmLoadError: "Couldn't load the roadmap: {msg}",
};

const es: typeof en = {
  // ---- Header / nav ----
  navWorkflows: "Flujos de trabajo",
  navFormulas: "Fórmulas",
  navLists: "Listas",
  navFeedback: "Comentarios",
  navAdmin: "Admin",

  // ---- Formulas catalog ----
  catalogTitle: "Catálogo de Fórmulas de Gomitas",
  catalogLede:
    "Cada diseño de gomita creado por PharmaCenter, indexado por código PC-BK (o marcado TBD hasta que I+D asigne uno). Abra una fórmula para ver o editar su receta de mesa, escalado y costo de materiales.",
  catalogSearch: "Buscar cliente, código, nombre, sabor o preparador…",
  allShapes: "Todas las formas",
  newFormula: "+ Nueva fórmula",
  colFormula: "Fórmula",
  colProductCode: "Código de producto",
  colName: "Nombre",
  colCustomer: "Cliente",
  colShape: "Forma",
  colFlavor: "Sabor",
  colVersion: "Versión",
  colUpdated: "Actualizada",
  colActions: "Acciones",
  deleteAction: "Eliminar",
  perPage: "Por página:",
  previous: "← Anterior",
  next: "Siguiente →",
  pageXofY: "Página {x} de {y}",
  backToFormulas: "← Volver a fórmulas",
  backToWorkflows: "← Volver a flujos",

  // ---- Editor chrome ----
  printPdf: "Imprimir / PDF",
  saved: "Guardado",
  tabBenchTop: "Mesa de trabajo",
  tabScaleUp: "Escalado",
  tabMaterialCosting: "Costo de materiales",
  addIngredient: "+ Agregar ingrediente",
  addSolution: "+ Agregar solución",
  change: "Cambiar",

  // ---- Meetings hub ----
  navMeetings: "Reuniones",
  navOrders: "Órdenes de venta",
  meetingsBreadcrumb: "PharmaCenter · Reuniones",
  meetingsTitle: "Reuniones",
  meetingsHubLede:
    "Centro para las reuniones recurrentes de PharmaCenter. Elija un tipo de reunión para ver sus sesiones semanales y el estado de Fishbowl cruzado.",
  meetingsNoTypes:
    "Aún no hay tipos de reunión configurados. Agregue uno a public.meeting_types para verlo aquí.",
  meetingsSessionsCount: "sesiones",
  meetingsSessionCountOne: "sesión",
  meetingsLastHeld: "Última {date}",
  meetingsNoSessionsYet: "Sin sesiones aún",

  // ---- Sales-orders landing ----
  backMeetings: "← Reuniones",
  salesOrdersBreadcrumb: "PharmaCenter · Reuniones · Órdenes de venta",
  salesOrdersTitle: "Órdenes de venta",
  salesOrdersLede:
    "Revisión semanal de órdenes de venta abiertas en Fishbowl.",
  workingDocument: "DOCUMENTO DE TRABAJO",
  cardOpenOrders: "Órdenes abiertas",
  cardOpenOrdersBody:
    "Todas las SO abiertas en Fishbowl ahora mismo — búsqueda, ordenamiento, expandir para ver ítems de línea. Este es el documento que se usa en la reunión.",
  cardComingWithPlaud: "PRÓXIMAMENTE CON PLAUD",
  cardWeeklySessions: "Sesiones semanales",
  cardWeeklySessionsBody:
    "Cada grabación de Plaud se convierte en una sesión abajo. Las notas se extraen por SO y se cruzan con el estado actual de Fishbowl.",
  sessionHistory: "Historial de sesiones",
  noSessionsPlaud:
    "Aún no hay sesiones. Cuando Plaud esté conectado, cada grabación semanal aparecerá aquí automáticamente.",
  soCountPlural: "SO",
  soCountSingle: "SO",
  plaudRecording: "Grabación de Plaud",
  manualEntry: "Entrada manual",
  seedNeeded:
    "El tipo de reunión sales-orders aún no está sembrado. Ejecute sql/meetings.sql en el proyecto Supabase compartido.",

  // ---- Open orders (table) ----
  backSalesOrders: "← Órdenes de venta",
  openOrdersTitle: "Órdenes abiertas",
  openOrdersLede:
    "Todas las SO abiertas en Fishbowl. El historial comienza el 15 de sep de 2026 — las filas de órdenes cerradas se llenan cada noche a partir de esa fecha.",
  colSo: "SO #",
  colCustomer2: "Cliente",
  colPo: "PO",
  colStatus: "Estado",
  colSalesman: "Vendedor",
  colIssued: "Emitida",
  colScheduledShip: "Envío programado",
  colTotal: "Total",
  colItems: "Ítems",
  colDescription: "Descripción",
  colOrdered: "Pedido",
  colPicked: "Recogido",
  colFulfilled: "Cumplido",
  colUnitDollar: "$ Unitario",
  colExtDollar: "$ Ext",
  colScheduled: "Programado",
  colProductNum: "Producto #",
  colQty: "Cant",
  searchOrders: "Buscar SO #, cliente, PO, vendedor o estado…",
  includeClosed: "Incluir cerradas y estimados",
  printSavePdf: "Imprimir / Guardar PDF",
  showingAllOrders: "Mostrando todas las órdenes",
  showingOpenOnly: "Órdenes abiertas",
  rowsWord: "filas",
  rowWord: "fila",
  syncedLabel: "Sincronizado",
  loadingSuffix: "cargando…",
  syncStale:
    "La sincronización nocturna de Fishbowl no se ejecutó — estos datos son de hace {rel}. Revise el proceso.",
  noOpenOrdersMatch: "Ninguna orden abierta coincide con esos filtros.",
  noOrdersMatchWithClosed:
    "Ninguna orden coincide con esos filtros. El historial comienza el 15 de sep de 2026 — las filas de órdenes cerradas se llenan cada noche a partir de esa fecha.",
  openDetail: "Abrir detalle →",
  noteLabel: "NOTA",
  noSaleItems: "Sin ítems de venta o drop-ship.",

  // ---- Session detail ----
  attendeesLabel: "Participantes",
  salesOrdersDiscussed: "Órdenes de venta discutidas",
  otherBusiness: "Otros temas",
  noSoNotesYet: "Aún no hay notas de SO en esta sesión.",
  notInFishbowl: "(no está en el espejo actual de Fishbowl)",
  nowLabel: "Ahora:",
  shipLabel: "envío",
  keyPointsLabel: "PUNTOS CLAVE",
  fishbowlMemoLabel: "MEMO DE FISHBOWL",
  mondayActivityLabel: "ACTIVIDAD DE MONDAY",
  openInMonday: "Abrir en Monday →",
  generatedRelative: "Generado {date}",

  // ---- SO detail ----
  backOpenOrders: "← Órdenes abiertas",
  soPrefix: "SO",
  syncedAgo: "Sincronizado {rel}",
  syncedStaleShort: "la sincronización nocturna no se ejecutó",
  factStatus: "Estado",
  factPo: "PO",
  factSalesman: "Vendedor",
  factIssued: "Emitida",
  factScheduledShip: "Envío programado",
  factTotal: "Total",
  orderNoteLabel: "Nota de la orden (Fishbowl)",
  lineItemsTitle: "Ítems de línea",
  noLineItemsForSo: "Esta SO no tiene ítems de venta o drop-ship.",
  meetingHistoryTitle: "Historial de reuniones",
  mondayActivityTitle: "Actividad de Monday",
  purchaseOrdersTitle: "Órdenes de compra",
  poPrefix: "PO",
  poPlacedOn: "Colocada {date}",
  colReceived: "Recibida",
  colEta: "ETA",

  // ---- Landing de órdenes ----
  ordersEyebrow: "PHARMACENTER · ÓRDENES DE VENTA",
  ordersTitle: "Rastreador de órdenes de venta",
  ordersLede:
    "Todas las órdenes de venta abiertas en Fishbowl, agrupadas por cliente, con la mención más reciente de reunión, chatter de Monday y puntos clave de IA a la vista.",
  ordersOpenCount: "abiertas",
  ordersEstimateCount: "estimaciones",
  ordersCustomerCount: "{n} clientes",
  ordersMeetingsLink: "Sesiones semanales de reunión",
  ordersNoOpen:
    "No hay órdenes de venta abiertas en Fishbowl ahora mismo (estados Estimación / Emitida / En Progreso).",
  touchPlaud: "Plaud",
  touchMonday: "Monday",
  touchFishbowl: "Fishbowl",
  warnShipOverdue: "fecha de envío vencida",
  warnShipImminent: "envía en {days}d",
  warnCustomerMismatchShort: "cliente no coincide",
  warnProductMismatchShort: "producto no coincide",
  warnStale: "sin actividad en {days}d",
  shipPrefix: "Envío",
  shipOverdueLabel: "vencido",
  shipInDaysLabel: "en {days}d",
  // Status labels — English source strings from Fishbowl, mapped here.
  statusEstimate: "Estimación",
  statusIssued: "Emitida",
  statusInProgress: "En Progreso",
  statusFulfilled: "Cumplida",
  statusInProcess: "En Proceso",
  statusUnfulfilled: "Sin Cumplir",
  statusPartial: "Parcial",
  statusClosedShort: "Cerrada Corta",
  statusVoid: "Anulada",
  statusCancelled: "Cancelada",
  // Relative time
  syncNever: "nunca",
  timeJustNow: "ahora mismo",
  timeMinAgo: "hace {n} min",
  timeHrAgo: "hace {n}h",
  timeDayAgo: "hace {n}d",
  noMeetingsForSo:
    "Esta SO aún no se ha discutido en una reunión grabada. Cuando Plaud esté conectado, las menciones semanales aparecerán aquí junto con el estado de Fishbowl de ese momento.",
  dueLabel: "vence",

  // ---- Mismatch warnings ----
  warnCustomerHint:
    '⚠ El texto de Plaud y el cliente en Fishbowl no coinciden — probablemente "{hint}" según Fishbowl. Verifique antes de actuar.',
  warnCustomerNoHint:
    "⚠ El texto de Plaud menciona un cliente que no coincide con Fishbowl ({customer}). Verifique.",
  warnProduct:
    '⚠ El texto de Plaud menciona "{said}" pero los ítems de línea de esta SO son {has}. Verifique.',
  noMatchingProduct: "sin producto coincidente en el sistema",

  // ---- Bandeja de flujos de trabajo (/workflows) ----
  workflowsTitle: "Flujos de trabajo",
  workflowsLede:
    "Sus borradores y todos los flujos de trabajo publicados en el espacio de trabajo.",
  newWorkflow: "+ Nuevo flujo de trabajo",
  workflowsSearch:
    "Buscar por n.º de cotización, cliente, descripción, tipo o solicitante…",
  workflowsEmpty: "Aún no hay flujos de trabajo",
  colQuoteNumber: "N.º de cotización",
  colQuoteType: "Tipo de cotización",
  colSubmitter: "Solicitante",
  deleteWorkflow: "Eliminar flujo de trabajo",
  deleteNamed: "Eliminar {name}",
  addShortDescription: "Agregue una descripción breve",
  workflowDescriptionAria: "Descripción del flujo de trabajo",
  savingEllipsis: "Guardando…",
  statusWon: "Ganada",
  statusLost: "Perdida",

  // Tipo de cotización / forma farmacéutica.
  quoteTypeBulk: "Granel",
  quoteTypeContractPackaging: "Empaque por contrato",
  quoteTypeFinishedProduct: "Producto terminado",
  quoteTypeOther: "Otro",
  formSoftgel: "Cápsulas blandas",
  formGummy: "Gomitas",
  formTablet: "Tabletas",
  formCapsule: "Cápsulas",
  formOther: "Otro",

  // Tipos de empaque (Empaque por contrato).
  packagingBottles: "Botellas",
  packagingBlisters: "Blísteres",
  packagingSachets: "Sobres",
  packagingPouches: "Bolsas",
  packagingKitting: "Kits",
  packagingOther: "Otro",

  // Tiempo relativo, rangos largos.
  timeWeekAgo: "hace {n} sem",
  timeMonthAgo: "hace {n} meses",
  timeYearAgo: "hace {n} años",
  timeMonthAgoOne: "hace {n} mes",
  timeYearAgoOne: "hace {n} año",
  newCustomerPlaceholder: "Cliente nuevo",
  unknownCustomer: "Cliente desconocido",
  createYourFirst: "+ Cree el primero",
  noWorkflowsMatch: 'Ningún flujo de trabajo coincide con "{q}".',
  confirmDeleteWorkflow:
    "¿Eliminar {name}? Esta acción no se puede deshacer. Los archivos almacenados se conservarán.",
  deleteForbidden:
    "Solo el propietario del flujo de trabajo o un administrador puede eliminarlo.",
  deleteFailed: "No se pudo eliminar: {reason}",

  // ---- Hub (apex pharmacenter.app) ----
  hubQuoteName: "Cotizaciones",
  hubListsName: "Listas de empaque",
  hubFormulasName: "Fórmulas",
  hubOrdersName: "Órdenes de venta",
  hubMeetingsName: "Reuniones",
  hubEyebrow: "PharmaCenter · Herramientas",
  hubTitle: "Sus herramientas",
  hubLede: "Todo lo que usamos para trabajar, en un solo lugar.",
  hubOpen: "Abrir",
  hubQuoteDesc: "Cree una cotización y envíela a monday.",
  hubListsDesc: "Genere listas de empaque para los envíos.",
  hubFormulasDesc: "Catálogo de fórmulas de gomitas, escalado y costeo.",
  hubOrdersDesc: "Pedidos abiertos, sincronizados cada noche desde Fishbowl.",
  hubMeetingsDesc: "Revisión semanal de pedidos — notas y tareas.",
  hubSignInLede:
    "Un solo lugar para las herramientas que usamos para trabajar. Inicie sesión con su cuenta de Google de PharmaCenter para continuar.",
  // Hoja de ruta (/roadmap, solo administradores).
  navRoadmap: "Hoja de ruta",
  rmEyebrow: "PharmaCenter · Admin",
  rmTitle: "Hoja de ruta",
  rmLede: "Funciones y herramientas que queremos agregar. Solo los administradores pueden ver esta página.",
  rmStatusIdea: "Ideas",
  rmStatusPlanned: "Planificado",
  rmStatusInProgress: "En curso",
  rmStatusShipped: "Lanzado",
  rmStatusDropped: "Descartado",
  rmAddHeading: "Agregar a la hoja de ruta",
  rmFieldTitle: "¿Qué deberíamos construir?",
  rmFieldDetails: "Detalles (opcional)",
  rmFieldApp: "Aplicación",
  rmFieldPriority: "Prioridad",
  rmFieldStatus: "Estado",
  rmPriorityHigh: "Alta",
  rmPriorityMedium: "Media",
  rmPriorityLow: "Baja",
  rmAppHub: "Portal",
  rmAppSync: "Sincronización con Fishbowl",
  rmAppNew: "Herramienta nueva",
  rmAdd: "Agregar",
  rmDelete: "Eliminar",
  rmDeleteConfirm: "Haga clic otra vez para eliminar",
  rmEmpty: "Nada aquí todavía.",
  rmShowDropped: "Mostrar descartados ({n})",
  rmHideDropped: "Ocultar descartados",
  rmAddedOn: "Agregado {date}",
  rmShippedOn: "Lanzado {date}",
  rmSaveError: "No se pudo guardar: {msg}",
  rmLoadError: "No se pudo cargar la hoja de ruta: {msg}",
};

export type DictKey = keyof typeof en;

export function makeT(lang: Lang) {
  const dict = lang === "es" ? es : en;
  return (key: DictKey, vars?: Record<string, string | number>): string => {
    let out: string = dict[key] ?? en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        out = out.replace(`{${k}}`, String(v));
      }
    }
    return out;
  };
}
