// Parity: lib/travel-core.js against TornBrain's travel.py on the same logs (a private export: never committed).
// Usage: node test/travel_parity.js EXPORT.json
const fs = require("fs");
const T = require("../lib/travel-core.js");
const x = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const price = Object.fromEntries(Object.entries(x.price).map(([k, v]) => [Number(k), v]));
const names = Object.fromEntries(Object.entries(x.names).map(([k, v]) => [Number(k), v]));
const countries = Object.fromEntries(Object.entries(x.countries).map(([k, v]) => [Number(k), v]));
const who = id => x.who[String(id)] || `player ${id}`;
let bad = 0, checked = 0;
const near = (a, b) => (a == null && b == null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 1e-9));
function cmp(path, a, b) {
  if (typeof b === "number" || b == null) {
    checked++;
    if (!near(a, b)) { if (bad++ < 25) console.log(`  ${path}: js ${a} vs py ${b}`); }
    return;
  }
  if (Array.isArray(b)) {
    if (!Array.isArray(a) || a.length !== b.length) { bad++; console.log(`  ${path}: length js ${a && a.length} vs py ${b.length}`); return; }
    b.forEach((v, i) => cmp(`${path}[${i}]`, a[i], v));
    return;
  }
  if (typeof b === "object") { for (const k of Object.keys(b)) cmp(`${path}.${k}`, a ? a[k] : undefined, b[k]); return; }
  checked++;
  if (a !== b) { if (bad++ < 25) console.log(`  ${path}: js ${JSON.stringify(a)} vs py ${JSON.stringify(b)}`); }
}
for (const [d, py] of Object.entries(x.reports)) {
  const days = d === "None" ? null : Number(d);
  const js = T.report(x.logs, days, { now: x.now, price, names, countries, who });
  delete py.landing; delete py.totals.spouse;
  const before = bad;
  cmp(`days=${d}`, js, py);
  console.log(`days=${d}: ${bad - before ? `${bad - before} differences` : "identical"} (trips ${js.totals.trips}, total ${Math.round(js.totals.total)})`);
}
console.log(`${checked} values checked, ${bad} differences`);
process.exit(bad ? 1 : 0);
