// Weekly Aldi shelf-price updater for Shop Tally.
// Looks up each product in scripts/items.json one at a time, slowly, and writes prices.json.
// Runs on GitHub Actions (see .github/workflows/update-prices.yml). Needs Node 18+.
import { readFile, writeFile } from "node:fs/promises";

const API = "https://api.aldi.co.uk/v3/product-search";
const PAUSE_MS = 4000;          // wait between searches so we never look like a burst
const MAX_FAILS_IN_A_ROW = 3;   // stop early if Aldi starts refusing

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lc = s => (s || "").toLowerCase().trim();

async function search(q) {
  const url = `${API}?currency=GBP&serviceType=walk-in&q=${encodeURIComponent(q)}&limit=24&offset=0&sort=relevance&servicePoint=C092`;
  const res = await fetch(url, { headers: { "accept": "application/json", "user-agent": "ShopTally-personal-list/1.0 (weekly price check)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.data) ? json.data : [];
}

export function pick(item, products) {
  const live = products.filter(p => p && p.price && typeof p.price.amount === "number" && !p.discontinued);
  if (item.name) {
    return live.find(p => lc(p.name) === lc(item.name)
      && (!item.brand || lc(p.brandName) === lc(item.brand))
      && (!item.size || lc(p.sellingSize) === lc(item.size))) || null;
  }
  if (item.match) {
    const re = new RegExp(item.match, "i");
    return live.find(p => re.test(p.name || "")) || null;
  }
  return null;
}

function tidyBrand(b) { return (b || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }

async function main() {
  const { items } = JSON.parse(await readFile("scripts/items.json", "utf8"));
  let old = { items: {} };
  try { old = JSON.parse(await readFile("prices.json", "utf8")); } catch {}

  const out = {};
  let found = 0, failsInRow = 0, changed = 0;
  for (const item of items) {
    try {
      const p = pick(item, await search(item.q));
      failsInRow = 0;
      if (p) {
        found++;
        const entry = { price: p.price.amount, sku: p.sku };
        if (item.match) { entry.name = p.name; entry.brand = tidyBrand(p.brandName); entry.size = p.sellingSize || ""; }
        if (!old.items[item.id] || old.items[item.id].price !== entry.price) changed++;
        out[item.id] = entry;
        console.log(`ok   ${item.id.padEnd(5)} ${(p.name || "").slice(0, 40).padEnd(40)} £${(p.price.amount / 100).toFixed(2)}`);
      } else {
        if (old.items[item.id]) out[item.id] = old.items[item.id];   // keep last known price
        console.log(`miss ${item.id.padEnd(5)} no match for "${item.q}"`);
      }
    } catch (e) {
      failsInRow++;
      if (old.items[item.id]) out[item.id] = old.items[item.id];
      console.log(`fail ${item.id.padEnd(5)} ${e.message}`);
      if (failsInRow >= MAX_FAILS_IN_A_ROW) {
        console.log("Aldi is refusing requests; stopping and keeping last week's prices.");
        for (const it of items) if (!(it.id in out) && old.items[it.id]) out[it.id] = old.items[it.id];
        break;
      }
    }
    await sleep(PAUSE_MS);
  }

  if (found === 0) { console.log("Nothing found this run; prices.json left unchanged."); process.exitCode = 1; return; }
  const next = { updated: new Date().toISOString(), source: "aldi.co.uk catalogue", items: out };
  await writeFile("prices.json", JSON.stringify(next, null, 1) + "\n");
  console.log(`Done: ${found}/${items.length} found, ${changed} price changes.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
