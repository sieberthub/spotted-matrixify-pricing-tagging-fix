import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const IN_CANDIDATES = [
  "data/matrixify/Products.csv",
  "data/matrixify/products.csv",
];

const OUT_DIR = "out";
fs.mkdirSync(OUT_DIR, { recursive: true });

// --- Arigato constants ---
const T_VAT = 0.20;

// ---------- CSV helpers ----------
function detectDelimiter(line) {
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  return semis > commas ? ";" : ",";
}

function stripBom(s) {
  return String(s ?? "").replace(/^\uFEFF/, "");
}

// minimal CSV line parser (handles quotes + delimiter; assumes no embedded newlines in fields)
function parseCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }

    if (!inQ && ch === delim) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }
  out.push(cur);
  return out;
}

function normHeader(h) {
  return stripBom(String(h ?? "")).trim().toLowerCase();
}

function toNumberOrNull(x) {
  const n = Number(String(x ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function approxEqualMoney(a, b) {
  const na = toNumberOrNull(a);
  const nb = toNumberOrNull(b);
  if (!(na > -Infinity) || !(nb > -Infinity)) return false;
  return Math.abs(na - nb) < 0.005;
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r") || s.includes(";")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function writeCsv(filePath, headers, rows) {
  const delim = ",";
  const lines = [];
  lines.push(headers.map(csvEscape).join(delim));
  for (const r of rows) {
    lines.push(headers.map(h => csvEscape(r[h] ?? "")).join(delim));
  }
  fs.writeFileSync(filePath, lines.join("\n"));
}

// ---------- Arigato logic ----------
function normTag(t) {
  return String(t || "").toLowerCase().trim();
}

function parseTags(tagsCell) {
  const raw = String(tagsCell ?? "").trim();
  if (!raw) return [];
  // Matrixify export is typically "tag1, tag2"
  return raw.split(",").map(x => x.trim()).filter(Boolean);
}

function hasUsedGateway(tagsArr) {
  const lower = (tagsArr || []).map(normTag);
  return lower.includes("preowned / defect") || lower.includes("preloved");
}

function determineTypeArigato(M_net, C_net, tagsArr) {
  if (!(M_net > 0) || !(C_net > 0)) return "skip";
  if (hasUsedGateway(tagsArr)) return "used";

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

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function round2(x) { return Math.round(x * 100) / 100; }

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

const TYPE_TAGS = ["used", "standard", "low-margin"];

function computeTagDiff(currentTagsArr, desiredType) {
  const cur = currentTagsArr || [];
  const curLower = cur.map(normTag);

  const tags_to_add = [];
  const tags_to_remove = [];

  if (!TYPE_TAGS.includes(desiredType)) {
    return { desiredTagsArr: cur, tags_to_add, tags_to_remove, doTags: false };
  }

  if (!curLower.includes(desiredType)) tags_to_add.push(desiredType);

  for (const t of TYPE_TAGS) {
    if (t !== desiredType && curLower.includes(t)) tags_to_remove.push(t);
  }

  const doTags = tags_to_add.length > 0 || tags_to_remove.length > 0;

  // desired full tag list (remove all type tags, add desired one)
  const cleaned = cur.filter(t => !TYPE_TAGS.includes(normTag(t)));
  const desiredTagsArr = cleaned.slice();
  if (!cleaned.map(normTag).includes(desiredType)) desiredTagsArr.push(desiredType);

  return { desiredTagsArr, tags_to_add, tags_to_remove, doTags };
}

// ---------- Input resolve ----------
function findInput() {
  for (const p of IN_CANDIDATES) {
    const abs = path.resolve(p);
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error(
    `Matrixify CSV nicht gefunden.\nErwartet unter:\n- ${IN_CANDIDATES.join("\n- ")}`
  );
}

async function main() {
  const inputPath = findInput();
  console.log("✅ Using input:", inputPath);

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let header = null;
  let delim = ",";
  let idx = {};
  let metafieldColName = null;

  // group by product id
  const products = new Map();

  for await (const rawLine of rl) {
    const line0 = stripBom(rawLine);
    if (!line0.trim()) continue;

    if (!header) {
      delim = detectDelimiter(line0);
      header = parseCsvLine(line0, delim).map(h => stripBom(h).replace(/^"|"$/g, ""));
      const headerNorm = header.map(normHeader);

      // find metafield column by prefix (exact column exists in your export)
      for (let i = 0; i < header.length; i++) {
        const hn = headerNorm[i];
        if (hn.startsWith("metafield: spotted.as_low_as")) {
          metafieldColName = header[i];
        }
      }

      const mustHave = ["id", "tags", "status", "variant id", "variant position", "variant price", "variant compare at price", "variant cost"];
      const missing = mustHave.filter(k => !headerNorm.includes(normHeader(k)));
      if (missing.length) {
        console.log("Headers detected (first 50):", header.slice(0, 50));
        throw new Error(`Spalten fehlen in CSV: ${missing.map(x => `"${x}"`).join(", ")}`);
      }

      const indexOf = (name) => headerNorm.indexOf(normHeader(name));
      idx = {
        ID: indexOf("ID"),
        HANDLE: headerNorm.indexOf("handle"),
        COMMAND: headerNorm.indexOf("command"),
        TITLE: headerNorm.indexOf("title"),
        TAGS: headerNorm.indexOf("tags"),
        TAGS_COMMAND: headerNorm.indexOf("tags command"),
        STATUS: headerNorm.indexOf("status"),
        VARIANT_ID: indexOf("Variant ID"),
        VARIANT_COMMAND: headerNorm.indexOf("variant command"),
        VARIANT_POS: indexOf("Variant Position"),
        VARIANT_PRICE: indexOf("Variant Price"),
        VARIANT_COMPARE: indexOf("Variant Compare At Price"),
        VARIANT_COST: indexOf("Variant Cost"),
        MF_ASLOWAS: metafieldColName ? headerNorm.indexOf(normHeader(metafieldColName)) : -1,
      };

      console.log(`✅ Header ok. Delimiter="${delim}". Metafield col="${metafieldColName ?? "NOT FOUND"}"`);
      continue;
    }

    const cells = parseCsvLine(line0, delim);

    const productId = (cells[idx.ID] ?? "").trim().replace(/^"|"$/g, "");
    if (!productId) continue;

    const tagsCell = cells[idx.TAGS] ?? "";
    const status = (cells[idx.STATUS] ?? "").trim().replace(/^"|"$/g, "");
    const title = (cells[idx.TITLE] ?? "").trim().replace(/^"|"$/g, "");
    const handle = (cells[idx.HANDLE] ?? "").trim().replace(/^"|"$/g, "");

    const variantId = (cells[idx.VARIANT_ID] ?? "").trim().replace(/^"|"$/g, "");
    const pos = toNumberOrNull(cells[idx.VARIANT_POS]) ?? 999999;
    const price = toNumberOrNull(cells[idx.VARIANT_PRICE]);
    const compareAt = toNumberOrNull(cells[idx.VARIANT_COMPARE]);
    const cost = toNumberOrNull(cells[idx.VARIANT_COST]);

    const asLowAsCurrent = (idx.MF_ASLOWAS >= 0 ? (cells[idx.MF_ASLOWAS] ?? "") : "").trim().replace(/^"|"$/g, "");

    if (!products.has(productId)) {
      products.set(productId, {
        productId,
        title,
        handle,
        status,
        tagsArr: parseTags(tagsCell),
        tagsRaw: tagsCell,
        asLowAsCurrent,
        variants: [],
      });
    }

    const p = products.get(productId);
    p.variants.push({ variantId, pos, price, compareAt, cost });
    // keep first seen values stable
    if (!p.title && title) p.title = title;
    if (!p.handle && handle) p.handle = handle;
    if (!p.status && status) p.status = status;
    if (!p.tagsRaw && tagsCell) { p.tagsRaw = tagsCell; p.tagsArr = parseTags(tagsCell); }
    if (!p.asLowAsCurrent && asLowAsCurrent) p.asLowAsCurrent = asLowAsCurrent;
  }

  console.log(`2) Parsed products: ${products.size}`);

  // decide changes
  const previewFull = [];
  const previewOnly = [];
  const importOnlyChangesRows = [];
  const changeItems = [];

  let drafted = 0;
  const byType = { used: 0, standard: 0, "low-margin": 0, skip: 0 };

  // Output headers for Matrixify import (minimal + safe)
  const importHeaders = [
    "ID",
    "Command",
    "Tags",
    "Tags Command",
    "Status",
    "Variant ID",
    "Variant Command",
    "Variant Price",
    (metafieldColName ?? "Metafield: spotted.as_low_as [number_decimal]"),
  ];

  for (const p of products.values()) {
    // base variant deterministisch: kleinste Variant Position (wie Shopify “first variant”)
    const base = p.variants.reduce((best, v) => (!best || v.pos < best.pos) ? v : best, null);

    const msrpGross = base?.compareAt ?? 0;
    const M_net = msrpGross > 0 ? (msrpGross / (1 + T_VAT)) : 0;
    const C_net = base?.cost ?? 0;

    const missingMC = !(M_net > 0 && C_net > 0);
    const doDraft = missingMC && String(p.status || "").toLowerCase() !== "draft";
    if (doDraft) drafted++;

    const desiredType = missingMC ? "skip" : determineTypeArigato(M_net, C_net, p.tagsArr);
    byType[desiredType] = (byType[desiredType] || 0) + 1;

    const pricing = (!missingMC && TYPE_TAGS.includes(desiredType))
      ? computePricing(M_net, C_net, desiredType)
      : { ok: false };

    const desiredPriceNew = pricing.ok ? pricing.price_new : null;
    const desiredAsLowAs = (pricing.ok && desiredType === "standard" && pricing.as_low_as > 0)
      ? pricing.as_low_as
      : null;

    const tagDiff = (!missingMC && TYPE_TAGS.includes(desiredType))
      ? computeTagDiff(p.tagsArr, desiredType)
      : { desiredTagsArr: p.tagsArr, tags_to_add: [], tags_to_remove: [], doTags: false };

    // price changes: Arigato setzt alle Varianten auf denselben Preis_new
    const variantsToUpdate = [];
    if (!missingMC && desiredPriceNew != null) {
      for (const v of p.variants) {
        if (v.variantId && !approxEqualMoney(v.price, desiredPriceNew)) {
          variantsToUpdate.push(v.variantId);
        }
      }
    }
    const doPrice = variantsToUpdate.length > 0;

    // metafield change: nur Standard
    const currentMf = toNumberOrNull(p.asLowAsCurrent);
    const doMetafield =
      !missingMC &&
      desiredType === "standard" &&
      desiredAsLowAs != null &&
      !(currentMf != null && approxEqualMoney(currentMf, desiredAsLowAs));

    const needsChange = doDraft || tagDiff.doTags || doPrice || doMetafield;

    const rowPrev = {
      productId: p.productId,
      title: p.title,
      handle: p.handle,
      status_current: p.status,
      doDraft,
      type: desiredType,
      msrp_gross: msrpGross ? round2(msrpGross) : "",
      M_net: M_net ? round2(M_net) : "",
      C_net: C_net ? round2(C_net) : "",
      price_old: base?.price ?? "",
      price_new: desiredPriceNew ?? "",
      as_low_as_old: p.asLowAsCurrent ?? "",
      as_low_as_new: desiredAsLowAs ?? "",
      tags_to_add: tagDiff.tags_to_add.join("|"),
      tags_to_remove: tagDiff.tags_to_remove.join("|"),
      doTags: tagDiff.doTags,
      doPrice,
      doMetafield,
      needsChange,
    };

    previewFull.push(rowPrev);
    if (needsChange) previewOnly.push(rowPrev);

    if (!needsChange) continue;

    changeItems.push({
      productId: p.productId,
      type: desiredType,
      doDraft,
      doTags: tagDiff.doTags,
      desiredTagsArr: tagDiff.desiredTagsArr,
      doPrice,
      desiredPriceNew,
      variantsToUpdate,
      doMetafield,
      desiredAsLowAs,
      currentAsLowAs: p.asLowAsCurrent ?? "",
    });

    // --- Build Matrixify import rows for this product ---
    // Primary row carries product-level updates + (optional) base variant price update
    const primaryVariantId = base?.variantId || (p.variants[0]?.variantId ?? "");

    // Metafield safety: if NOT changing metafield, keep existing value (if any) to avoid accidental clear
    const mfCell =
      doMetafield
        ? String(desiredAsLowAs)
        : (p.asLowAsCurrent ? String(p.asLowAsCurrent) : "");

    const tagsCellOut = tagDiff.doTags ? tagDiff.desiredTagsArr.join(", ") : "";
    const tagsCmdOut = tagDiff.doTags ? "REPLACE" : "";

    const primaryHasPriceUpdate = doPrice && primaryVariantId && variantsToUpdate.includes(primaryVariantId);

    importOnlyChangesRows.push({
      "ID": p.productId,
      "Command": "UPDATE",
      "Tags": tagsCellOut,
      "Tags Command": tagsCmdOut,
      "Status": doDraft ? "Draft" : "",
      "Variant ID": primaryVariantId,
      "Variant Command": primaryHasPriceUpdate ? "UPDATE" : "",
      "Variant Price": primaryHasPriceUpdate ? String(desiredPriceNew) : "",
      [importHeaders[8]]: mfCell,
    });

    // Additional rows for remaining variants needing price change
    if (doPrice) {
      for (const vid of variantsToUpdate) {
        if (!vid || vid === primaryVariantId) continue;
        importOnlyChangesRows.push({
          "ID": p.productId,
          "Command": "UPDATE",
          "Tags": "",
          "Tags Command": "",
          "Status": "",
          "Variant ID": vid,
          "Variant Command": "UPDATE",
          "Variant Price": String(desiredPriceNew),
          [importHeaders[8]]: mfCell, // keep current/new value stable across rows
        });
      }
    }
  }

  // --- Write previews ---
  const prevFullPath = path.join(OUT_DIR, "preview.full.csv");
  const prevOnlyPath = path.join(OUT_DIR, "preview.only-changes.csv");

  const prevHeaders = Object.keys(previewFull[0] || {});
  writeCsv(prevFullPath, prevHeaders, previewFull);
  writeCsv(prevOnlyPath, prevHeaders, previewOnly);

  // --- Write Matrixify import files ---
  const importOnlyPath = path.join(OUT_DIR, "matrixify.import.only-changes.csv");
  writeCsv(importOnlyPath, importHeaders, importOnlyChangesRows);

  // --- Build 20-product test import (stratified by type) ---
  const pick = (arr, n) => arr.slice(0, n);
  const used = changeItems.filter(x => x.type === "used");
  const std = changeItems.filter(x => x.type === "standard");
  const lm = changeItems.filter(x => x.type === "low-margin");

  const picked = [
    ...pick(std, 8),
    ...pick(lm, 6),
    ...pick(used, 6),
  ].slice(0, 20);

  const pickedIds = new Set(picked.map(x => x.productId));
  const testRows = importOnlyChangesRows.filter(r => pickedIds.has(r["ID"]));

  const testPath = path.join(OUT_DIR, "matrixify.import.test-20.csv");
  writeCsv(testPath, importHeaders, testRows);

  console.log(`Stats: totalProducts=${products.size}, needChange=${changeItems.length}, drafted=${drafted}`);
  console.log(`ByType: ${JSON.stringify(byType)}`);
  console.log(`✅ Wrote: ${prevFullPath}`);
  console.log(`✅ Wrote: ${prevOnlyPath}`);
  console.log(`✅ Wrote: ${importOnlyPath}`);
  console.log(`✅ Wrote: ${testPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
