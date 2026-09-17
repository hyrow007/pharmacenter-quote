#!/usr/bin/env node
/**
 * Fishbowl → PharmaCenter packing-list sync (sender side).
 *
 * Designed to run on the office Fishbowl server immediately after the
 * nightly mysqldump completes (~04:00). Reads the latest backup file
 * from D:\fb-backup\, parses just the tables we care about, and POSTs
 * the data to the /api/sync/* endpoints on packing.pharmacenter.app.
 *
 * Zero npm dependencies — Node 18+ standard library only.
 *
 * --- Configuration (env vars) ---
 * FISHBOWL_SYNC_SECRET  (required)  bearer token, must match Vercel
 * FB_BACKUP_DIR         default: D:\fb-backup
 * SYNC_API_BASE         default: https://packing.pharmacenter.app
 * QUOTE_API_BASE        default: https://quote.pharmacenter.app   (NEW — raw materials only)
 * FB_SYNC_LOG_DIR       default: D:\fb-backup\sync-logs
 * FB_DRY_RUN            if "1", parses but does not POST
 *
 * --- Usage ---
 *   node scripts/fishbowl-sync.mjs
 *
 * For scheduling, see Run-FishbowlSync.ps1 in the same folder.
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import readline from "node:readline";
import { URL } from "node:url";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const BACKUP_DIR = process.env.FB_BACKUP_DIR || "D:\\fb-backup";
const API_BASE = process.env.SYNC_API_BASE || "https://packing.pharmacenter.app";
// Quote app lives on its own domain; only raw materials are pushed there
// for now (customers/products/vendors still go to the packing-list app).
const QUOTE_API_BASE = process.env.QUOTE_API_BASE || "https://quote.pharmacenter.app";
const SYNC_SECRET = process.env.FISHBOWL_SYNC_SECRET || "";
const LOG_DIR = process.env.FB_SYNC_LOG_DIR || path.join(BACKUP_DIR, "sync-logs");
const DRY_RUN = process.env.FB_DRY_RUN === "1";
const BATCH_SIZE = 500;

if (!SYNC_SECRET && !DRY_RUN) {
  console.error("FISHBOWL_SYNC_SECRET is required (set FB_DRY_RUN=1 to skip)");
  process.exit(1);
}

// ----------------------------------------------------------------------------
// Logging
// ----------------------------------------------------------------------------
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = path.join(LOG_DIR, `sync-${stamp}.log`);
const logStream = fs.createWriteStream(logPath, { flags: "a" });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ----------------------------------------------------------------------------
// Find latest backup
// ----------------------------------------------------------------------------
function findLatestBackup() {
  const entries = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^Pharmacenter_.+\.sql$/i.test(f))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) {
    throw new Error(`No Pharmacenter_*.sql files in ${BACKUP_DIR}`);
  }
  return entries[0].full;
}

// ----------------------------------------------------------------------------
// MySQL-dump tuple parser
// ----------------------------------------------------------------------------
function parseTuple(text, start) {
  if (text[start] !== "(") throw new Error("expected ( at " + start);
  const out = [];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ")") return { values: out, end: i + 1 };
    if (ch === "," || ch === " ") { i++; continue; }

    if (text.startsWith("_binary", i)) {
      i += "_binary".length;
      while (i < text.length && text[i] === " ") i++;
      const s = parseString(text, i);
      const bit = s.value.length > 0 && s.value.charCodeAt(0) === 1;
      out.push(bit);
      i = s.end;
      continue;
    }

    if (ch === "'") {
      const s = parseString(text, i);
      out.push(s.value);
      i = s.end;
      continue;
    }

    if (text.startsWith("NULL", i)
        && !/[A-Za-z0-9_]/.test(text[i + 4] || "")) {
      out.push(null);
      i += 4;
      continue;
    }

    let tok = "";
    while (i < text.length && text[i] !== "," && text[i] !== ")") {
      tok += text[i++];
    }
    tok = tok.trim();
    const num = Number(tok);
    out.push(Number.isFinite(num) && tok !== "" ? num : tok);
  }
  throw new Error("unterminated tuple from " + start);
}

function parseString(text, start) {
  if (text[start] !== "'") throw new Error("expected ' at " + start);
  let s = "";
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      const n = text[i + 1];
      const map = {
        "0": "\0", "b": "\b", "n": "\n", "r": "\r", "t": "\t",
        "Z": "\x1a", "\\": "\\", "'": "'", '"': '"',
      };
      s += Object.prototype.hasOwnProperty.call(map, n) ? map[n] : n;
      i += 2;
    } else if (c === "'") {
      if (text[i + 1] === "'") { s += "'"; i += 2; }
      else return { value: s, end: i + 1 };
    } else {
      s += c;
      i++;
    }
  }
  throw new Error("unterminated string from " + start);
}

function parseAllTuples(valuesText) {
  const tuples = [];
  let i = 0;
  const n = valuesText.length;
  while (i < n) {
    while (i < n && valuesText[i] !== "(") i++;
    if (i >= n) break;
    const r = parseTuple(valuesText, i);
    tuples.push(r.values);
    i = r.end;
  }
  return tuples;
}

// ----------------------------------------------------------------------------
// Auto-discover column order from CREATE TABLE blocks in the dump.
//
// MySQL-style dumps lay each CREATE TABLE out as:
//
//   CREATE TABLE `vendor` (
//     `id` int(11) NOT NULL AUTO_INCREMENT,
//     `accountId` int(11) DEFAULT NULL,
//     ...
//     PRIMARY KEY (`id`),
//     KEY `vendor_x` (`accountId`),
//     CONSTRAINT `fk_x` FOREIGN KEY ...
//   ) ENGINE=InnoDB ...
//
// We capture every backticked identifier on its own line until we hit a key
// directive (PRIMARY KEY / UNIQUE KEY / KEY / CONSTRAINT) or the closing `)`.
// Single pass over the dump — we batch all wanted tables into one scan.
//
// Returns a Map<tableName, string[]>. Tables we never found map to undefined,
// which lets the caller fall back to the hardcoded order.
// ----------------------------------------------------------------------------
async function discoverColumnOrders(dumpPath, tableNames) {
  const wanted = new Set(tableNames);
  const out = new Map();

  const stream = fs.createReadStream(dumpPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let active = null;        // current table being captured
  let activeCols = null;

  for await (const rawLine of rl) {
    const line = rawLine.trimEnd();

    if (!active) {
      const m = line.match(/^CREATE TABLE `([^`]+)` \(\s*$/);
      if (m && wanted.has(m[1])) {
        active = m[1];
        activeCols = [];
      }
      continue;
    }

    // Inside a CREATE TABLE block. End markers: `) ENGINE...` or `);`.
    if (/^\) ?ENGINE/i.test(line.trim()) || line.trim() === ");") {
      out.set(active, activeCols);
      wanted.delete(active);
      active = null;
      activeCols = null;
      if (wanted.size === 0) break;
      continue;
    }

    // Skip key/constraint lines.
    const trimmed = line.trim();
    if (/^(PRIMARY KEY|UNIQUE KEY|KEY|CONSTRAINT|FULLTEXT KEY|SPATIAL KEY)\b/i.test(trimmed)) {
      continue;
    }

    // Column line: starts with `name` followed by a type.
    const cm = trimmed.match(/^`([^`]+)`\s+\S/);
    if (cm) activeCols.push(cm[1]);
  }

  // If we ran off the end mid-capture (shouldn't happen with a well-formed
  // dump), publish what we've got rather than dropping it on the floor.
  if (active && activeCols && activeCols.length > 0) {
    out.set(active, activeCols);
  }

  return out;
}

async function extractTables(dumpPath, tableSpec) {
  const markers = {};
  for (const [name, cols] of Object.entries(tableSpec)) {
    markers[name] = { prefix: `INSERT INTO \`${name}\` `, cols, rows: [] };
  }

  const stream = fs.createReadStream(dumpPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let totalLines = 0;
  let totalInsertLines = 0;
  const sampleTableNames = new Set();
  for await (const line of rl) {
    totalLines++;
    if (!line.startsWith("INSERT INTO `")) continue;
    totalInsertLines++;
    const tnMatch = line.match(/^INSERT INTO `([^`]+)`/);
    if (tnMatch && sampleTableNames.size < 30) sampleTableNames.add(tnMatch[1]);
    for (const spec of Object.values(markers)) {
      if (!line.startsWith(spec.prefix)) continue;
      const vIdx = line.indexOf(" VALUES (", spec.prefix.length - 1);
      if (vIdx === -1) break;
      const valuesStart = vIdx + " VALUES ".length;
      const valuesText = line.endsWith(";")
        ? line.slice(valuesStart, -1)
        : line.slice(valuesStart);
      const tuples = parseAllTuples(valuesText);
      for (const t of tuples) {
        const obj = {};
        for (let i = 0; i < spec.cols.length; i++) {
          obj[spec.cols[i]] = t[i];
        }
        spec.rows.push(obj);
      }
      break;
    }
  }
  log(`  scanned ${totalLines} lines, ${totalInsertLines} INSERT lines`);
  log(`  first ~30 table names seen: ${[...sampleTableNames].join(", ")}`);
  const out = {};
  for (const [name, spec] of Object.entries(markers)) out[name] = spec.rows;
  return out;
}

// ----------------------------------------------------------------------------
// Column orders — order MUST match the CREATE TABLE column order from the dump.
// ----------------------------------------------------------------------------
const COLS_CUSTOMER = [
  "id", "accountId", "accountingHash", "accountingId", "activeFlag",
  "carrierServiceId", "creditLimit", "currencyId", "currencyRate",
  "dateCreated", "dateLastModified", "defaultCarrierId",
  "defaultPaymentTermsId", "defaultSalesmanId", "defaultShipTermsId",
  "jobDepth", "lastChangedUser", "name", "note", "number", "parentId",
  "qbClassId", "statusId", "sysUserId", "taxExempt", "taxExemptNumber",
  "taxRateId", "toBeEmailed", "toBePrinted", "url", "issuableStatusId",
  "defaultPriorityId", "customFields",
];

const COLS_ADDRESS = [
  "id", "accountId", "name", "city", "countryId", "defaultFlag",
  "locationGroupId", "addressName", "residentialFlag", "stateId",
  "address", "typeID", "zip",
];

const COLS_PRODUCT = [
  "id", "accountingHash", "accountingId", "activeFlag", "alertNote",
  "cartonCount", "defaultCartonTypeId", "dateCreated", "dateLastModified",
  "defaultSoItemType", "description", "details", "displayTypeId", "height",
  "incomeAccountId", "kitFlag", "kitGroupedFlag", "len", "num", "partId",
  "price", "qbClassId", "sellableInOtherUoms", "showSoComboFlag",
  "sizeUomId", "sku", "taxId", "taxableFlag", "uomId", "upc", "url",
  "usePriceFlag", "weight", "weightUomId", "width", "customFields",
];

const COLS_STATECONST = ["id", "code", "countryConstID", "name"];

// ---------------------------------------------------------------------------
// PART table — raw materials live here (vs the `product` table). Anything
// whose `num` contains "-RW-" is treated as a raw material for the gummy
// formula calculator on the Quote app.
//
// Column order below is only a FALLBACK. discoverColumnOrders() reads the
// real order from the dump's CREATE TABLE block at runtime, which means we
// survive Fishbowl version drift without code changes.
// ---------------------------------------------------------------------------
const COLS_PART = [
  "id", "abcCode", "accountingHash", "accountingId", "activeFlag",
  "adjustmentAccountId", "alertNote", "alwaysManufacture", "cogsAccountId",
  "consumptionRate", "configurable", "customFields", "cycleCount",
  "dateCreated", "dateLastModified", "description", "details", "height",
  "inventoryAccountId", "lastChangedUser", "leadTime", "len",
  "num", "partClassId", "pickInOrder", "pickInOrderCriteria",
  "primaryTrackingId", "productId", "receivingTolerance", "revision",
  "scrapAccountId", "serializedFlag", "sizeUomId", "stdCost", "supplierId",
  "taxId", "taxableFlag", "trackingFlag", "typeId", "uomId", "upc", "url",
  "vendorPartNum", "vendorPartNumDescription", "weight", "weightUomId",
  "width",
];

// `partcost` is the per-quantity average-cost ledger Fishbowl writes
// whenever inventory transactions land. We pull the most recent row per
// partId so the Quote app gets a sensible default_cost_per_kg without
// having to chase POs.
//
// Same fallback story as COLS_PART — real order comes from runtime
// CREATE TABLE discovery. Only avgCost + partId + dateLastModified are
// consumed downstream.
const COLS_PARTCOST = [
  "id", "avgCost", "dateCreated", "dateLastModified", "partId", "qty",
];

// `uom` table — maps uomId numeric → human code like "kg", "lb", "ea", "L".
// The downstream raw_materials.default_unit column wants a short string so
// we just push the code; if our dump only has names like "Kilogram" we'll
// pass that through and the admin UI will let you re-label.
const COLS_UOM = ["id", "abbreviation", "code", "name", "activeFlag"];

// `so` / `soitem` — open sales orders for the Quote app's sales_orders
// table (documents-update workflows read them from there instead of
// touching this server). Fallback order only; real order comes from the
// dump's CREATE TABLE block at runtime, same as every other table here.
// Consumption is BY NAME, so only the field names below must exist.
const COLS_SO = [
  "id", "billToAddress", "billToCity", "billToCountryId", "billToName",
  "billToStateId", "billToZip", "carrierId", "carrierServiceId", "cost",
  "currencyId", "currencyRate", "customerContact", "customerId",
  "customerPO", "dateCompleted", "dateCreated", "dateExpired",
  "dateFirstShip", "dateIssued", "dateLastModified", "dateRevision",
  "email", "estimatedTax", "locationGroupId", "mcTotalTax", "note", "num",
  "paymentTermsId", "phone", "priorityId", "qbClassId", "registerId",
  "residentialFlag", "revisionNum", "salesman", "salesmanId",
  "salesmanInitials", "shipTermsId", "shipToAddress", "shipToCity",
  "shipToCountryId", "shipToName", "shipToStateId", "shipToZip",
  "statusId", "taxRate", "taxRateId", "taxRateName", "toBeEmailed",
  "toBePrinted", "totalIncludesTax", "totalTax", "subTotal", "totalPrice",
  "typeId", "url", "username", "vendorPO", "customFields",
];

const COLS_SOITEM = [
  "id", "adjustAmount", "adjustPercentage", "customerPartNum",
  "dateLastFulfillment", "dateLastModified", "dateScheduledFulfillment",
  "description", "exchangeSOLineItem", "itemAdjustId", "markupCost",
  "mcTotalPrice", "note", "productId", "productNum", "qbClassId",
  "qtyFulfilled", "qtyOrdered", "qtyPicked", "qtyToFulfill", "revLevel",
  "showItemFlag", "soId", "soLineItem", "statusId", "taxId", "taxRate",
  "totalCost", "totalPrice", "typeId", "unitPrice", "uomId",
  "customFields",
];

// Fishbowl SO status ids → names. Open = Issued + In Progress; Estimates
// ride along (flagged is_open=false) so a docs workflow can see what is
// about to become an order.
const SO_STATUS_NAMES = {
  10: "Estimate", 20: "Issued", 25: "In Progress", 60: "Fulfilled",
  70: "Closed Short", 80: "Void", 85: "Cancelled", 90: "Expired",
  95: "Historical",
};
const SO_SYNCED_STATUSES = [10, 20, 25];
const SO_OPEN_STATUSES = [20, 25];

// `po` / `poitem` / `vendor` — open purchase orders for the meetings hub's
// PO section (shows, for any SO, every PO placed against it — vendor,
// date, items, quantities). Fallback order only; real order comes from the
// dump's CREATE TABLE block at runtime.
const COLS_PO = [
  "id", "buyer", "carrierId", "carrierServiceId", "cost", "costIncludesTax",
  "createdByUserId", "currencyId", "currencyRate", "customFields",
  "customerId", "dateCompleted", "dateCreated", "dateFirstShip",
  "dateIssued", "dateLastModified", "deliverToAddress", "deliverToCity",
  "deliverToCountryId", "deliverToName", "deliverToStateId", "deliverToZip",
  "fobPointId", "locationGroupId", "mcTotalTax", "note", "num",
  "paymentTermsId", "phone", "priorityId", "purchaseTax", "purchaseTaxId",
  "purchaseTaxName", "purchaseTaxRate", "qbClassId", "remitToAddress",
  "remitToCity", "remitToCountryId", "remitToName", "remitToStateId",
  "remitToZip", "revisionNum", "salesTax", "salesTaxId", "salesTaxName",
  "salesTaxRate", "shipTermsId", "statusId", "subTotal", "toBeEmailed",
  "toBePrinted", "totalIncludesTax", "totalPrice", "totalTax", "typeId",
  "url", "username", "vendorContact", "vendorId", "vendorSO",
];

const COLS_POITEM = [
  "id", "adjustAmount", "adjustPercentage", "customerId", "customFields",
  "dateLastFulfillment", "dateLastModified", "dateScheduledFulfillment",
  "description", "itemAdjustId", "markupCost", "note", "poId",
  "poLineItem", "productId", "productNum", "qbClassId", "qtyFulfilled",
  "qtyOrdered", "qtyPicked", "qtyToFulfill", "revLevel", "showItemFlag",
  "soItemId", "statusId", "taxId", "taxRate", "totalCost",
  "totalPrice", "typeId", "unitCost", "uomId", "vendorPartNum",
];

const COLS_VENDOR = [
  "id", "accountId", "activeFlag", "addressId", "billToAddress",
  "billToCity", "billToCountryId", "billToName", "billToStateId",
  "billToZip", "carrierId", "carrierServiceId", "creditLimit",
  "currencyId", "currencyRate", "dateCreated", "dateLastModified",
  "defaultCarrierId", "defaultShipTerms", "email", "fobPointId",
  "leadTime", "minOrderAmount", "name", "note", "num", "paymentTermsId",
  "phone", "shipTermsId", "statusId", "sysUserId", "taxId", "taxRate",
  "toBeEmailed", "toBePrinted", "url", "vendorGroupId",
];

// Fishbowl PO status ids → names. Open = Issued + Partial; Estimates
// ride along flagged is_open=false for context.
const PO_STATUS_NAMES = {
  10: "Estimate", 20: "Issued", 25: "Partial", 60: "Fulfilled",
  70: "Closed Short", 80: "Void", 85: "Cancelled", 90: "Expired",
  95: "Historical",
};
const PO_SYNCED_STATUSES = [10, 20, 25];
const PO_OPEN_STATUSES = [20, 25];

// ----------------------------------------------------------------------------
// Compose a ship-to BLOCK from a Fishbowl customer + their default address.
// ----------------------------------------------------------------------------
function composeShipTo(customerName, addr, statesById) {
  const lines = [];
  if (customerName) lines.push(customerName);
  if (addr) {
    if (addr.address) lines.push(addr.address);
    const stateCode = addr.stateId ? statesById.get(addr.stateId) : "";
    const cityState = [addr.city, stateCode].filter(Boolean).join(" ");
    const cityStateZip = [cityState, addr.zip].filter(Boolean).join(" ").trim();
    if (cityStateZip) lines.push(cityStateZip);
  }
  return lines.join("\n").trim() || null;
}

// ----------------------------------------------------------------------------
// HTTP poster
// ----------------------------------------------------------------------------
function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Authorization": `Bearer ${SYNC_SECRET}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { resolve({ raw: data }); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function postBatched(baseUrl, endpoint, key, rows) {
  if (DRY_RUN) {
    log(`[DRY_RUN] would POST ${rows.length} ${key} to ${baseUrl}${endpoint} in batches of ${BATCH_SIZE}`);
    return { received: rows.length, upserted: rows.length };
  }
  let totalReceived = 0;
  let totalUpserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const url = `${baseUrl}${endpoint}`;
    const result = await postJson(url, { [key]: batch });
    totalReceived += result.received || 0;
    totalUpserted += result.upserted || 0;
    log(`  batch ${i / BATCH_SIZE + 1}: received=${result.received} upserted=${result.upserted}`);
  }
  return { received: totalReceived, upserted: totalUpserted };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  log(`Fishbowl sync starting. dry_run=${DRY_RUN}`);
  const backupPath = findLatestBackup();
  log(`Latest backup: ${backupPath}`);

  // Hardcoded column orders — used as fallback when CREATE TABLE discovery
  // can't find a block (e.g. dump format changes). Discovery is preferred
  // because it survives Fishbowl version drift; we just trim them to the
  // CREATE block we actually saw, so the parser pulls the right fields.
  const fallbackCols = {
    stateconst: COLS_STATECONST,
    address: COLS_ADDRESS,
    customer: COLS_CUSTOMER,
    product: COLS_PRODUCT,
    part: COLS_PART,
    partcost: COLS_PARTCOST,
    uom: COLS_UOM,
    so: COLS_SO,
    soitem: COLS_SOITEM,
    po: COLS_PO,
    poitem: COLS_POITEM,
    vendor: COLS_VENDOR,
  };

  log("Discovering column orders from CREATE TABLE blocks...");
  const discovered = await discoverColumnOrders(
    backupPath,
    Object.keys(fallbackCols),
  );
  const resolvedCols = {};
  for (const [name, fallback] of Object.entries(fallbackCols)) {
    const found = discovered.get(name);
    if (found && found.length > 0) {
      log(`  ${name} cols (${found.length}, discovered): ${found.join(",")}`);
      resolvedCols[name] = found;
    } else {
      log(`  ${name} cols (${fallback.length}, FALLBACK — discovery missed)`);
      resolvedCols[name] = fallback;
    }
  }

  log("Streaming dump and parsing tables (one pass)...");
  const parsed = await extractTables(backupPath, resolvedCols);
  const stateRows = parsed.stateconst;
  const addressRows = parsed.address;
  const customerRows = parsed.customer;
  const productRows = parsed.product;
  const partRows = parsed.part;
  const partCostRows = parsed.partcost;
  const uomRows = parsed.uom;
  log(`  ${stateRows.length} states, ${addressRows.length} addresses, ${customerRows.length} customers, ${productRows.length} products`);
  log(`  ${partRows.length} parts, ${partCostRows.length} partcost rows, ${uomRows.length} uoms`);

  const statesById = new Map();
  for (const r of stateRows) statesById.set(r.id, r.code);

  const addressByAccountId = new Map();
  for (const a of addressRows) {
    if (!a.accountId) continue;
    const existing = addressByAccountId.get(a.accountId);
    if (!existing) { addressByAccountId.set(a.accountId, a); continue; }
    if (a.defaultFlag && !existing.defaultFlag) {
      addressByAccountId.set(a.accountId, a);
    }
  }

  const activeCustomers = customerRows.filter((c) => c.activeFlag);
  log(`  ${activeCustomers.length} active customers`);
  const customers = activeCustomers.map((c) => {
    const addr = addressByAccountId.get(c.accountId);
    return {
      external_id: `fb:${c.id}`,
      number: c.number,
      name: c.name,
      default_ship_to: composeShipTo(c.name, addr, statesById),
      active: !!c.activeFlag,
    };
  });

  const activeProducts = productRows.filter((p) => p.activeFlag);
  log(`  ${activeProducts.length} active products`);
  const products = activeProducts.map((p) => ({
    external_id: `fb:${p.id}`,
    fp_code: p.num,
    name: p.description || p.num,
    active: !!p.activeFlag,
  }));

  // ----- Raw materials -----------------------------------------------
  // 1. Index UoMs so we can label each part with "kg" / "lb" / "ea" / etc.
  //    Prefer the short `code` (e.g. "kg"); fall back to abbreviation, then name.
  const uomById = new Map();
  for (const u of uomRows) {
    const label = u.code || u.abbreviation || u.name || "";
    uomById.set(u.id, String(label).toLowerCase());
  }

  // 2. Latest avgCost per partId. Fishbowl writes a new partcost row on
  //    every receipt; we keep the most recent by dateLastModified.
  const latestCostByPartId = new Map();
  for (const c of partCostRows) {
    if (c.partId == null) continue;
    const cur = latestCostByPartId.get(c.partId);
    if (!cur || (c.dateLastModified || "") > (cur.dateLastModified || "")) {
      latestCostByPartId.set(c.partId, c);
    }
  }

  // 3. Filter to active parts whose num contains "-RW-".
  const rawMaterials = partRows
    .filter((p) => p.activeFlag && typeof p.num === "string" && p.num.includes("-RW-"))
    .map((p) => {
      const cost = latestCostByPartId.get(p.id);
      const uomLabel = uomById.get(p.uomId) || "kg";
      return {
        fp_code: p.num,
        name: p.description || p.num,
        default_unit: uomLabel,
        default_cost_per_kg:
          cost && typeof cost.avgCost === "number" ? cost.avgCost : null,
        active: !!p.activeFlag,
      };
    });
  log(`  ${rawMaterials.length} raw materials with -RW- in num`);

  // ----- Packaging components ----------------------------------------
  // Bottle-costing calculator inputs. Three infixes, two owner prefixes:
  //
  //   -PK-  bottles, caps/closures, liners, master boxes
  //   -LL-  labels
  //   -UC-  unit cartons / IFCs
  //
  //   PC-…  PharmaCenter-purchased → real cost from partcost.avgCost
  //   CA-…  customer asset         → ALWAYS $0 (free issue)
  //
  // We send the raw avgCost for everything; the receiving route derives
  // owner/kind from fp_code and forces CA rows to 0. Deriving it there
  // (not here) means a stale copy of this script can't mislabel a
  // customer asset as PharmaCenter-purchased and inflate a quote.
  //
  // Note: no last_order_cost_per_unit — the dump carries no `poitem`
  // table, so "Fish Bowl (Last Order)" resolves to "—" in the picker.
  // Same limitation the raw-materials block has today.
  const PACKAGING_INFIXES = ["-PK-", "-LL-", "-UC-"];
  const packagingComponents = partRows
    .filter(
      (p) =>
        p.activeFlag &&
        typeof p.num === "string" &&
        PACKAGING_INFIXES.some((ix) => p.num.toUpperCase().includes(ix)),
    )
    .map((p) => {
      const cost = latestCostByPartId.get(p.id);
      const uomLabel = uomById.get(p.uomId) || "ea";
      return {
        fp_code: p.num,
        name: p.description || p.num,
        default_unit: uomLabel,
        inventory_cost_per_unit:
          cost && typeof cost.avgCost === "number" ? cost.avgCost : null,
        inventory_cost_uom: uomLabel,
        active: !!p.activeFlag,
      };
    });
  {
    const ca = packagingComponents.filter((r) =>
      /^CA[-_]/i.test(r.fp_code),
    ).length;
    log(
      `  ${packagingComponents.length} packaging components with -PK-/-LL-/-UC- in num ` +
        `(${ca} customer assets → $0)`,
    );
  }

  // ----- Sales orders --------------------------------------------------
  // Open SOs (statusId 20 Issued / 25 In Progress, plus 10 Estimate for
  // context) with their line items folded into an `items` array. One run
  // id ties every batch of tonight's run together; the finalize call at
  // the end tells the receiver "anything not stamped with this run id is
  // no longer open" — that is how closed/shipped/voided orders drop out
  // without this script ever having to enumerate them.
  const soRows = parsed.so || [];
  const soItemRows = parsed.soitem || [];
  log(`  ${soRows.length} sales orders, ${soItemRows.length} soitem rows in dump`);

  const customerNameById = new Map();
  for (const c of customerRows) customerNameById.set(c.id, c.name);

  const itemsBySoId = new Map();
  for (const it of soItemRows) {
    if (it.soId == null) continue;
    if (!itemsBySoId.has(it.soId)) itemsBySoId.set(it.soId, []);
    itemsBySoId.get(it.soId).push({
      line: typeof it.soLineItem === "number" ? it.soLineItem : null,
      type_id: typeof it.typeId === "number" ? it.typeId : null,
      status_id: typeof it.statusId === "number" ? it.statusId : null,
      product_num: it.productNum || null,
      description: it.description || null,
      qty_ordered:
        typeof it.qtyOrdered === "number"
          ? it.qtyOrdered
          : typeof it.qtyToFulfill === "number"
            ? it.qtyToFulfill
            : null,
      qty_fulfilled: typeof it.qtyFulfilled === "number" ? it.qtyFulfilled : null,
      qty_picked: typeof it.qtyPicked === "number" ? it.qtyPicked : null,
      unit_price: typeof it.unitPrice === "number" ? it.unitPrice : null,
      total_price: typeof it.totalPrice === "number" ? it.totalPrice : null,
      date_scheduled: it.dateScheduledFulfillment || null,
    });
  }

  const salesOrders = soRows
    .filter((s) => SO_SYNCED_STATUSES.includes(s.statusId))
    .map((s) => ({
      fb_so_id: s.id,
      so_number: String(s.num ?? ""),
      status_id: typeof s.statusId === "number" ? s.statusId : null,
      status_name: SO_STATUS_NAMES[s.statusId] || String(s.statusId ?? ""),
      is_open: SO_OPEN_STATUSES.includes(s.statusId),
      customer_name:
        customerNameById.get(s.customerId) || s.billToName || null,
      customer_po: s.customerPO || null,
      salesman: s.salesman || s.salesmanInitials || null,
      note: s.note || null,
      date_issued: s.dateIssued || null,
      date_created: s.dateCreated || null,
      date_first_ship: s.dateFirstShip || null,
      date_last_modified: s.dateLastModified || null,
      subtotal: typeof s.subTotal === "number" ? s.subTotal : null,
      total_price: typeof s.totalPrice === "number" ? s.totalPrice : null,
      items: (itemsBySoId.get(s.id) || []).sort(
        (a, b) => (a.line ?? 0) - (b.line ?? 0),
      ),
    }))
    .filter((s) => s.so_number);
  log(
    `  ${salesOrders.length} sales orders in statuses ${SO_SYNCED_STATUSES.join("/")} ` +
      `(${salesOrders.filter((s) => s.is_open).length} open)`,
  );

  // ----- Purchase orders ----------------------------------------------
  // Same pattern as sales orders: statusId 10/20/25, items folded into
  // each PO. Each poitem line is stamped with the SO number it belongs
  // to (via poitem.soItemId → soitem.id → soitem.soId → so.num); distinct
  // SO numbers per PO get rolled up into so_numbers[] so the meetings hub
  // can look up POs for one SO with a single GIN-indexed contains query.
  const poRows = parsed.po || [];
  const poItemRows = parsed.poitem || [];
  const vendorRows = parsed.vendor || [];
  log(
    `  ${poRows.length} purchase orders, ${poItemRows.length} poitem rows, ` +
      `${vendorRows.length} vendors in dump`,
  );

  const vendorNameById = new Map();
  for (const v of vendorRows) vendorNameById.set(v.id, v.name);

  // soitem.id → SO context, for stamping each poitem line.
  const soNumById = new Map(soRows.map((s) => [s.id, String(s.num ?? "")]));
  const soItemById = new Map();
  for (const it of soItemRows) {
    if (it.id == null) continue;
    soItemById.set(it.id, {
      so_number: soNumById.get(it.soId) || null,
      so_line: typeof it.soLineItem === "number" ? it.soLineItem : null,
      so_product_num: it.productNum || null,
    });
  }

  const poItemsByPoId = new Map();
  for (const it of poItemRows) {
    if (it.poId == null) continue;
    const soInfo = it.soItemId != null ? soItemById.get(it.soItemId) : null;
    if (!poItemsByPoId.has(it.poId)) poItemsByPoId.set(it.poId, []);
    poItemsByPoId.get(it.poId).push({
      line: typeof it.poLineItem === "number" ? it.poLineItem : null,
      product_num: it.productNum || null,
      description: it.description || null,
      qty_ordered:
        typeof it.qtyOrdered === "number"
          ? it.qtyOrdered
          : typeof it.qtyToFulfill === "number"
            ? it.qtyToFulfill
            : null,
      qty_fulfilled:
        typeof it.qtyFulfilled === "number" ? it.qtyFulfilled : null,
      unit_cost: typeof it.unitCost === "number" ? it.unitCost : null,
      total_cost: typeof it.totalCost === "number" ? it.totalCost : null,
      date_scheduled: it.dateScheduledFulfillment || null,
      so_number: soInfo?.so_number || null,
      so_item_line: soInfo?.so_line ?? null,
      so_item_product_num: soInfo?.so_product_num || null,
    });
  }

  const purchaseOrders = poRows
    .filter((p) => PO_SYNCED_STATUSES.includes(p.statusId))
    .map((p) => {
      const items = (poItemsByPoId.get(p.id) || []).sort(
        (a, b) => (a.line ?? 0) - (b.line ?? 0),
      );
      const soNumbers = Array.from(
        new Set(items.map((it) => it.so_number).filter(Boolean)),
      );
      return {
        fb_po_id: p.id,
        po_number: String(p.num ?? ""),
        status_id: typeof p.statusId === "number" ? p.statusId : null,
        status_name:
          PO_STATUS_NAMES[p.statusId] || String(p.statusId ?? ""),
        is_open: PO_OPEN_STATUSES.includes(p.statusId),
        vendor_id: p.vendorId ?? null,
        vendor_name: vendorNameById.get(p.vendorId) || null,
        buyer: p.username || p.buyer || null,
        date_issued: p.dateIssued || null,
        date_created: p.dateCreated || null,
        date_completed: p.dateCompleted || null,
        date_last_modified: p.dateLastModified || null,
        subtotal: typeof p.subTotal === "number" ? p.subTotal : null,
        total_price: typeof p.totalPrice === "number" ? p.totalPrice : null,
        items,
        so_numbers: soNumbers,
      };
    })
    .filter((p) => p.po_number);

  // Second-pass linkage via so.vendorPO — PharmaCenter doesn't use
  // Fishbowl's built-in "PO from SO backorder" (which would set
  // poitem.soItemId), they instead type the PO number(s) into the SO's
  // Vendor PO field, comma-separated ("5915,5916"). Parse that string,
  // then for every PO number that matches, stamp the SO number into
  // items[].so_number and into the PO's so_numbers[] rollup so the
  // meetings hub can find POs for one SO with a single indexed query.
  const poByNumber = new Map(purchaseOrders.map((p) => [p.po_number, p]));
  let vendorPoLinked = 0;
  for (const s of soRows) {
    if (!s.vendorPO || !s.num) continue;
    const soNumber = String(s.num);
    const poNums = String(s.vendorPO)
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const num of poNums) {
      const po = poByNumber.get(num);
      if (!po) continue;
      if (!po.so_numbers.includes(soNumber)) po.so_numbers.push(soNumber);
      // Best-effort item-level attribution:
      //   - if a poitem's product_num appears in the SO's items, tag it
      //     with this SO number (multi-SO POs get split cleanly).
      //   - if no items on the PO overlap ANY SO's products (or the SO
      //     has no items at all), fall back to attributing every item on
      //     the PO to this SO — better one weak signal than none.
      const soProductNums = new Set(
        (itemsBySoId.get(s.id) || [])
          .map((it) => it.product_num)
          .filter(Boolean),
      );
      let stampedAny = false;
      for (const it of po.items) {
        if (
          it.product_num &&
          soProductNums.has(it.product_num) &&
          it.so_number !== soNumber
        ) {
          it.so_number = soNumber;
          it.so_item_product_num = it.product_num;
          stampedAny = true;
        }
      }
      if (!stampedAny) {
        // Nothing overlapped — attribute the whole PO to this SO.
        for (const it of po.items) {
          if (!it.so_number) it.so_number = soNumber;
        }
      }
      vendorPoLinked += 1;
    }
  }

  log(
    `  ${purchaseOrders.length} purchase orders in statuses ${PO_SYNCED_STATUSES.join("/")} ` +
      `(${purchaseOrders.filter((p) => p.is_open).length} open, ` +
      `${purchaseOrders.filter((p) => p.so_numbers.length > 0).length} SO-linked, ` +
      `${vendorPoLinked} vendor-PO links resolved)`,
  );

  // ----- POSTs -------------------------------------------------------
  log(`Sending customers (${customers.length}) → ${API_BASE}/api/sync/customers`);
  const cResult = await postBatched(API_BASE, "/api/sync/customers", "customers", customers);
  log(`  done: received=${cResult.received} upserted=${cResult.upserted}`);

  log(`Sending products (${products.length}) → ${API_BASE}/api/sync/products`);
  const pResult = await postBatched(API_BASE, "/api/sync/products", "products", products);
  log(`  done: received=${pResult.received} upserted=${pResult.upserted}`);

  log(`Sending raw materials (${rawMaterials.length}) → ${QUOTE_API_BASE}/api/sync/raw-materials`);
  const rmResult = await postBatched(QUOTE_API_BASE, "/api/sync/raw-materials", "raw_materials", rawMaterials);
  log(`  done: received=${rmResult.received} upserted=${rmResult.upserted}`);

  log(`Sending packaging components (${packagingComponents.length}) → ${QUOTE_API_BASE}/api/sync/packaging-components`);
  const pcResult = await postBatched(QUOTE_API_BASE, "/api/sync/packaging-components", "packaging_components", packagingComponents);
  log(`  done: received=${pcResult.received} upserted=${pcResult.upserted} skipped=${pcResult.skipped ?? 0}`);

  // Sales orders carry a run_id on every batch plus a finalize call, so
  // postBatched (which sends bare {key: batch}) doesn't fit — inline loop.
  const soRunId = new Date().toISOString();
  log(`Sending sales orders (${salesOrders.length}) → ${QUOTE_API_BASE}/api/sync/sales-orders (run ${soRunId})`);
  if (DRY_RUN) {
    log(`[DRY_RUN] would POST ${salesOrders.length} sales_orders + finalize`);
  } else {
    let soReceived = 0;
    let soUpserted = 0;
    for (let i = 0; i < salesOrders.length; i += BATCH_SIZE) {
      const batch = salesOrders.slice(i, i + BATCH_SIZE);
      const result = await postJson(
        `${QUOTE_API_BASE}/api/sync/sales-orders`,
        { run_id: soRunId, sales_orders: batch },
      );
      soReceived += result.received || 0;
      soUpserted += result.upserted || 0;
      log(`  batch ${i / BATCH_SIZE + 1}: received=${result.received} upserted=${result.upserted}`);
    }
    const fin = await postJson(`${QUOTE_API_BASE}/api/sync/sales-orders`, {
      run_id: soRunId,
      finalize: true,
    });
    log(`  done: received=${soReceived} upserted=${soUpserted} closed_stale=${fin.closed ?? 0}`);
  }

  // Purchase orders — same run_id + finalize shape as sales orders.
  const poRunId = new Date().toISOString();
  log(`Sending purchase orders (${purchaseOrders.length}) → ${QUOTE_API_BASE}/api/sync/purchase-orders (run ${poRunId})`);
  if (DRY_RUN) {
    log(`[DRY_RUN] would POST ${purchaseOrders.length} purchase_orders + finalize`);
  } else {
    let poReceived = 0;
    let poUpserted = 0;
    for (let i = 0; i < purchaseOrders.length; i += BATCH_SIZE) {
      const batch = purchaseOrders.slice(i, i + BATCH_SIZE);
      const result = await postJson(
        `${QUOTE_API_BASE}/api/sync/purchase-orders`,
        { run_id: poRunId, purchase_orders: batch },
      );
      poReceived += result.received || 0;
      poUpserted += result.upserted || 0;
      log(`  batch ${i / BATCH_SIZE + 1}: received=${result.received} upserted=${result.upserted}`);
    }
    const fin = await postJson(`${QUOTE_API_BASE}/api/sync/purchase-orders`, {
      run_id: poRunId,
      finalize: true,
    });
    log(`  done: received=${poReceived} upserted=${poUpserted} closed_stale=${fin.closed ?? 0}`);
  }

  log("Sync complete.");
  logStream.end();
}

main().catch((err) => {
  log("FATAL:", err.stack || err.message);
  logStream.end();
  process.exit(1);
});
