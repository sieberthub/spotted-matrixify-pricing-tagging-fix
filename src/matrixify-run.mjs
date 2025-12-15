import fs from "node:fs";
import path from "node:path";

/**
 * Matrixify CSV Processor (Arigato-Logik 1:1)
 * Input:  data/product.csv (Matrixify Export)
 * Output: out/matrixify.full.csv
 *         out/matrixify.only-changes.csv
 *         out/matrixify.test-XX.csv
 *         out/matrixify.summary.json
 */

const INPUT_CSV = process.env.INPUT_CSV || "data/matrixify/Products.csv";
const VAT_RATE = Number(process.env.VAT_RATE || "0.20");
const TEST_COUNT = Math.max(1, Number(process.env.TEST_COUNT || "20"));

const OUT_DIR = "out";
fs.mkdirSync(OUT_DIR, { recursive: true });

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function existsAny(paths) {
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

// Fallbacks, falls du doch Products.csv etc. hast:
const inputResolved =
  existsAny([INPUT_CSV, "data/Products.csv", "data/products.csv", "data/Product.csv"]) || INPUT_CSV;

if (!fs.existsSync(inputResolved)) {
  die(
    `Input CSV nicht gefunden: ${INPUT_CSV}\n` +
      `Tipp: Leg die Datei ins Repo unter data/Product.csv (oder setz INPUT_CSV entsprechend).`
  );
}

// ---------- CSV helpers (ohne Dependencies) ----------
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote?
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

function escapeCsv(val) {
  const s = String(val ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [];
  lines.push(headers.map(escapeCsv).join(","));
  for (const r of rows) {
    lines.push(headers.map((h) => escapeCsv(r[h] ?? "")).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"));
}

function toNum(x) {
  if (x == null) return null;
  const s = String(x).trim();
  if (!s) return null;
  // Matrixify kann . oder , liefern
  const normalized = s.replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function approxEqualMoney(a, b) {
  const na = toNum(a);
  const nb = toNum(b);
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) < 0.005;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function moneyStr(x) {
  // Matrixify akzeptiert "119" oder "119.00" – wir geben sauber 2 Dezimalstellen aus.
  const n = Number(x);
  if (!Number.isFinite(n)) return "";
  return round2(n).toFixed(2);
}

// ---------- Arigato Logic (1:1) ----------
function normTag(t) {
  return String(t || "").toLowerCase().trim();
}

function parseTags(tagsStr) {
  const s = String(tagsStr ?? "").trim();
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function tagsToString(tagsArr) {
  // Matrixify exportiert typischerweise "a, b, c"
  return (tagsArr || []).join(", ");
}

function hasUsedGateway(tags) {
  const lower = (tags || []).map(normTag);
  return lower.includes("preowned / defect") || lower.includes("preloved");
}

function determineTypeArigato(M_net, C_net, tags) {
  // exakt CustomAction1: wenn M>0 & C>0
  if (!(M_net > 0) || !(C_net > 0)) return "skip";
  if (hasUsedGateway(tags)) return "used";

  const d_max = 0.55;
  const ship_cost = 12.9;
  const cust_ship = 8.5;
  const aff_rate = 0.12;
  const other_rate = 0.0455;

  const P_sale_max = M_net * (1 - d_max);
  const affiliate_fee = P_sale_max * aff_rate;

  const gross_with_ship = P_sale_max + cust_ship;
  const gross_with_vat = gross_with_ship * (1 + VAT_RATE);
  const other_fee = gross_with_vat * other_rate;

  const G = P_sale_max - C_net - ship_cost - affiliate_fee - other_fee;
  return G >= 0 ? "standard" : "low-margin";
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function computePricing(M_net, C_net, type) {
  if (!(M_net > 0) || !(C_net > 0)) return { ok: false };

  // Used
  const U = { alpha: 0.15, beta: 1.10, gamma: 0.20, N: 40.0, K0: 500.0, k: 500.0 };
  // Low-margin
  const LM = { alpha: 0.16, beta: 0.25, gamma: 0.40, N: 35.0, K0: 300.0, k: 500.0 };
  // Standard
  const STD = {
    d_max: 0.5,
    mu0: 0.75,
    beta_disc: 0.2,
    gamma_M: 0.23,
    rho: 0.6,
    d_ref: 0.9,
    M_ref: 25000.0,
  };

  let price_new = M_net;
  let as_low_as = 0;

  if (type === "used" || type === "low-margin") {
    const P = type === "used" ? U : LM;
    const sM = 1 / (1 + Math.exp((M_net - P.K0) / P.k));
    const log10_MC = Math.log10(M_net / C_net);
    const price_raw = C_net * (1 + P.alpha + P.beta * log10_MC + P.gamma * sM) + P.N;
    price_new = Math.min(M_net, price_raw);
    as_low_as = 0;
  }

  if (type === "standard") {
    let d = 1 - C_net / M_net;
    d = clamp(d, 0, 0.99);

    const L_d = Math.log10(1 / (1 - d));
    const L_dref = Math.log10(1 / (1 - STD.d_ref));
    const mu_d = STD.mu0 + STD.beta_disc * (L_d - L_dref);
    const m_shape = Math.pow(M_net / STD.M_ref, -STD.gamma_M);
    const A_M = (M_net * m_shape) / (1 - STD.d_max);

    const B_d =
      (1 - STD.rho) * (1 + mu_d) * (1 - d) +
      STD.rho * (1 + STD.mu0) * (1 - STD.d_ref);

    const P_hidden_raw = A_M * B_d;
    const P_hidden = Math.min(M_net, P_hidden_raw);
    const P_sale_min = (1 - STD.d_max) * P_hidden;

    price_new = P_hidden;
    as_low_as = P_sale_min;
  }

  return {
    ok: true,
    price_new: round2(price_new),
    as_low_as: round2(as_low_as),
  };
}

// Nur diese 3 Typ-Tags anfassen:
const TYPE_TAGS = ["used", "standard", "low-margin"];

function computeDesiredTags(currentTags, desiredType) {
  const cur = currentTags || [];
  const curLower = cur.map(normTag);

  // remove existing type tags (case-insensitive), keep everything else in original order
  const cleaned = cur.filter((t) => !TYPE_TAGS.includes(normTag(t)));

  // add desired type tag if needed
  const out = cleaned.slice();
  if (TYPE_TAGS.includes(desiredType) && !curLower.includes(desiredType)) {
    out.push(desiredType); // immer lowercase wie in Arigato
  }
  return out;
}

function tagsChanged(aTags, bTags) {
  const a = (aTags || []).map(normTag).sort();
  const b = (bTags || []).map(normTag).sort();
  return JSON.stringify(a) !== JSON.stringify(b);
}

function tagsToAddRemove(currentTags, desiredType) {
  const curLower = (currentTags || []).map(normTag);
  const tags_to_add = [];
  const tags_to_remove = [];

  if (TYPE_TAGS.includes(desiredType) && !curLower.includes(desiredType)) {
    tags_to_add.push(desiredType);
  }

  for (const t of TYPE_TAGS) {
    if (t !== desiredType && curLower.includes(t)) tags_to_remove.push(t);
  }

  return { tags_to_add, tags_to_remove };
}

// ---------- Load CSV ----------
const raw = fs.readFileSync(inputResolved, "utf8");

// robust split lines (handles CRLF)
const lines = raw.split(/\r?\n/).filter((l, i, arr) => !(i === arr.length - 1 && !l.trim()));

if (lines.length < 2) die("CSV scheint leer zu sein.");

const headers = parseCsvLine(lines[0]);

// Erwartete Spalten (dein Export hat genau diese):
const COL = {
  ID: "ID",
  HANDLE: "Handle",
  COMMAND: "Command",
  TITLE: "Title",
  TYPE: "Type",
  TAGS: "Tags",
  TAGS_COMMAND: "Tags Command",
  STATUS: "Status",
  VARIANT_ID: "Variant ID",
  VARIANT_COMMAND: "Variant Command",
  VARIANT_INV_ITEM_ID: "Variant Inventory Item ID",
  VARIANT_POSITION: "Variant Position",
  VARIANT_PRICE: "Variant Price",
  VARIANT_COMPARE_AT: "Variant Compare At Price",
  VARIANT_COST: "Variant Cost",
  MF_AS_LOW_AS: "Metafield: spotted.as_low_as [number_decimal]",
};

for (const k of Object.values(COL)) {
  if (!headers.includes(k)) {
    die(
      `Spalte fehlt in CSV: "${k}".\n` +
        `Bitte prüf Matrixify Export-Settings. (Dein Script ist auf genau dieses Export-Format gebaut.)`
    );
  }
}

const rows = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const cells = parseCsvLine(line);
  const obj = {};
  for (let c = 0; c < headers.length; c++) {
    obj[headers[c]] = cells[c] ?? "";
  }
  rows.push(obj);
}

console.log(`Loaded CSV: ${inputResolved}`);
console.log(`Rows: ${rows.length}`);

// ---------- Group by Product ID ----------
const byProduct = new Map();

for (const r of rows) {
  const pid = String(r[COL.ID] || "").trim();
  if (!pid) continue;

  if (!byProduct.has(pid)) {
    byProduct.set(pid, {
      productId: pid,
      rows: [],
      baseRow: null,
      basePos: Infinity,
    });
  }
  const p = byProduct.get(pid);
  p.rows.push(r);

  const pos = toNum(r[COL.VARIANT_POSITION]) ?? 999999;
  if (pos < p.basePos) {
    p.basePos = pos;
    p.baseRow = r;
  }
}

// ---------- Decide changes + build outputs ----------
const outFull = [];
const outOnly = [];
const changesMeta = []; // per product summary for test selection

let stats = {
  productsTotal: byProduct.size,
  productsChanged: 0,
  drafted: 0,
  byType: { used: 0, standard: 0, "low-margin": 0, skip: 0 },
};

for (const p of byProduct.values()) {
  const base = p.baseRow || p.rows[0];

  const currentStatus = String(base[COL.STATUS] || "").trim();
  const currentTagsArr = parseTags(base[COL.TAGS]);

  // MSRP gross from compare-at
  const msrpGross = toNum(base[COL.VARIANT_COMPARE_AT]) ?? 0;
  const M_net = msrpGross > 0 ? msrpGross / (1 + VAT_RATE) : 0;

  // Cost (Matrixify Variant Cost ist already pre-VAT in deinem Setup)
  const C_net = toNum(base[COL.VARIANT_COST]) ?? 0;

  const missingMC = !(M_net > 0 && C_net > 0);
  const doDraft = missingMC && normTag(currentStatus) !== "draft";
  const desiredStatus = doDraft ? "Draft" : currentStatus;

  if (doDraft) stats.drafted += 1;

  const desiredType = missingMC ? "skip" : determineTypeArigato(M_net, C_net, currentTagsArr);
  stats.byType[desiredType] = (stats.byType[desiredType] || 0) + 1;

  const pricing =
    !missingMC && TYPE_TAGS.includes(desiredType)
      ? computePricing(M_net, C_net, desiredType)
      : { ok: false };

  const desiredPriceNew = pricing.ok ? moneyStr(pricing.price_new) : "";
  const desiredAsLowAs =
    pricing.ok && desiredType === "standard" && pricing.as_low_as > 0 ? moneyStr(pricing.as_low_as) : "";

  const desiredTagsArr =
    !missingMC && TYPE_TAGS.includes(desiredType)
      ? computeDesiredTags(currentTagsArr, desiredType)
      : currentTagsArr;

  const doTags = tagsChanged(currentTagsArr, desiredTagsArr);
  const { tags_to_add, tags_to_remove } = doTags ? tagsToAddRemove(currentTagsArr, desiredType) : { tags_to_add: [], tags_to_remove: [] };

  // Price diff: wenn irgendeine Variant Price abweicht, setzen wir (wie Arigato) alle auf price_new
  let doPrice = false;
  if (!missingMC && desiredPriceNew) {
    for (const r of p.rows) {
      if (!approxEqualMoney(r[COL.VARIANT_PRICE], desiredPriceNew)) {
        doPrice = true;
        break;
      }
    }
  }

  // Metafield diff (nur standard, niemals löschen bei anderen Typen)
  const currentAsLowAsRaw = String(base[COL.MF_AS_LOW_AS] ?? "").trim();
  const currentAsLowAsNorm = currentAsLowAsRaw ? currentAsLowAsRaw.replace(",", ".") : "";
  const desiredAsLowAsNorm = desiredAsLowAs ? desiredAsLowAs.replace(",", ".") : "";

  const doMetafield =
    !missingMC &&
    desiredType === "standard" &&
    !!desiredAsLowAsNorm &&
    (!currentAsLowAsNorm || !approxEqualMoney(currentAsLowAsNorm, desiredAsLowAsNorm));

  const needsChange = doDraft || doTags || doPrice || doMetafield;
  if (needsChange) stats.productsChanged += 1;

  // Apply to rows (FULL)
  for (const r0 of p.rows) {
    const r = { ...r0 };

    // Draft rule: only set Draft when missing M/C
    if (doDraft) r[COL.STATUS] = "Draft";

    // Tags: only adjust 3 type-tags (keep all others)
    if (doTags) {
      r[COL.TAGS] = tagsToString(desiredTagsArr);
      r[COL.TAGS_COMMAND] = "REPLACE";
    }

    // Price: set all variants to price_new (Arigato behaviour)
    if (doPrice && desiredPriceNew) {
      r[COL.VARIANT_PRICE] = desiredPriceNew;
      // Variant Command lassen wir wie exportiert (meist MERGE) – nicht anfassen.
    }

    // Metafield: only for standard (set), otherwise leave as-is
    if (doMetafield && desiredAsLowAsNorm) {
      r[COL.MF_AS_LOW_AS] = desiredAsLowAsNorm;
    }

    outFull.push(r);
  }

  // Only-changes file: include all variant rows for products that need any change
  if (needsChange) {
    for (const r0 of p.rows) {
      const r = { ...r0 };
      if (doDraft) r[COL.STATUS] = "Draft";
      if (doTags) {
        r[COL.TAGS] = tagsToString(desiredTagsArr);
        r[COL.TAGS_COMMAND] = "REPLACE";
      }
      if (doPrice && desiredPriceNew) r[COL.VARIANT_PRICE] = desiredPriceNew;
      if (doMetafield && desiredAsLowAsNorm) r[COL.MF_AS_LOW_AS] = desiredAsLowAsNorm;
      outOnly.push(r);
    }
  }

  changesMeta.push({
    productId: p.productId,
    handle: String(base[COL.HANDLE] || ""),
    title: String(base[COL.TITLE] || ""),
    type: desiredType,
    doDraft,
    doTags,
    doPrice,
    doMetafield,
    needsChange,
    tags_to_add,
    tags_to_remove,
  });
}

// ---------- Build test file (20 products, mixed cases if possible) ----------
const changed = changesMeta.filter((x) => x.needsChange);

function pickMixedTestProducts(list, count) {
  const draft = list.filter((x) => x.doDraft);
  const used = list.filter((x) => x.type === "used" && !x.doDraft);
  const std = list.filter((x) => x.type === "standard" && !x.doDraft);
  const lm = list.filter((x) => x.type === "low-margin" && !x.doDraft);

  const picked = [];
  const addSome = (arr, n) => {
    for (const x of arr) {
      if (picked.length >= count) break;
      if (picked.some((p) => p.productId === x.productId)) continue;
      picked.push(x);
      if (picked.filter((p) => p.productId === x.productId).length >= n) continue;
      if (picked.length >= count) break;
    }
  };

  // First: ensure variety
  addSome(draft, Math.min(3, count));
  addSome(used, Math.min(5, count));
  addSome(std, Math.min(8, count));
  addSome(lm, Math.min(8, count));

  // Fill remainder from all changed
  for (const x of list) {
    if (picked.length >= count) break;
    if (picked.some((p) => p.productId === x.productId)) continue;
    picked.push(x);
  }

  return picked.slice(0, count);
}

const testProducts = pickMixedTestProducts(changed, TEST_COUNT);
const testIds = new Set(testProducts.map((x) => x.productId));

const outTest = outOnly.filter((r) => testIds.has(String(r[COL.ID] || "").trim()));

// ---------- Write outputs ----------
const fullPath = path.join(OUT_DIR, "matrixify.full.csv");
const onlyPath = path.join(OUT_DIR, "matrixify.only-changes.csv");
const testPath = path.join(OUT_DIR, `matrixify.test-${String(TEST_COUNT).padStart(2, "0")}.csv`);
const summaryPath = path.join(OUT_DIR, "matrixify.summary.json");

writeCsv(fullPath, headers, outFull);
writeCsv(onlyPath, headers, outOnly);
writeCsv(testPath, headers, outTest);

const summary = {
  input: inputResolved,
  rowsIn: rows.length,
  productsTotal: stats.productsTotal,
  productsChanged: stats.productsChanged,
  drafted: stats.drafted,
  byType: stats.byType,
  testCount: TEST_COUNT,
  testProducts: testProducts.map((x) => ({
    productId: x.productId,
    handle: x.handle,
    type: x.type,
    doDraft: x.doDraft,
    doTags: x.doTags,
    doPrice: x.doPrice,
    doMetafield: x.doMetafield,
    tags_to_add: x.tags_to_add,
    tags_to_remove: x.tags_to_remove,
  })),
};

fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

console.log("Done.");
console.log(`Products total: ${stats.productsTotal}`);
console.log(`Products needing change: ${stats.productsChanged}`);
console.log(`Drafted (missing MSRP/cost): ${stats.drafted}`);
console.log(`ByType: ${JSON.stringify(stats.byType)}`);
console.log(`Wrote: ${fullPath}`);
console.log(`Wrote: ${onlyPath}`);
console.log(`Wrote: ${testPath}`);
console.log(`Wrote: ${summaryPath}`);
