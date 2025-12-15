import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const IN_FILE = process.env.IN_FILE || "data/Products.csv";
const OUT_DIR = process.env.OUT_DIR || "out";
const TEST_SIZE = Number(process.env.TEST_SIZE || "20");

const T_VAT = 0.20;
const TYPE_TAGS = ["used", "standard", "low-margin"];

fs.mkdirSync(OUT_DIR, { recursive: true });

/** ---------- CSV parsing (Matrixify) ---------- */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }
  out.push(cur);
  return out;
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [];
  lines.push(headers.join(","));
  for (const r of rows) {
    lines.push(headers.map(h => csvEscape(r[h] ?? "")).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"));
}

function splitTags(s) {
  if (!s) return [];
  return String(s)
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);
}

function normTag(t) { return String(t || "").trim().toLowerCase(); }

function toNumberOrNull(x) {
  const s = String(x ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function round2(x) { return Math.round(x * 100) / 100; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function approxEqualMoney(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) < 0.005;
}

function hasUsedGateway(tags) {
  const lower = (tags || []).map(normTag);
  return lower.includes("preowned / defect") || lower.includes("preloved");
}

/** ---------- Arigato Block 1: Type Decision ---------- */
function determineTypeArigato(M_net, C_net, tags) {
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
  const gross_with_vat = gross_with_ship * (1 + T_VAT);
  const other_fee = gross_with_vat * other_rate;

  const G = P_sale_max - C_net - ship_cost - affiliate_fee - other_fee;
  return (G >= 0) ? "standard" : "low-margin";
}

/** ---------- Arigato Worker JS: Pricing ---------- */
function computePricing(M_net, C_net, type) {
  if (!(M_net > 0) || !(C_net > 0)) return { ok: false };

  const U = { alpha: 0.15, beta: 1.10, gamma: 0.20, N: 40.00, K0: 500.0, k: 500.0 };
  const LM = { alpha: 0.16, beta: 0.25, gamma: 0.40, N: 35.00, K0: 300.0, k: 500.0 };
  const STD = {
    d_max: 0.50,
    mu0: 0.75,
    beta_disc: 0.20,
    gamma_M: 0.23,
    rho: 0.60,
    d_ref: 0.90,
    M_ref: 25000.0
  };

  let price_new = M_net;
  let as_low_as = 0;

  if (type === "used" || type === "low-margin") {
    const P = (type === "used") ? U : LM;
    const sM = 1 / (1 + Math.exp((M_net - P.K0) / P.k));
    const log10_MC = Math.log10(M_net / C_net);
    const price_raw = C_net * (1 + P.alpha + P.beta * log10_MC + P.gamma * sM) + P.N;
    price_new = Math.min(M_net, price_raw);
    as_low_as = 0;
  }

  if (type === "standard") {
    let d = 1 - (C_net / M_net);
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

  return { ok: true, price_new: round2(price_new), as_low_as: round2(as_low_as) };
}

/** ---------- Tags: nur 3 Typ-Tags anfassen ---------- */
function computeTagOps(currentTags, desiredType) {
  const cur = currentTags || [];
  const curLower = cur.map(normTag);

  const tags_to_add = [];
  const tags_to_remove = [];

  if (TYPE_TAGS.includes(desiredType) && !curLower.includes(desiredType)) tags_to_add.push(desiredType);
  for (const t of TYPE_TAGS) {
    if (t !== desiredType && curLower.includes(t)) tags_to_remove.push(t);
  }

  // Desired tags list: remove existing type-tags, add correct one
  const cleaned = cur.filter(t => !TYPE_TAGS.includes(normTag(t)));
  const desiredTags = cleaned.slice();
  if (TYPE_TAGS.includes(desiredType) && !desiredTags.map(normTag).includes(desiredType)) desiredTags.push(desiredType);

  const doTags = (tags_to_add.length > 0 || tags_to_remove.length > 0);
  return { desiredTags, tags_to_add, tags_to_remove, doTags };
}

/** ---------- Read Matrixify CSV → group by product ---------- */
async function readMatrixify(file) {
  const rs = fs.createReadStream(file);
  const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });

  let headers = null;
  const products = new Map();

  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }
    if (!line.trim()) continue;

    const vals = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = vals[i] ?? "";

    const pid = row["ID"];
    if (!pid) continue;

    if (!products.has(pid)) {
      products.set(pid, {
        id: pid,
        handle: row["Handle"] || "",
        title: row["Title"] || "",
        status: row["Status"] || "",
        tagsRaw: row["Tags"] || "",
        asLowAsRaw: row["Metafield: spotted.as_low_as [number_decimal]"] || "",
        variants: []
      });
    }

    const p = products.get(pid);
    p.variants.push({
      variantId: row["Variant ID"] || "",
      position: toNumberOrNull(row["Variant Position"]) ?? 999999,
      price: toNumberOrNull(row["Variant Price"]),
      compareAt: toNumberOrNull(row["Variant Compare At Price"]),
      cost: toNumberOrNull(row["Variant Cost"])
    });
  }

  return { products };
}

