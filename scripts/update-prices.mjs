// Weekly Aldi updater for Shop Tally.
// 1. Downloads Aldi UK's in-store range (category by category, page by page, slowly) into catalogue.json.
// 2. Fills prices.json for the items in scripts/items.json, using the catalogue where it can.
// Runs on GitHub Actions (see .github/workflows/update-prices.yml). Needs Node 18+.
import { readFile, writeFile } from "node:fs/promises";

const BASE = "https://api.aldi.co.uk";
const COMMON = "currency=GBP&serviceType=walk-in&servicePoint=C092";
const PAUSE_MS = 3000;            // wait between requests so it never looks like a burst
const PAGE = 30;                  // products per request
const MAX_FAILS_IN_A_ROW = 4;     // stop early if Aldi starts refusing
const HEADERS = { accept: "application/json", "user-agent": "ShopTally-personal-list/1.0 (weekly price check)" };

// Known top-level Aldi UK categories, used if the category tree can't be read
const FALLBACK_CATEGORIES = [
  ["1588161416978053", "Food Cupboard"], ["1588161416978051", "Chilled Food"], ["1588161416978056", "Frozen Food"],
  ["1588161416978049", "Bakery"], ["1588161416978058", "Health & Beauty"], ["1588161416978057", "Baby & Toddler"],
  ["1588161421881163", "Vegetarian & Plant Based"]
];
// Extra searches to fill gaps if the category walk comes back thin
const GAP_TERMS = ["fruit", "vegetables", "potatoes", "salad", "chicken", "beef", "pork", "fish", "bread", "milk", "cheese",
  "yogurt", "eggs", "butter", "juice", "water", "drinks", "coffee", "tea", "crisps", "chocolate", "sweets", "biscuits", "cereal",
  "pasta", "rice", "sauce", "tins", "soup", "frozen", "pizza", "ice cream", "dessert", "baby", "nappies", "wipes", "shampoo",
  "toothpaste", "washing", "cleaning", "toilet", "kitchen roll", "pet", "dog", "cat", "wine", "beer", "spirits", "nuts", "snacks"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lc = s => (s || "").toLowerCase().trim();
let failsInRow = 0, requests = 0;

async function getJSON(url) {
  await sleep(PAUSE_MS);
  requests++;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    failsInRow = 0;
    return j;
  } catch (e) {
    failsInRow++;
    console.log(`  request failed (${e.message}): ${url.replace(BASE, "")}`);
    if (failsInRow >= MAX_FAILS_IN_A_ROW) throw new Error("ALDI_REFUSING");
    return null;
  }
}

function compact(p, catName) {
  if (!p || !p.sku || !p.price || typeof p.price.amount !== "number" || p.discontinued) return null;
  const cat = (p.categories && p.categories[0] && p.categories[0].name) || catName || "";
  const sub = (p.categories && p.categories[1] && p.categories[1].name) || "";
  return { s: p.sku, n: p.name || "", b: p.brandName || "", z: p.sellingSize || "", p: p.price.amount, c: cat, d: sub };
}

// Walk any category tree shape and return the top-level [id, name] pairs
function topCategories(tree) {
  const arr = Array.isArray(tree) ? tree : (tree && (tree.data || tree.categories || tree.children || tree.items)) || [];
  const out = [];
  for (const node of arr) {
    const id = node && (node.id || node.key);
    const name = node && (node.name || node.label || node.localizedName);
    if (id && name) out.push([String(id), name]);
  }
  return out;
}

async function pageThrough(query, catName, into) {
  let offset = 0, total = Infinity, added = 0;
  while (offset < total && offset < 3000) {
    const j = await getJSON(`${BASE}/v3/product-search?${COMMON}&${query}&limit=${PAGE}&offset=${offset}&sort=name_asc`);
    if (!j) break;
    total = (j.meta && j.meta.pagination && j.meta.pagination.totalCount) || 0;
    const data = Array.isArray(j.data) ? j.data : [];
    if (!data.length) break;
    for (const p of data) { const c = compact(p, catName); if (c && !into.has(c.s)) { into.set(c.s, c); added++; } }
    offset += PAGE;
  }
  return added;
}