function pickBaseVariant(p) {
  const sorted = (p.variants || []).slice().sort((a, b) => a.position - b.position);
  return sorted[0] || null;
}

function fmt2(n) {
  if (n == null || !Number.isFinite(n)) return "";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function normalizeMetafieldVal(s) {
  const n = toNumberOrNull(s);
  return n == null ? "" : fmt2(n);
}

/** ---------- Build Matrixify Import Rows ---------- */
const IMPORT_HEADERS = [
  "ID", "Handle", "Title", "Command",
  "Tags", "Tags Command",
  "Status",
  "Metafield: spotted.as_low_as [number_decimal]",
  "Variant ID", "Variant Command", "Variant Price"
];

// row template
function baseImportRow(p) {
  return {
    "ID": p.id,
    "Handle": p.handle,
    "Title": p.title,
    "Command": "UPDATE",
    "Tags": "",
    "Tags Command": "",
    "Status": "",
    "Metafield: spotted.as_low_as [number_decimal]": "",
    "Variant ID": "",
    "Variant Command": "",
    "Variant Price": ""
  };
}

function attachProductFields(row, computed) {
  if (computed.doTags) {
    row["Tags"] = computed.desiredTags.join(", ");
    row["Tags Command"] = "REPLACE";
  }
  if (computed.doDraft) {
    row["Status"] = "Draft";
  }
  if (computed.doMetafield) {
    row["Metafield: spotted.as_low_as [number_decimal]"] = fmt2(computed.asLowAsNew);
  }
}

/**
 * onlyChanges:
 * - wenn Preisänderungen: eine Zeile pro betroffener Variante (Variant Command=UPDATE)
 *   und Produktfelder (Tags/Status/Metafield) nur auf der ersten Zeile
 * - sonst: eine Zeile nur mit Produktfeldern
 */
function buildOnlyChangesRows(p, computed) {
  const rows = [];

  if (computed.variantUpdates.length > 0) {
    computed.variantUpdates.forEach((vu, idx) => {
      const r = baseImportRow(p);
      r["Variant ID"] = vu.variantId;
      r["Variant Command"] = "UPDATE";
      r["Variant Price"] = fmt2(vu.priceNew);
      if (idx === 0) attachProductFields(r, computed);
      rows.push(r);
    });
    return rows;
  }

  // only product-level changes
  const r = baseImportRow(p);
  attachProductFields(r, computed);
  rows.push(r);
  return rows;
}

/**
 * fullFixed:
 * - schreibt für ALLE Produkte/Varianten die "korrekten" Zielwerte,
 *   aber nur in unseren 4 Feldern (Tags/Status Draft/Metafield/Variant Price).
 * - Produktfelder nur auf erster Variant-Zeile.
 */
function buildFullFixedRows(p, computed) {
  const rows = [];
  const vars = (p.variants || []).filter(v => v.variantId);

  if (vars.length === 0) {
    const r = baseImportRow(p);
    attachProductFields(r, computed);
    return [r];
  }

  vars
    .slice()
    .sort((a, b) => a.position - b.position)
    .forEach((v, idx) => {
      const r = baseImportRow(p);

      // Variant price: nur wenn berechenbar (nicht skip/missing)
      if (computed.priceNew != null && computed.canPriceWrite) {
        r["Variant ID"] = v.variantId;
        r["Variant Command"] = "UPDATE";
        r["Variant Price"] = fmt2(computed.priceNew);
      }

      if (idx === 0) attachProductFields(r, computed);
      rows.push(r);
    });

  return rows;
}

/** ---------- Preview rows (product-level) ---------- */
function previewRow(p, computed) {
  return {
    productId: p.id,
    handle: p.handle,
    title: p.title,
    status_current: p.status,
    status_desired: computed.doDraft ? "Draft" : p.status,
    type: computed.type,
    msrp_gross: computed.msrpGross != null ? fmt2(computed.msrpGross) : "",
    M_net: computed.M_net != null ? fmt2(computed.M_net) : "",
    C_net: computed.C_net != null ? fmt2(computed.C_net) : "",
    price_new: computed.priceNew != null ? fmt2(computed.priceNew) : "",
    as_low_as_old: normalizeMetafieldVal(p.asLowAsRaw),
    as_low_as_new: computed.asLowAsNew != null ? fmt2(computed.asLowAsNew) : "",
    tags_to_add: computed.tags_to_add.join("|"),
    tags_to_remove: computed.tags_to_remove.join("|"),
    doDraft: computed.doDraft ? "true" : "false",
    doTags: computed.doTags ? "true" : "false",
    doPrice: computed.variantUpdates.length > 0 ? "true" : "false",
    doMetafield: computed.doMetafield ? "true" : "false",
    needsChange: computed.needsChange ? "true" : "false"
  };
}

function writePreviewCsv(filePath, rows) {
  const headers = Object.keys(rows[0] || {});
  writeCsv(filePath, headers, rows);
}

/** ---------- Main ---------- */
async function main() {
  if (!fs.existsSync(IN_FILE)) {
    throw new Error(`Input not found: ${IN_FILE} (lege Products.csv unter data/Products.csv ab)`);
  }

  console.log(`Reading: ${IN_FILE}`);
  const { products } = await readMatrixify(IN_FILE);

  const previewAll = [];
  const previewChanges = [];

  const onlyChangesImportRows = [];
  const fullFixedImportRows = [];

  const changeProductsByType = { used: [], standard: [], "low-margin": [] };

  let drafted = 0;
  const byType = { used: 0, standard: 0, "low-margin": 0, skip: 0 };
  let needChange = 0;

  for (const p of products.values()) {
    const tags = splitTags(p.tagsRaw);

    const base = pickBaseVariant(p);
    const msrpGross = base?.compareAt ?? null;                 // Variant Compare At Price (gross)
    const M_net = (msrpGross != null && msrpGross > 0) ? (msrpGross / (1 + T_VAT)) : 0;
    const C_net = base?.cost ?? 0;

    const missingMC = !(M_net > 0 && C_net > 0);
    const doDraft = missingMC && String(p.status).toLowerCase() !== "draft";
    if (doDraft) drafted++;

    const type = missingMC ? "skip" : determineTypeArigato(M_net, C_net, tags);
    byType[type] = (byType[type] || 0) + 1;

    const pricing = (!missingMC && ["used", "standard", "low-margin"].includes(type))
      ? computePricing(M_net, C_net, type)
      : { ok: false };

    const priceNew = pricing.ok ? pricing.price_new : null;
    const asLowAsNew = (pricing.ok && type === "standard" && pricing.as_low_as > 0) ? pricing.as_low_as : null;

    const tagOps = (!missingMC && ["used", "standard", "low-margin"].includes(type))
      ? computeTagOps(tags, type)
      : { desiredTags: tags, tags_to_add: [], tags_to_remove: [], doTags: false };

    // price diff per variant
    const variantUpdates = [];
    if (!missingMC && priceNew != null) {
      for (const v of p.variants) {
        if (!v.variantId) continue;
        if (!approxEqualMoney(v.price, priceNew)) {
          variantUpdates.push({ variantId: v.variantId, priceNew });
        }
      }
    }

    // metafield diff (only standard)
    const currentAsLowAs = toNumberOrNull(p.asLowAsRaw);
    const doMetafield =
      !missingMC &&
      type === "standard" &&
      asLowAsNew != null &&
      (!currentAsLowAs || !approxEqualMoney(currentAsLowAs, asLowAsNew));

    const needsChange = doDraft || tagOps.doTags || variantUpdates.length > 0 || doMetafield;
    if (needsChange) needChange++;

    const computed = {
      type,
      msrpGross,
      M_net,
      C_net,
      doDraft,
      doTags: tagOps.doTags,
      tags_to_add: tagOps.tags_to_add,
      tags_to_remove: tagOps.tags_to_remove,
      desiredTags: tagOps.desiredTags,
      variantUpdates,
      doMetafield,
      priceNew,
      asLowAsNew,
      needsChange,
      canPriceWrite: (!missingMC && ["used", "standard", "low-margin"].includes(type))
    };

    // Preview
    const pr = previewRow(p, computed);
    previewAll.push(pr);
    if (needsChange) previewChanges.push(pr);

    // For test selection
    if (needsChange && (type === "used" || type === "standard" || type === "low-margin")) {
      changeProductsByType[type].push(p.id);
    }

    // Build import rows
    // Only-changes file: only if needsChange
    if (needsChange) {
      onlyChangesImportRows.push(...buildOnlyChangesRows(p, computed));
    }

    // Full-fixed file: always (but only our 4 fields)
    // IMPORTANT: for missingMC we only write Status=Draft (if needed). No tags/price/metafield.
    fullFixedImportRows.push(...buildFullFixedRows(p, computed));
  }

  // Stats
  console.log(`Stats: totalProducts=${products.size}, needChange=${needChange}, drafted=${drafted}`);
  console.log(`ByType: ${JSON.stringify(byType)}`);

  // Write previews
  writePreviewCsv(path.join(OUT_DIR, "preview.full.csv"), previewAll);
  writePreviewCsv(path.join(OUT_DIR, "preview.only-changes.csv"), previewChanges);
  console.log(`Preview written: out/preview.full.csv + out/preview.only-changes.csv`);

  // Write importable CSVs
  const fullPath = path.join(OUT_DIR, "matrixify.full-fixed.csv");
  const changesPath = path.join(OUT_DIR, "matrixify.only-changes.csv");

  writeCsv(fullPath, IMPORT_HEADERS, fullFixedImportRows);
  writeCsv(changesPath, IMPORT_HEADERS, onlyChangesImportRows);

  console.log(`Import written: out/matrixify.full-fixed.csv (rows=${fullFixedImportRows.length})`);
  console.log(`Import written: out/matrixify.only-changes.csv (rows=${onlyChangesImportRows.length})`);

  // Build TEST file with TEST_SIZE products (mix: standard + low-margin + used)
  const pick = [];
  const wantOrder = ["standard", "low-margin", "used"]; // du wolltest alle 3 Cases
  for (const t of wantOrder) {
    for (const pid of changeProductsByType[t] || []) {
      if (pick.length >= TEST_SIZE) break;
      if (!pick.includes(pid)) pick.push(pid);
    }
    if (pick.length >= TEST_SIZE) break;
  }

  // fallback: wenn zu wenig in einer Gruppe, fülle aus others
  if (pick.length < TEST_SIZE) {
    const all = [...(changeProductsByType.standard || []), ...(changeProductsByType["low-margin"] || []), ...(changeProductsByType.used || [])];
    for (const pid of all) {
      if (pick.length >= TEST_SIZE) break;
      if (!pick.includes(pid)) pick.push(pid);
    }
  }

  const pickSet = new Set(pick);
  const testRows = onlyChangesImportRows.filter(r => pickSet.has(r["ID"]));

  const testPath = path.join(OUT_DIR, `matrixify.test-${TEST_SIZE}.csv`);
  writeCsv(testPath, IMPORT_HEADERS, testRows);

  const testListPath = path.join(OUT_DIR, "test-products.csv");
  fs.writeFileSync(testListPath, ["productId", ...pick].join("\n"));

  console.log(`Test import written: out/matrixify.test-${TEST_SIZE}.csv`);
  console.log(`Test products list: out/test-products.csv`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