async function buildCatalogue() {
  const products = new Map();
  let cats = [];
  const tree = await getJSON(`${BASE}/v2/product-category-tree?${COMMON}`);
  cats = topCategories(tree);
  if (!cats.length) { console.log("Category tree not readable; using known categories."); cats = FALLBACK_CATEGORIES; }
  console.log(`Walking ${cats.length} categories...`);
  for (const [id, name] of cats) {
    const n = await pageThrough(`categoryTree=${encodeURIComponent(id)}`, name, products);
    console.log(`  ${name}: +${n} (total ${products.size})`);
  }
  if (products.size < 2500) {
    console.log(`Only ${products.size} products from categories; filling gaps with searches...`);
    for (const t of GAP_TERMS) {
      const n = await pageThrough(`q=${encodeURIComponent(t)}`, "", products);
      console.log(`  "${t}": +${n} (total ${products.size})`);
    }
  }
  return products;
}

export function pick(item, products) {
  // products: compact entries {s,n,b,z,p}
  if (item.name) {
    return products.find(p => lc(p.n) === lc(item.name)
      && (!item.brand || lc(p.b) === lc(item.brand))
      && (!item.size || lc(p.z) === lc(item.size))) || null;
  }
  if (item.match) {
    const re = new RegExp(item.match, "i");
    return products.find(p => re.test(p.n)) || null;
  }
  return null;
}

const tidyBrand = b => (b || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

async function main() {
  const { items } = JSON.parse(await readFile("scripts/items.json", "utf8"));
  let oldPrices = { items: {} };
  try { oldPrices = JSON.parse(await readFile("prices.json", "utf8")); } catch {}

  let catalogue = new Map(), stopped = false;
  try { catalogue = await buildCatalogue(); }
  catch (e) { if (e.message === "ALDI_REFUSING") { stopped = true; console.log("Aldi is refusing requests; stopping early."); } else throw e; }

  const list = [...catalogue.values()];
  if (list.length >= 500) {
    list.sort((a, b) => a.n.localeCompare(b.n));
    await writeFile("catalogue.json", JSON.stringify({ updated: new Date().toISOString(), count: list.length, products: list }) + "\n");
    console.log(`Saved catalogue.json with ${list.length} products.`);
  } else {
    console.log(`Catalogue too small (${list.length}); keeping last week's catalogue.json.`);
  }

  // Prices for the tracked items: catalogue first, then a direct search for any misses
  const out = {};
  let found = 0, changed = 0;
  failsInRow = 0;
  for (const item of items) {
    let p = pick(item, list);
    if (!p && !stopped) {
      try {
        const j = await getJSON(`${BASE}/v3/product-search?${COMMON}&q=${encodeURIComponent(item.q)}&limit=24&offset=0&sort=relevance`);
        const res = (j && Array.isArray(j.data) ? j.data : []).map(x => compact(x)).filter(Boolean);
        p = pick(item, res);
      } catch (e) { stopped = true; }
    }
    if (p) {
      found++;
      const entry = { price: p.p, sku: p.s };
      if (item.match) { entry.name = p.n; entry.brand = tidyBrand(p.b); entry.size = p.z; }
      if (!oldPrices.items[item.id] || oldPrices.items[item.id].price !== entry.price) changed++;
      out[item.id] = entry;
    } else if (oldPrices.items[item.id]) {
      out[item.id] = oldPrices.items[item.id];
    }
  }
  if (found > 0) {
    await writeFile("prices.json", JSON.stringify({ updated: new Date().toISOString(), source: "aldi.co.uk catalogue", items: out }, null, 1) + "\n");
  }
  console.log(`Tracked items: ${found}/${items.length} found, ${changed} price changes. ${requests} requests made.`);
  if (found === 0 && list.length < 500) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
