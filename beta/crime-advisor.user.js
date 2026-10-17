// ==UserScript==
// @name         Crime Advisor ($/nerve)
// @namespace    ajthesecond.crime-advisor
// @version      2.1.17
// @description  Grades every option on Torn's crime pages by your own $/nerve (S/A/B/C), with a card per option (odds, top items, arson recipes, disposal method) and your best crimes. Everything stays in your browser.
// @author       AJTheSecond [3395781]
// @homepageURL  https://tornbrain.com/
// @updateURL    https://tornbrain.com/beta/crime-advisor.user.js
// @downloadURL  https://tornbrain.com/beta/crime-advisor.user.js
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @connect      balaclava.app
// @run-at       document-idle
// ==/UserScript==

/*
 * What it does
 *   - Grades: on Torn's crime pages, a chip on each arson job, scam type, search spot, shop, document... gives its grade
 *     and YOUR $/nerve for it (from your own crime logs): S the best on show and above your average across crimes,
 *     A above your average, B half to all of it, C under half, a cross for losing money, ? for little history yet.
 *   - Cards: tap a chip for its card: the number, your odds as one bar, the top items, the arson recipe (with a Lighter
 *     where the Flamethrower would fail the job), the disposal method to use; "More" for the details.
 *   - Best crimes: the panel (bottom left) lists the best options on this page (tap to find one) and the crimes that
 *     pay you more elsewhere. A crime's result shows what its items are worth.
 *   - Arson works even without an API key: requirements, community recipes and "fell short" warnings.
 *
 * Your data
 *   - Your API key is stored by Tampermonkey in this browser and only ever sent to api.torn.com.
 *   - Your crime logs are copied into this browser's storage (IndexedDB) so it doesn't re-download them. The text of
 *     each crime page you visit is kept there too (for Best crimes). Nothing is sent anywhere else. The community
 *     recipes are downloaded from balaclava.app (public data).
 *   - Key: a Custom key with only "log" is enough (Torn requires log access to read crime logs). Torn's form has no
 *     Custom option: the panel's "Make a key" link opens it pre-filled (logs + item prices).
 *
 * Read-only: it never clicks, commits a crime or does anything in Torn for you.
 */

/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_info, PDA_httpGet, module */

// ======================================================================================================
// The analysis (pure functions: no browser APIs, so it can be tested outside Torn)
// ======================================================================================================
const CA = (() => {
  "use strict";
  const DAY = 86400;
  const ARSON = 13, SCAMMING = 12, FORGERY = 11, DISPOSAL = 9, BURGLARY = 7;
  // Burglary: the nerve to scout for a property type of your choice, or for any of a kind (TornBrain's crimes.py)
  const SCOUT_FOCUSED = 9, SCOUT_ANY = 3;
  const ARSON_EXPIRE = 7 * DAY, SCAM_EXPIRE = DAY, SCAM_LOST_AFTER = 3600, MIN_NERVE = 30;
  const NAMES = { 1: "Search for Cash", 2: "Bootlegging", 3: "Graffiti", 4: "Shoplifting", 5: "Pickpocketing", 6: "Card Skimming",
                  7: "Burglary", 8: "Hustling", 9: "Disposal", 10: "Cracking", 11: "Forgery", 12: "Scamming", 13: "Arson" };
  // Crimes whose every step names what it's done to: $/nerve by that is meaningful. In the others the money lands
  // on a different step than the nerve (skimming pays when you sell the details), so they're valued as a whole.
  const SKILL_TAB = { skimming: "cardskimming" };  // (skill logs that name a crime differently from its page)
  const KIND_CRIMES = new Set([1, 3, 4, 5, 9, 11]);
  const J = String.raw`an? (?<d>.+\(.+\))`;
  const R = (p, crime, action) => [new RegExp(p, "i"), crime, action];
  const RULES = [
    R(`^breaching ${J}$`, ARSON, "Make entry"), R(`^placing a combustible at ${J}$`, ARSON, "Place combustible"),
    R(`^igniting ${J}$`, ARSON, "Ignite"), R(`^stoking ${J}$`, ARSON, "Stoke"), R(`^dampening ${J}$`, ARSON, "Dampen"),
    R(`^planting evidence at ${J}$`, ARSON, "Plant evidence"),
    R(String.raw`^collecting the reward for the (?<d>.+) Arson job$`, ARSON, "Collect"),
    R(String.raw`^farming email addresses$`, SCAMMING, "Farm emails"),
    R(String.raw`^sending out an? (?<d>.+?) spam wave$`, SCAMMING, "Spam wave"),
    R(String.raw`^responding to an? (?<d>.+?) target$`, SCAMMING, "Respond"),
    R(String.raw`^stencil cutting for an? (?<d>.+)$`, FORGERY, "Stencil cutting"),
    R(String.raw`^painting the letters of an? (?<d>.+)$`, FORGERY, "Painting letters"),
    R(String.raw`^(?<a>drafting|typewriting|printing|signing|sealing|stamping|laminating|embossing|forging|designing|cutting|perforating|rubbing|pressing|painting|drilling|engraving|punching|mold forming|casting|filing|polishing|framing|programming|branding|holographing|gluing) an? (?<d>.+)$`, FORGERY, ""),
    R(String.raw`^extracting a chip for an? (?<d>.+)$`, FORGERY, "Extract chip"), R(String.raw`^embedding a chip into an? (?<d>.+)$`, FORGERY, "Embed chip"),
    R(String.raw`^setting up an online store$`, 2, "Set up online store"), R(String.raw`^collecting funds from an online store$`, 2, "Collect online store"),
    R(String.raw`^(?<a>abandoning|burying|burning|dissolving|sinking|feeding|cremating|dumping) (?<d>.+)$`, DISPOSAL, ""),
    R(String.raw`^(?<a>brute forcing|cracking) an? (?<d>.+)$`, 10, ""),
    R(String.raw`^gathering audience`, 8, "Gather audience"), R(String.raw`^introducing (?<d>.+)$`, 8, "Introduce game"),
    R(String.raw`^winning on (?<d>.+)$`, 8, "Win"), R(String.raw`^losing (?:on )?(?<d>.+)$`, 8, "Lose"),
    R(String.raw`^shoplifting from (?<d>.+)$`, 4, "Shoplift"), R(String.raw`^searching (?:the |an? )?(?<d>.+)$`, 1, "Search"),
    R(String.raw`^pickpocketing an? (?<d>.+)$`, 5, "Pickpocket"), R(String.raw`^scouting for (?:an? )?(?<d>.+)$`, 7, "Scout"),
    R(String.raw`^casing an? (?<d>.+)$`, 7, "Case"), R(String.raw`^burgling an? (?<d>.+)$`, 7, "Burgle"),
    R(String.raw`^(?<a>installing|recovering|retrieving) an? (?:card )?skimmer(?: at an?)? ?(?<d>.*)$`, 6, ""),
    R(String.raw`^selling card details`, 6, "Sell card details"), R(String.raw`.*(skimm|card details)`, 6, "Other"),
    R(String.raw`^spraying graffiti in (?:the )?(?<d>.+)$`, 3, "Spray"),  // "spraying graffiti in the Red-Light District"
    R(String.raw`.*(graffiti|spray|tagging)`, 3, "Other"), R(String.raw`.*(dvd|bootleg)`, 2, "Other"),
  ];
  // Log types that aren't actions (no nerve) but belong to a crime; and the ones that used up materials.
  const EVENT_CRIME = { 9360: ARSON, 9361: ARSON, 9362: ARSON, 9356: SCAMMING, 9309: FORGERY, 9310: FORGERY, 9300: 2, 9308: 2,
                        9301: 3, 9350: 3, 9351: 3, 9302: 6, 9303: 6, 9304: 9, 9305: 10, 9306: 10, 9307: 10 };
  const COST_TYPES = new Set([9361, 9310, 9309, 9300, 9301, 9304]);

  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  function classify(action) {
    const a = action.trim();
    for (const [rx, crime, label] of RULES) {
      const m = a.match(rx);
      if (m) {
        const g = m.groups || {};
        let detail = (g.d || "").trim();
        if (crime === DISPOSAL) detail = cap(detail.replace(/^(a|an|some|the) /i, ""));  // "some general waste": the page's General Waste
        return { crime, action: label || cap(g.a || ""), detail };
      }
    }
    return { crime: null, action: a, detail: "" };
  }
  const resultOf = t => (t = (t || "").toLowerCase()).includes("critical fail") ? "crit" : t.includes("fail") ? "fail" : "success";
  function* items(d, keys = ["items_used", "items_added", "items_gained"]) {
    for (const k of keys) {
      const v = d[k];
      if (v && typeof v === "object") for (const [id, n] of Object.entries(v)) if (/^\d+$/.test(id)) yield [Number(id), Number(n) || 1];
    }
  }

  // Log rows (as stored) -> events, oldest first, classified.
  function load(rows) {
    return rows.slice().sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)).map(r => {
      const e = { id: r.id, ts: r.ts, type: r.type, title: r.title, d: r.d || {} };
      if (e.d.crime_action) {
        Object.assign(e, classify(e.d.crime_action));
        e.result = resultOf(r.title);
        e.nerve = e.d.nerve || 0;
        e.money = (e.d.money_gained || 0) - (e.d.money_lost || 0);
        e.unique = e.d.unique === "(unique)";  // a one-time outcome: it never pays again
        e.isStep = true;
      } else e.crime = EVENT_CRIME[r.type] ?? null;
      return e;
    });
  }

  // Each arson job from inquire/breach to collect. Items land within a second or two of a step, so they're that step's
  // job's, filed by step: fuel placed, fuel stoked with (by stoke), evidence planted. Steps often share those seconds
  // (one job placed while another burns), so a known fuel goes to the nearest place or stoke, anything else to the
  // nearest planting. The Lighter and Flamethrower are kept, never logged as used: how a job was lit isn't in the logs.
  const FUELS = new Set(["Gasoline", "Kerosene", "Diesel", "Hydrogen Tank", "Methane Tank", "Oxygen Tank", "Thermite", "Magnesium Shavings", "Potassium Nitrate"]);
  const USES_ITEMS = ["Place combustible", "Plant evidence", "Stoke"];
  function arsonJobs(events, price, now, names = {}) {
    const jobs = [], open = new Map(), stepAt = new Map();
    for (const e of events) if (e.crime === ARSON && e.isStep && e.detail) (stepAt.get(e.ts) || stepAt.set(e.ts, []).get(e.ts)).push([e.detail, e.action, e.ts]);
    const close = (j, state, ts) => { j.state = state; j.closed = ts; open.delete(j.job); };
    for (const e of events) {
      if (e.crime !== ARSON) continue;
      if (COST_TYPES.has(e.type)) {
        const near = [0, -1, 1, -2, 2].flatMap(dt => stepAt.get(e.ts + dt) || []);
        for (const [i, n] of items(e.d, ["items_used"])) {
          const nm = names[i];
          const want = !nm ? USES_ITEMS : FUELS.has(nm) ? ["Place combustible", "Stoke"] : ["Plant evidence"];
          const step = near.find(s => want.includes(s[1])) || near.find(s => USES_ITEMS.includes(s[1])) || near[0];
          const j = step ? open.get(step[0]) : [...open.values()].sort((a, b) => b.last - a.last)[0];
          if (!j) continue;
          j.itemCost += (price[i] || 0) * n;
          const act = step ? step[1] : null;
          let bucket;
          if (act === "Plant evidence" || (!USES_ITEMS.includes(act) && nm && !FUELS.has(nm))) bucket = j.evidence;
          else if (act === "Stoke" || (act !== "Place combustible" && j.lit)) bucket = j.stokeFuel[act === "Stoke" ? step[2] : e.ts] ||= {};
          else bucket = j.place;
          bucket[i] = (bucket[i] || 0) + n;
        }
        continue;
      }
      const job = e.detail || (e.type === 9360 ? e.d.target : null);
      if (!job) continue;
      const starts = e.type === 9360 || e.action === "Make entry";
      let j = open.get(job);
      if (j && (e.ts - j.last > ARSON_EXPIRE || (starts && j.worked))) { close(j, "expired", j.last); j = null; }
      if (!j) {
        j = { job, opened: e.ts, last: e.ts, closed: null, state: "open", nerve: 0, steps: 0, money: 0, itemCost: 0, worked: false,
              lit: false, ignited: null, stokes: 0, stokeTs: [], dampens: 0, place: {}, stokeFuel: {}, evidence: {}, unique: false };
        jobs.push(j); open.set(job, j);
      }
      j.last = e.ts;
      if (e.isStep) {
        j.nerve += e.nerve; j.steps += 1; j.money += e.money;
        j.unique = j.unique || e.unique;  // (arson's come on the collect: a one-time payout)
        j.worked = j.worked || e.action !== "Make entry";
        if (e.action === "Ignite" && e.result === "success" && !j.lit) { j.lit = true; j.ignited = e.ts; }
        if (e.action === "Stoke") j.stokeTs.push(e.ts);
        j.stokes += e.action === "Stoke"; j.dampens += e.action === "Dampen";
        if (e.action === "Collect" && e.result === "success") close(j, "paid", e.ts);
      }
    }
    for (const j of [...open.values()]) if (now - j.last > ARSON_EXPIRE) close(j, "expired", j.last);
    for (const j of jobs) if (j.state === "expired" && !j.steps) j.state = "skipped";
    return jobs;
  }

  // Each scam conversation from reading the email to the payout (responses go to the newest open one per method).
  function scamConversations(events, now) {
    const convs = [], stacks = new Map();
    const stack = m => stacks.get(m) || stacks.set(m, []).get(m);
    const close = (c, state, ts) => { c.state = state; c.closed = ts; const s = stack(c.method); s.splice(s.indexOf(c), 1); };
    const sweep = (m, ts) => { for (const c of [...stack(m)]) {
      if (c.state === "failing" && ts - c.last > SCAM_LOST_AFTER) close(c, "lost", c.last);
      else if (ts - c.last > SCAM_EXPIRE) close(c, "expired", c.last);
    } };
    const conv = (m, target, ts) => { const c = { method: m, target, opened: ts, last: ts, closed: null, state: "open", responses: 0, nerve: 0, money: 0 }; convs.push(c); stack(m).push(c); return c; };
    for (const e of events) {
      if (e.crime !== SCAMMING) continue;
      if (e.type === 9356) {
        const m = e.d.method || "?";
        sweep(m, e.ts);
        const st = stack(m);
        if (st.length && st[st.length - 1].state === "failing") close(st[st.length - 1], "lost", st[st.length - 1].last);
        conv(m, e.d.target, e.ts);
        continue;
      }
      if (e.action !== "Respond") continue;
      const m = e.detail;
      sweep(m, e.ts);
      const st = stack(m);
      while (st.length && st[st.length - 1].state === "failing" && e.result !== "success") close(st[st.length - 1], "lost", st[st.length - 1].last);
      if (!st.length) conv(m, null, null);
      const c = st[st.length - 1];
      c.last = e.ts; c.responses += 1; c.nerve += e.nerve; c.money += e.money;
      c.state = e.result === "fail" ? "failing" : "open";
      if (e.money > 0) close(c, "paid", e.ts); else if (e.result === "crit") close(c, "lost", e.ts);
    }
    for (const m of stacks.keys()) sweep(m, now);
    for (const c of convs) if (c.state === "failing") c.state = "open";
    return convs;
  }

  // ---- community recipes (the Arsonist's Ledger dataset, keyed by job title) ----
  const REF_NAMES = { hydrogen: "Hydrogen Tank", methane: "Methane Tank", oxygen: "Oxygen Tank", magnesium: "Magnesium Shavings", potassium_nitrate: "Potassium Nitrate" };
  const TOOLS = new Set(["flamethrower", "lighter", "blanket", "sand", "extinguisher"]);  // kept after use: no cost
  const refName = id => REF_NAMES[id] || id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const jobTitle = job => (job.match(/^.* \((.*)\)$/) || [, job])[1];
  function community(r, priceByName) {
    if (!r) return null;
    const a = r.actions || {}, step = k => (a[k] || []).map(x => [x.resourceId, x.qty || 1, !!x.optional]);
    const [ev, place, ign, stoke, damp] = ["evidence", "place", "ignite", "stoke", "dampen"].map(step);
    const fmt = xs => xs.map(([i, q]) => q > 1 ? `${q} ${refName(i)}` : refName(i)).join(" + ");
    const steps = [];
    if (ev.length) steps.push(["Evidence", fmt(ev)]);
    if (place.length) steps.push(["Place", fmt(place)]);
    if (ign.length) steps.push(["Ignite", fmt(ign)]);
    if (stoke.length) steps.push(["Stoke", fmt(stoke) + (a.stokeTime ? ` (${a.stokeTime})` : "") + (stoke.every(x => x[2]) ? " if needed" : "")]);
    if (damp.length) steps.push(["Dampen", fmt(damp)]);
    const needed = [...ev, ...place, ...stoke, ...damp].filter(x => !x[2]);
    const nerve = 10 + 5 * needed.reduce((s, x) => s + x[1], 0);  // breach 3 + ignite 5 + collect 2, and 5 per other step
    const cost = needed.filter(x => !TOOLS.has(x[0])).reduce((s, [i, q]) => s + (priceByName[refName(i)] || 0) * q, 0);
    const lo = r.payoutMin || 0, hi = r.payoutMax || 0;
    return { steps, min: lo, max: hi, nerve, cost: Math.round(cost), per_nerve: hi ? Math.round(((lo + hi) / 2 - cost) / nerve) : null };
  }

  function recipe(j, names) {
    const nm = i => names[i] || `item ${i}`;
    const many = d => Object.entries(d).sort((a, b) => b[1] - a[1]).map(([i, n]) => n > 1 ? `${n}x ${nm(i)}` : nm(i)).join(" + ");
    const ev = Object.keys(j.evidence).map(nm).join(" + ");
    const text = [many(j.place), ev && `${ev} evidence`].filter(Boolean).join(" + ") || "no fuel logged";
    const fed = {};
    for (const d of Object.values(j.stokeFuel)) for (const [i, n] of Object.entries(d)) fed[i] = (fed[i] || 0) + n;
    return text + (j.stokes ? `, ${j.stokes} stoke${j.stokes > 1 ? "s" : ""}` + (Object.keys(fed).length ? ` (${many(fed)})` : "") : "") +
      (j.dampens ? `, ${j.dampens} dampen${j.dampens > 1 ? "s" : ""}` : "");
  }
  // One job step by step: what was placed, each stoke (minutes after it was lit, what it was fed), the evidence and
  // any dampening. (TornBrain also has the Arson page's burn % at each stoke; here it's always null.)
  function steps(j, names) {
    const nm = i => names[i] || `item ${i}`;
    const named = d => Object.fromEntries(Object.entries(d).map(([i, n]) => [nm(i), n]));
    const fed = new Map(j.stokeTs.map(t => [t, {}]));
    for (const [at, d] of Object.entries(j.stokeFuel)) {  // (fuel filed by second: to the stoke nearest it)
      if (!fed.size) break;
      const t = [...fed.keys()].reduce((a, s) => Math.abs(s - at) < Math.abs(a - at) ? s : a);
      for (const [i, n] of Object.entries(d)) fed.get(t)[i] = (fed.get(t)[i] || 0) + n;
    }
    return { place: named(j.place), evidence: Object.keys(j.evidence).map(nm), dampens: j.dampens,
             stokes: j.stokeTs.map(t => ({ min: j.ignited && t >= j.ignited ? Math.round((t - j.ignited) / 6) / 10 : null, pct: null, fuel: named(fed.get(t)) })) };
  }
  // How you ran a job when it paid (its last 20 payouts), step by step, to set beside the community recipe.
  const RECORD_JOBS = 20;
  function record(jobs, names) {
    if (!jobs.length) return null;
    const st = jobs.map(j => steps(j, names));
    const tally = perJob => {  // [{item: qty}] a job -> [{item, jobs it was in, median qty}]
      const seen = new Map();
      for (const d of perJob) for (const [k, q] of Object.entries(d)) (seen.get(k) || seen.set(k, []).get(k)).push(q);
      return [...seen].map(([item, v]) => ({ item, jobs: v.length, qty: median(v) }))
        .sort((a, b) => b.jobs - a.jobs || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    };
    const stoked = st.filter(s => s.stokes.length), first = stoked.map(s => s.stokes[0]);
    const mins = first.map(f => f.min).filter(m => m != null), pcts = first.map(f => f.pct).filter(p => p != null);
    const fed = stoked.map(s => { const d = {}; for (const x of s.stokes) for (const [k, q] of Object.entries(x.fuel)) d[k] = (d[k] || 0) + q; return d; });
    return { paid: st.length, place: tally(st.map(s => s.place)), stoked: stoked.length,
             stokes: stoked.length ? median(stoked.map(s => s.stokes.length)) : null,
             stoke_min: mins.length ? Math.round(median(mins) * 10) / 10 : null,
             stoke_pct: pcts.length ? Math.round(median(pcts)) : null, pct_n: pcts.length,
             stoke_fuel: tally(fed), tool_stokes: fed.filter(d => !Object.keys(d).length).length,
             evidence: tally(st.map(s => Object.fromEntries(s.evidence.map(e => [e, 1])))),
             dampened: st.filter(s => s.dampens).length, last: st[st.length - 1] };
  }
  function tendHint(t) {
    if (!t || t.paid < 2 || !t.stoked) return null;
    if (t.stoked === t.paid) return `stoke: ${t.stoked}/${t.paid} payouts`;
    if (t.stoked * 2 >= t.paid) return `often stoked: ${t.stoked}/${t.paid}, check its requirement`;
    return null;
  }
  function topRecipe(t) {
    if (!t || !Object.keys(t.recipes).length) return null;
    const [best, n] = Object.entries(t.recipes).sort((a, b) => b[1] - a[1])[0];
    return `${best} (${n} of ${t.paid} payouts)` + (t.last && t.last !== best ? `; last time: ${t.last}` : "");
  }
  const median = xs => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // ---- disposal: which method for which job ----
  // A job pays about the same whichever way it's disposed of, but each method costs fixed nerve and some fail more
  // often. So the pick is the best expected $/nerve: chance it works x what the job pays, less materials, over the
  // method's nerve. Cheap and shaky can beat reliable and dear: a dead body abandoned (6 nerve, ~80%) beats burned
  // (10 nerve, ~90%), which is why veterans leave them.
  // The community's chart (26 Feb 2024, 35,517 disposals) gives each method's reliability to start from; your own
  // results take over as you build history. Columns: abandon, bury, burn, sink, dissolve. g = very likely to work,
  // y = works with caution, o = works but fails often, r = fails almost every time, - = not available; * = a unique
  // outcome can be found there.
  const DISPOSAL_METHODS = ["Abandoning", "Burying", "Burning", "Sinking", "Dissolving"];
  const DISPOSAL_NERVE = { Abandoning: 6, Burying: 8, Burning: 10, Sinking: 12, Dissolving: 14 };
  const DISPOSAL_CHART = {
    "biological waste": "o y o g -", "body part": "o y y y g*", "building debris": "y* o - g -", "dead body": "y* g o o g",
    "document": "o y g* r r", "firearm": "o y* - g r", "general waste": "y* g g o r", "industrial waste": "o y* - g -",
    "murder weapon": "o y - g* r", "old furniture": "y o* g y r", "broken appliance": "o o - g* r", "vehicle": "o* - g g -" };
  const CHART_ODDS = { g: 0.95, y: 0.82, o: 0.65, r: 0.10 }, CHART_WEIGHT = 8;  // the chart counts as 8 attempts of your own
  function disposalMethods(job, stats) {
    const chart = (DISPOSAL_CHART[job.toLowerCase().replace(/s$/, "")] || DISPOSAL_CHART[job.toLowerCase()] || "? ? ? ? ?").split(" ");
    const done = Object.values(stats).filter(t => t.success > (t.uniques || 0));  // (what a job pays: not its one-time uniques)
    const paid = done.reduce((s, t) => s + t.success - (t.uniques || 0), 0);
    const pay = paid ? done.reduce((s, t) => s + t.money + t.itemValue - (t.uniqueNet || 0), 0) / paid : null;
    let pn;
    const methods = DISPOSAL_METHODS.map((m, i) => {
      const t = stats[m] || {}, n = t.attempts || 0, ok = t.success || 0, c = chart[i] || "?";
      const rating = c.replace("*", ""), star = c.endsWith("*");
      if (rating === "-" && !n) return { method: m, rating, star: false, available: false };
      const prior = CHART_ODDS[rating];
      const p = prior != null ? (ok + CHART_WEIGHT * prior) / (n + CHART_WEIGHT) : n ? ok / n : null;
      const nerve = n ? t.nerve / n : DISPOSAL_NERVE[m], cost = n ? t.itemCost / n : 0;
      const ev = p != null && pay != null ? (p * pay - cost) / nerve : null;
      return { method: m, rating, star, available: true, tries: n, ok, crits: t.crit || 0, p: p != null ? Math.round(p * 1000) / 1000 : null,
               nerve: Math.round(nerve * 10) / 10, ev: ev != null ? Math.round(ev) : null,
               per_nerve: n && (pn = ahead(t.money + t.itemValue - t.itemCost, t.nerve, t)) != null ? Math.round(pn) : null };
    });
    const live = methods.filter(m => m.available && m.p != null);
    const score = m => m.ev != null ? m.ev : m.p / m.nerve;  // same pay whichever way: odds per nerve
    const best = live.reduce((a, m) => !a || score(m) > score(a) ? m : a, null);
    const steady = live.reduce((a, m) => !a || m.p > a.p || (m.p === a.p && m.nerve < a.nerve) ? m : a, null);
    return { methods, pay: pay ? Math.round(pay) : null, best: best && best.method, steady: steady && steady.method };
  }

  // What a try at one spot brings (the card's odds and top items; TornBrain's outcomes()): how often it works, fails or
  // goes badly; how often it pays cash, and how much; the items that add most to a try; and apart, the uniques found.
  const TOP_ITEMS = 6, r1 = x => Math.round(x * 10) / 10, r3 = x => Math.round(x * 1000) / 1000;
  function outcomes(t, h, price, names) {
    if (!h || !t.attempts) return null;
    const n = t.attempts - (t.uniques || 0) - (t.seasonal || 0), nm = i => names[i] || `item ${i}`;
    const list = [...h.items].map(([i, [c, q]]) => ({ item: nm(i), rate: r3(c / n), qty: r1(q / c), value: Math.round(price[i] || 0) }))
      .sort((a, b) => (b.rate * b.qty * b.value) - (a.rate * a.qty * a.value) || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    return { tries: n, success: r3(t.success / t.attempts), fail: r3(t.fail / t.attempts), crit: r3(t.crit / t.attempts),
             cash: n > 0 ? r3(h.cashN / n) : 0, cash_avg: h.cashN ? Math.round(h.cash / h.cashN) : null, items: list.slice(0, TOP_ITEMS),
             kinds: list.length,
             seasonal: [...(h.seasonal || [])].map(([i, [c, q]]) => ({ item: nm(i), event: SEASONAL[nm(i)] ? SEASONAL[nm(i)][0] : null, found: c,
                                                                       qty: r1(q / c), value: Math.round(price[i] || 0) })),
             uniques: h.uniques.map(([money, got]) => ({ items: got.map(([i, q]) => nm(i) + (q > 1 ? ` \u00d7${q}` : "")),
                                                          value: Math.round(money + got.reduce((s, [i, q]) => s + (price[i] || 0) * q, 0)) })) };
  }
  // $/nerve from here on: a unique outcome pays once, so its nerve and what it paid are left out (the totals keep it);
  // so is an event-only drop, except while its event is on.
  function ahead(net, nerve, t) {
    const n = nerve - (t.uniqueNerve || 0) - (t.seasonNerve || 0);
    return n > 0 ? (net - (t.uniqueNet || 0) - (t.seasonNet || 0)) / n : null;
  }
  // Event-only drops (TornBrain's SEASONAL; the Torn wiki): left out of $/nerve the rest of the year (Aaron: "bottle of
  // green stout only drops during the st patricks day event"; it made Bits 'n' Bobs look like $9.1k/nerve against $511).
  // TornBrain reads Torn's calendar; a key here can't, so it's the event's date, two days either side.
  const SEASONAL = { "Bottle of Green Stout": ["St Patrick's Day", 3, 17], "Love Juice": ["Valentine's Day", 2, 14] };
  const eventOn = (name, now) => {
    const ev = SEASONAL[name];
    if (!ev) return false;
    const d = new Date(now * 1000), at = Date.UTC(d.getUTCFullYear(), ev[1] - 1, ev[2]);
    return Math.abs(now * 1000 - at) <= 2.5 * DAY * 1000;
  };
  // The whole picture: $/nerve per crime and per kind (job, scam type, spot...), all costs in.
  function report(rows, { price = {}, names = {}, ref = {}, priceByName = {}, days = null, now = Date.now() / 1000 } = {}) {
    const since = days ? now - days * DAY : 0, events = load(rows);
    const blank = () => ({ attempts: 0, nerve: 0, success: 0, fail: 0, crit: 0, money: 0, itemValue: 0, itemCost: 0, uniques: 0, uniqueNerve: 0, uniqueNet: 0,
                           seasonal: 0, seasonNerve: 0, seasonNet: 0 });
    // items whose event is off right now (left out of $/nerve, listed apart on the card)
    const offSeason = new Set(Object.entries(names).filter(([, n]) => SEASONAL[n] && !eventOn(n, now)).map(([i]) => +i));
    const crimes = {}, actions = new Map(), kinds = new Map();
    // per kind, what each try brought (odds, top items); burglary by property type; your skill per crime (Torn's
    // "Crime skill level up/down" logs)
    const haul = new Map(), burg = new Map(), skills = {};
    const take = (key, e) => {
      const h = haul.get(key) || haul.set(key, { cashN: 0, cash: 0, items: new Map(), uniques: [] }).get(key), got = [...items(e.d, ["items_gained"])];
      if (e.unique) { h.uniques.push([e.money, got]); return; }
      if (got.some(([i]) => offSeason.has(i))) {  // (apart too: only while its event is on)
        h.seasonal = h.seasonal || new Map();
        for (const [i, n] of got) if (offSeason.has(i)) { const x = h.seasonal.get(i) || h.seasonal.set(i, [0, 0]).get(i); x[0]++; x[1] += n; }
        return;
      }
      if (e.money > 0) { h.cashN++; h.cash += e.money; }
      for (const [i, n] of got) { const x = h.items.get(i) || h.items.set(i, [0, 0]).get(i); x[0]++; x[1] += n; }
    };
    const add = (t, e) => { t.attempts++; t.nerve += e.nerve; t[e.result]++; t.money += e.money;
      let gained = 0, lost = 0;
      for (const [i, n] of items(e.d, ["items_gained"])) gained += (price[i] || 0) * n;
      // a critical fail can lose the tool too (forgery's Embosser, bootlegging's drive): it's the attempt's cost
      for (const [i, n] of items(e.d, ["items_lost"])) lost += (price[i] || 0) * n;
      t.itemValue += gained; t.itemCost += lost;
      if (e.unique && e.crime !== ARSON) { t.uniques++; t.uniqueNerve += e.nerve; t.uniqueNet += e.money + gained - lost; }  // (arson's: by job)
      else if ([...items(e.d, ["items_gained"])].some(([i]) => offSeason.has(i))) { t.seasonal++; t.seasonNerve += e.nerve; t.seasonNet += e.money + gained - lost; } };
    const get = (m, k) => m.get(k) || m.set(k, blank()).get(k);
    // Materials are logged in the same second as the step they were for: charged to what that step was done to (and,
    // for disposal, to how: burning's gasoline, dissolving's acid).
    const stepAt = new Map(), how = new Map();
    for (const e of events) if (e.isStep && KIND_CRIMES.has(e.crime)) stepAt.set(`${e.ts}|${e.crime}`, [e.detail || e.action, e.action]);
    for (const e of events) {
      if (e.d && e.d.skill_level != null && e.d.crime && !e.isStep) {  // (all time: the latest level)
        const k = SKILL_TAB[slug(String(e.d.crime))] || slug(String(e.d.crime));  // (the log says "skimming")
        if (!skills[k] || e.ts >= skills[k][0]) skills[k] = [e.ts, +e.d.skill_level];
      }
      if (e.ts < since) continue;
      const cid = e.crime;
      if (e.isStep) {
        const c = cid ?? 0;
        add(crimes[c] ||= blank(), e);
        add(get(actions, `${c}|${e.action}|${c === SCAMMING ? e.detail : ""}`), e);
        if (KIND_CRIMES.has(c)) { add(get(kinds, `${c}|${e.detail || e.action}`), e); take(`${c}|${e.detail || e.action}`, e); }
        if (c === BURGLARY && (e.action === "Case" || e.action === "Burgle") && e.detail) {
          const b = burg.get(e.detail) || burg.set(e.detail, { ...blank(), cases: 0, caseNerve: 0 }).get(e.detail);
          if (e.action === "Case") { b.cases++; b.caseNerve += e.nerve; } else { add(b, e); take(`${c}|${e.detail}`, e); }
        }
        if (c === DISPOSAL) add(get(how, `${e.detail || e.action}|${e.action}`), e);
      } else if (COST_TYPES.has(e.type) && cid) {
        const cost = [...items(e.d, ["items_used", "items_added"])].reduce((s, [i, n]) => s + (price[i] || 0) * n, 0);
        (crimes[cid] ||= blank()).itemCost += cost;
        const at = [0, -1, 1, -2, 2].map(dt => stepAt.get(`${e.ts + dt}|${cid}`)).find(Boolean);
        if (at && KIND_CRIMES.has(cid)) {
          get(kinds, `${cid}|${at[0]}`).itemCost += cost;
          if (cid === DISPOSAL) get(how, `${at[0]}|${at[1]}`).itemCost += cost;
        }
      }
    }
    const finish = t => { t.net = t.money + t.itemValue - t.itemCost; t.per_nerve = ahead(t.net, t.nerve, t); return t; };
    // arson's unique outcomes come on the collect: the whole job is left out of its $/nerve, not just the collect
    const allJobs = arsonJobs(events, price, now, names), arson = new Map(), tend = new Map();
    for (const j of allJobs) if (j.unique && (j.closed || j.last) >= since && crimes[ARSON]) {
      const t = crimes[ARSON]; t.uniques++; t.uniqueNerve += j.nerve; t.uniqueNet += j.money - j.itemCost;
    }
    const byCrime = {};
    for (const [c, t] of Object.entries(crimes)) byCrime[c] = { id: +c, name: NAMES[c] || "Unrecognised", ...finish(t) };

    // arson jobs in range, and how each has been tended and fuelled when it paid (all time)
    for (const j of allJobs.filter(j => (j.closed || j.last) >= since)) {
      const a = arson.get(j.job) || arson.set(j.job, { job: j.job, instances: 0, paid: 0, expired: 0, open: 0, skipped: 0, nerve: 0, money: 0, itemCost: 0,
                                                       uniques: 0, uniqueNerve: 0, uniqueNet: 0 }).get(j.job);
      a[j.state]++; a.instances += j.state !== "skipped"; a.nerve += j.nerve; a.money += j.money; a.itemCost += j.itemCost;
      if (j.unique) { a.uniques++; a.uniqueNerve += j.nerve; a.uniqueNet += j.money - j.itemCost; }  // the whole job left out of $/nerve
    }
    for (const j of allJobs) if (j.state === "paid" && j.lit) {
      const t = tend.get(j.job) || tend.set(j.job, { paid: 0, stoked: 0, recipes: {}, last: null, payouts: [], jobs: [] }).get(j.job);
      t.paid++; t.stoked += j.stokes > 0; t.jobs.push(j);
      if (!j.unique) t.payouts.push(j.money);  // (a unique payout isn't what the job pays)
      const r = recipe(j, names); t.recipes[r] = (t.recipes[r] || 0) + 1; t.last = r;
    }
    // scam conversations in range, per method, with spam waves and a share of email farming
    const methods = new Map();
    const method = m => methods.get(m) || methods.set(m, { method: m, conversations: 0, paid: 0, lost: 0, expired: 0, open: 0, responses: 0, nerve: 0, money: 0, waves: 0, waveNerve: 0 }).get(m);
    for (const c of scamConversations(events, now).filter(c => (c.closed || c.last) >= since)) {
      const m = method(c.method); m.conversations++; m[c.state]++; m.responses += c.responses; m.nerve += c.nerve; m.money += c.money;
    }
    for (const [k, v] of actions) { const [c, a, d] = k.split("|"); if (+c === SCAMMING && a === "Spam wave") { const m = method(d); m.waves += v.attempts; m.waveNerve += v.nerve; } }
    const farm = actions.get(`${SCAMMING}|Farm emails|`), waves = [...methods.values()].reduce((s, m) => s + m.waves, 0);
    for (const m of methods.values()) {
      const share = farm && waves ? m.waves / waves : 0;
      m.allNerve = m.nerve + m.waveNerve + Math.round((farm ? farm.nerve : 0) * share);
      m.net = m.money + (farm ? farm.money : 0) * share;  // farming's money is negative (paid out)
      const closed = m.paid + m.lost + m.expired;
      m.winRate = closed ? m.paid / closed : null;
    }

    // $/nerve by kind
    const base = Object.fromEntries(Object.values(byCrime).map(c => [c.id, c.per_nerve]));
    const out = [];
    for (const a of arson.values()) if (a.instances) {
      const t = tend.get(a.job), r = ref[jobTitle(a.job)];
      const recent = t ? t.payouts.slice(-6).filter(p => p > 0) : [];
      out.push({ crime_id: ARSON, kind: a.job, nerve: a.nerve, net: a.money - a.itemCost, count: a.instances, unit: "jobs",
                 uniques: a.uniques, uniqueNerve: a.uniqueNerve, uniqueNet: a.uniqueNet,
                 tend: tendHint(t), recipe: topRecipe(t), record: t ? record(t.jobs.slice(-RECORD_JOBS), names) : null,
                 community: community(r, priceByName),
                 your_share: r && r.payoutMax && recent.length ? Math.round(100 * median(recent) / r.payoutMax) / 100 : null });
    }
    for (const m of methods.values()) if (m.conversations)
      out.push({ crime_id: SCAMMING, kind: m.method, nerve: m.allNerve, net: m.net, count: m.conversations, unit: "targets",
                 win_rate: m.winRate, paid: m.paid });
    for (const [k, v] of kinds) { const [c, kind] = [+k.split("|")[0], k.slice(k.indexOf("|") + 1)];
      const row = { crime_id: c, kind, nerve: v.nerve, net: v.money + v.itemValue - v.itemCost, count: v.attempts, unit: "crimes",
                    uniques: v.uniques, uniqueNerve: v.uniqueNerve, uniqueNet: v.uniqueNet,
                    seasonal: v.seasonal, seasonNerve: v.seasonNerve, seasonNet: v.seasonNet, outcomes: outcomes(v, haul.get(k), price, names) };
      if (c === DISPOSAL) {  // which method to use for this job: the choice the page asks you to make
        const stats = Object.fromEntries([...how].filter(([hk]) => hk.slice(0, hk.lastIndexOf("|")) === kind).map(([hk, t]) => [hk.slice(hk.lastIndexOf("|") + 1), t]));
        Object.assign(row, disposalMethods(kind, stats));
      }
      out.push(row); }
    // Burglary by property type: a burgle's pay over its type's casings, its own nerve and a focused scout (9); the
    // page blends "Any Industrial" from try_nerve with a 3-nerve scout
    for (const [p, b] of burg) if (b.attempts)
      out.push({ crime_id: BURGLARY, kind: p, nerve: b.nerve + b.caseNerve + SCOUT_FOCUSED * b.attempts,
                 try_nerve: Math.round((b.nerve + b.caseNerve) / b.attempts * 100) / 100, net: b.money + b.itemValue - b.itemCost,
                 count: b.attempts, unit: "burgles", uniques: b.uniques, uniqueNerve: b.uniqueNerve, uniqueNet: b.uniqueNet,
                 seasonal: b.seasonal, seasonNerve: b.seasonNerve, seasonNet: b.seasonNet,
                 cases: r1(b.cases / b.attempts), outcomes: outcomes(b, haul.get(`${BURGLARY}|${p}`), price, names) });
    for (const k of out) {
      k.crime = NAMES[k.crime_id] || "Unrecognised";
      k.per_nerve = ahead(k.net, k.nerve, k);
      const regular = k.count - (k.uniques || 0) - (k.seasonal || 0);  // (what it pays each time: uniques and event drops left out too)
      k.avg_net = regular > 0 ? (k.net - (k.uniqueNet || 0) - (k.seasonNet || 0)) / regular : null;
      k.vs_crime = k.per_nerve != null && base[k.crime_id] ? k.per_nerve / base[k.crime_id] : null;
      k.few = k.nerve < MIN_NERVE || k.count < 2;
    }
    const total = finish(Object.values(crimes).reduce((t, c) => { for (const f of ["attempts", "nerve", "success", "fail", "crit", "money", "itemValue", "itemCost", "uniques", "uniqueNerve", "uniqueNet"]) t[f] += c[f]; return t; }, blank()));
    return { total, crimes: Object.values(byCrime).sort((a, b) => b.nerve - a.nerve), kinds: out, events: events.length,
             skill: Object.fromEntries(Object.entries(skills).map(([k, [, s]]) => [k, s])) };
  }

  // What the page badges: for each crime tab, the names to look for and your $/nerve for each.
  const slug = s => s.toLowerCase().replace(/[^a-z]/g, "");
  // Each crime's best option, for the Best crimes list (TornBrain's leaders()): only what its page showed when you last
  // looked (seen: {tab: {text}}, kept in this browser), the community recipe's where your way lost and it pays; for
  // crimes whose options come and go (pickpocketing's marks, burglary's targets), your best of all of them too.
  const LIVING = { pickpocketing: "wait for", burglary: "scout for" };
  const ALL_LISTED = new Set(["burglary"]);  // (the scout menu names every property type: "on show" says nothing)
  const titleCase = s => s.replace(/(^|\s)(\w)/g, (m, a, b) => a + b.toUpperCase());
  function leaders(tabs, seen) {
    const out = {};
    for (const [tab, rows] of Object.entries(tabs)) {
      const text = ((seen[tab] || {}).text || "").toLowerCase();
      let best = null, ideal = null;
      if (LIVING[tab]) for (const r of rows)
        if (!r.few && (r.per_nerve || 0) > 0 && (!ideal || r.per_nerve > ideal.per_nerve))
          ideal = { name: titleCase(r.kind), per_nerve: Math.round(r.per_nerve), verb: LIVING[tab] };
      for (const r of rows) {
        if (r.few) continue;
        let pn = r.per_nerve, est = r.source === "community";
        const c = r.community || {};
        if (pn != null && pn < 0 && (c.per_nerve || 0) > 0) { pn = c.per_nerve; est = true; }
        const evs = (r.methods || []).filter(m => m.available && m.ev != null).map(m => m.ev);
        if (evs.length) pn = Math.max(...evs);  // (Disposal: the best method, as the page shows it)
        if (pn == null || pn <= 0 || (text && !r.find.some(f => text.includes(f.toLowerCase()))) || ALL_LISTED.has(tab)) continue;
        if (!best || pn > best.per_nerve) { const n = r.kind.replace(/^the /i, ""); best = { name: n[0].toUpperCase() + n.slice(1), per_nerve: Math.round(pn), est }; }
      }
      if (ideal && (!best || ideal.per_nerve > best.per_nerve)) best = { ...(best || { name: null, per_nerve: 0, est: false }), ideal };
      if (best) out[tab] = best;
    }
    return out;
  }
  function pageValues(rep, ref = {}, priceByName = {}, seen = {}) {
    const overall = rep.total.per_nerve || 0, tabs = {};
    for (const k of rep.kinds) {
      if (!k.crime_id || k.per_nerve == null) continue;
      const find = k.crime_id === ARSON ? [jobTitle(k.kind)] : k.crime_id === SCAMMING ? [k.kind, k.kind.replace(/\s*scam$/i, "")]
        : k.crime_id === 1 ? [`Search the ${k.kind}`, `Search ${k.kind}`] : [k.kind, k.kind.replace(/^(a|an|the) /i, "")];
      (tabs[slug(NAMES[k.crime_id])] ||= []).push({ ...k, find: [...new Set(find.filter(f => f.length >= 3))],
        worth: !k.few && (k.vs_crime || 0) >= 1 && k.per_nerve >= overall });
    }
    // arson jobs you've never done: the community recipe is all there is to go on
    const done = new Set((tabs.arson || []).map(v => jobTitle(v.kind)));
    const arsonBase = (rep.crimes.find(c => c.id === ARSON) || {}).per_nerve;
    for (const [title, r] of Object.entries(ref)) {
      if (done.has(title)) continue;
      const c = community(r, priceByName);
      if (!c || c.per_nerve == null) continue;
      const vs = arsonBase ? c.per_nerve / arsonBase : null;
      (tabs.arson ||= []).push({ crime_id: ARSON, kind: title, find: [title], per_nerve: c.per_nerve, vs_crime: vs, few: false, count: 0,
        unit: "jobs", source: "community", community: c, worth: (vs || 0) >= 1 && (!overall || c.per_nerve >= overall) });
    }
    return { overall, tabs, leaders: leaders(tabs, seen),
             crimes: Object.fromEntries(Object.values(NAMES).map(n => [slug(n), n])),
             crime_pn: Object.fromEntries(rep.crimes.filter(c => c.id && c.per_nerve != null).map(c => [slug(c.name), Math.round(c.per_nerve)])),
             crime_skill: rep.skill || {} };
  }

  return { classify, load, arsonJobs, scamConversations, community, report, pageValues, jobTitle, slug, NAMES, disposalMethods,
           outcomes, leaders, SCOUT_ANY };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CA;  // for tests (node)
else (async function main() {
  "use strict";
  const url = new URL(location.href);
  const onCrimes = url.searchParams.get("sid") === "crimes";
  // (Torn PDA can inject a script at the page's start, before there's a body; and once is enough)
  if (!document.body) await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true }));
  const body = document.body;
  if (!body || document.documentElement.dataset.crimeAdvisor) return;
  document.documentElement.dataset.crimeAdvisor = "1";
  // A Custom key with your logs and Torn's item prices (2.0: a log-only key can't read prices, so every item counted
  // as $0: Aaron's Shoplifting showed $34/nerve against TornBrain's $2.5k)
  const KEY_LINK = "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Crime%20Advisor&user=log&torn=items";
  let priceDenied = false;  // (the key can't read item prices: error 16, the key's access level)
  const denied = e => { if (e && e.code === 16) { priceDenied = true; if (typeof renderPanel === "function") renderPanel(); } };
  const $ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const one = x => x.toFixed(1).replace(/\.0$/, "");
  const short = n => n == null || !isFinite(n) ? "\u2013" : (n < 0 ? "-" : "") + (Math.abs(n) >= 1e6 ? `$${one(Math.abs(n) / 1e6)}m`
    : Math.abs(n) >= 1e4 ? `$${Math.round(Math.abs(n) / 1e3)}k` : Math.abs(n) >= 1e3 ? `$${one(Math.abs(n) / 1e3)}k` : `$${Math.round(Math.abs(n))}`);
  const money = n => n == null ? "\u2013" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}m`
    : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------- storage: settings in Tampermonkey, logs in IndexedDB ----------------
  // Torn PDA (the phone app) runs userscripts with its own GM_ layer: settings land in torn.com's localStorage (about
  // 5 MB, shared with Torn's chat) which PDA's "Clear cache" empties, key and all. There every setting but the
  // cross-tab sync lock is kept in IndexedDB beside the logs (which survives it), and the API is called with fetch
  // (Torn's API allows it). PDA can also hand a script its own key: used until you save one, if it can read logs.
  const PDA = typeof PDA_httpGet === "function" || !!window.flutter_inappwebview || /tornpda/i.test(navigator.userAgent);
  const PDA_KEY = "###PDA-APIKEY###", pdaKey = /^[A-Za-z0-9]{16}$/.test(PDA_KEY) ? PDA_KEY : "";
  const KEYS = ["key", "sync", "period", "autoOpen", "synced_at", "uq", "seen", "prices", "ref", "pdaKeyOff"], kvMem = new Map();
  const inDb = k => PDA && k !== "lock";
  // (no GM storage at all, e.g. a script runner without it: torn.com's localStorage, under "crime-advisor:")
  const noGM = typeof GM_getValue !== "function" || typeof GM_setValue !== "function";
  const get = (k, d) => {
    if (k === "key") { const v = rawGet(k, ""); return v || (pdaKey && !rawGet("pdaKeyOff", false) ? pdaKey : d); }
    return rawGet(k, d);
  };
  const rawGet = (k, d) => {
    if (inDb(k)) return kvMem.has(k) ? kvMem.get(k) : d;
    try {
      if (noGM) { const s = localStorage.getItem(`crime-advisor:${k}`); return s == null ? d : JSON.parse(s); }
      const v = GM_getValue(k); return v === undefined ? d : v;
    } catch (e) { return d; }
  };
  const set = (k, v) => {
    if (inDb(k)) { kvMem.set(k, v); kvdb.put(k, v); return; }
    try {
      if (noGM) { if (v === undefined) localStorage.removeItem(`crime-advisor:${k}`); else localStorage.setItem(`crime-advisor:${k}`, JSON.stringify(v)); }
      else GM_setValue(k, v);
    } catch (e) { /* ignore */ }
  };
  // Some browsers block IndexedDB (e.g. private windows): then the logs are kept in memory for this visit only.
  let memoryOnly = false;
  const idb = (() => {
    let p = null;
    const mem = new Map();
    const open = () => p || (p = new Promise(res => {
      const fail = () => { memoryOnly = true; res(null); };
      const timer = setTimeout(fail, 5000);
      try {
        const r = indexedDB.open("crime-advisor", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("logs", { keyPath: "id" });
        r.onsuccess = () => { clearTimeout(timer); r.result.onversionchange = () => r.result.close(); res(r.result); };
        r.onerror = () => { clearTimeout(timer); fail(); };
      } catch (e) { clearTimeout(timer); fail(); }
    }));
    const tx = async (mode, fn, memFn) => { const db = await open(); if (!db) return memFn(); return new Promise((res, rej) => {
      const t = db.transaction("logs", mode), s = t.objectStore("logs"), out = fn(s);
      t.oncomplete = () => res(out && "result" in out ? out.result : out); t.onerror = () => rej(t.error); }); };
    return { put: rows => tx("readwrite", s => { rows.forEach(r => s.put(r)); }, () => rows.forEach(r => mem.set(r.id, r))),
             all: () => tx("readonly", s => s.getAll(), () => [...mem.values()]),
             count: () => tx("readonly", s => s.count(), () => mem.size),
             clear: () => tx("readwrite", s => s.clear(), () => mem.clear()) };
  })();
  // Torn PDA's settings: a database of their own (so the logs' database never needs an upgrade an open tab blocks)
  const kvdb = (() => {
    let p = null;
    const open = () => p || (p = new Promise(res => {
      const timer = setTimeout(() => res(null), 5000);
      try {
        const r = indexedDB.open("crime-advisor-kv", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv", { keyPath: "k" });
        r.onsuccess = () => { clearTimeout(timer); res(r.result); };
        r.onerror = () => { clearTimeout(timer); res(null); };
      } catch (e) { clearTimeout(timer); res(null); }
    }));
    return {
      put: async (k, v) => { const db = await open(); if (db) try { db.transaction("kv", "readwrite").objectStore("kv").put({ k, v }); } catch (e) { /* kept in memory */ } },
      all: async () => { const db = await open(); if (!db) return [];
        return new Promise(res => { const q = db.transaction("kv").objectStore("kv").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); },
    };
  })();
  if (PDA) {  // load them before anything reads them; values an earlier visit put in torn.com's storage move across
    for (const { k, v } of await kvdb.all()) kvMem.set(k, v);
    for (const k of KEYS) {
      let old; try { old = noGM ? undefined : GM_getValue(k); } catch (e) { /* none */ }
      if (old !== undefined) { if (!kvMem.has(k)) set(k, old); try { GM_setValue(k, undefined); } catch (e) { /* ignore */ } }
    }
  }

  // ---------------- the Torn API (your key, one request every 3 s at most, one at a time) ----------------
  // Catching up on history: one every 1.5 s (40 of Torn's 100 a minute per player, shared with your other tools);
  // otherwise 3 s. After Torn's "too many requests", 6 s for ten minutes.
  const GAP_MS = 3000, CATCHUP_MS = 1500, BACKOFF_MS = 6000;
  let lastReq = 0, apiChain = Promise.resolve(), gap = GAP_MS, backoffUntil = 0;
  const pace = catchingUp => { gap = Date.now() < backoffUntil ? BACKOFF_MS : catchingUp ? CATCHUP_MS : GAP_MS; };
  // Requests: Tampermonkey's, except the API in Torn PDA (by fetch: its GM layer's replies aren't Tampermonkey's) or
  // wherever there's no GM request at all. The last one's outcome goes in the panel's "About this browser".
  let lastNet = null;
  async function fetchText(opts) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(opts.url, { method: opts.method || "GET", headers: opts.headers, signal: ctl.signal, cache: "no-store" });
      return { status: r.status, responseText: await r.text() };
    } catch (e) { throw new Error(e.name === "AbortError" ? "timed out" : "network error"); }
    finally { clearTimeout(t); }
  }
  async function http(opts) {
    const byFetch = (PDA && /^https:\/\/api\.torn\.com\//.test(opts.url)) || typeof GM_xmlhttpRequest !== "function";
    const host = new URL(opts.url).host;
    try {
      const r = byFetch ? await fetchText(opts) : await new Promise((res, rej) => GM_xmlhttpRequest({ ...opts, timeout: 30000,
        onload: x => res({ status: x.status, responseText: x.responseText != null ? x.responseText : x.response != null ? String(x.response) : "" }),
        onerror: () => rej(new Error("network error")), ontimeout: () => rej(new Error("timed out")) }));
      lastNet = { host, via: byFetch ? "fetch" : "GM", ok: true, status: r.status, at: Date.now() };
      return r;
    } catch (e) { lastNet = { host, via: byFetch ? "fetch" : "GM", ok: false, err: e.message, at: Date.now() }; throw e; }
  }
  async function apiNow(path, params) {
    const key = get("key", "");
    if (!key) throw new Error("no API key");
    const wait = lastReq + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    const q = new URLSearchParams(Object.fromEntries(Object.entries({ ...params, comment: "CrimeAdvisor" }).filter(([, v]) => v != null)));
    const r = await http({ method: "GET", url: `https://api.torn.com/v2${path}?${q}`, headers: { Authorization: `ApiKey ${key}` } });
    const j = JSON.parse(r.responseText);
    if (j.error) {
      const msg = { 2: "the API key isn't right", 16: "the key's access is too low: use the panel's \"Make a key\" link (logs + item prices)", 5: "too many requests: waiting",
                    8: "IP blocked by Torn for too many requests", 13: "the key's owner is inactive", 18: "the key is paused" }[j.error.code] || j.error.error;
      if (pdaKey && key === pdaKey && [2, 16].includes(j.error.code)) set("pdaKeyOff", true);  // (PDA's key can't: ask for one)
      const e = new Error(msg); e.code = j.error.code; throw e;
    }
    return j;
  }
  // (queued: the log sync and the item prices for a crime's result never go out together)
  function api(path, params = {}) {
    const p = apiChain.then(() => apiNow(path, params));
    apiChain = p.catch(() => { /* the caller handles it */ });
    return p;
  }

  // ---------------- syncing your crime logs (new ones first, then history, gently) ----------------
  const keep = ["crime_action", "nerve", "money_gained", "money_lost", "items_used", "items_added", "items_gained", "items_lost", "unique", "target", "method", "crime", "skill_level"];
  const slim = l => ({ id: String(l.id), ts: l.timestamp, type: (l.details || {}).id, title: (l.details || {}).title,
                       d: Object.fromEntries(keep.filter(k => l.data && l.data[k] != null).map(k => [k, l.data[k]])) });
  let syncing = false, syncNote = "", syncPct = null, syncError = "", syncedThisVisit = false;
  async function page(to, from) {
    const j = await api("/user/log", { cat: 136, limit: 100, to, from });
    const logs = j.log || [];
    if (logs.length) await idb.put(logs.map(slim));
    return logs;
  }
  // The device (Aaron: "someone will probably try to install this on a potato"): a low-end one (2 GB of memory or
  // less, or 2 cores or fewer; browsers that don't say count as fine) recomputes half as often while history loads and
  // watches the page more lazily. Everywhere, recomputes are timed and spaced so they stay a small share of the load
  // (a 4 s recompute: every 40 pages instead of 20), and they wait for the browser to be idle. The numbers are the same;
  // only how often they refresh while loading changes.
  const LOW = (navigator.deviceMemory > 0 && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 2);
  let rcMs = 0;  // how long the last recompute took
  const everyPages = () => Math.max(LOW ? 40 : 20, Math.ceil(rcMs / 100));
  const idle = () => new Promise(res => (window.requestIdleCallback ? requestIdleCallback(() => res(), { timeout: 3000 }) : setTimeout(res, 50)));
  const TAB = Math.random().toString(36).slice(2);  // this tab, for the sync lock
  const lockNow = () => {  // (1.x kept a bare timestamp: read as nobody's)
    const l = get("lock", 0), at = typeof l === "number" ? l : (l && l.at) || 0;
    return { by: l && l.by, busy: Date.now() - at < 20000 };
  };
  const releaseLock = () => { const l = get("lock", 0); if (!l || typeof l === "number" || l.by === TAB) set("lock", 0); };
  addEventListener("pagehide", () => { if (syncing) releaseLock(); });
  async function sync(onProgress) {
    if (syncing || !get("key", "")) return;
    // One tab at a time: a lock that the syncing tab refreshes, marked as its own. A tab lets go when its page
    // closes or reloads (2.0.3: a reload found its own old lock still fresh, took it for another tab's, and waited 5
    // minutes); while another tab really holds it, look again in 25 s.
    const l = lockNow();
    if (l.busy && l.by !== TAB) { setTimeout(() => sync(onProgress), 25000); return; }
    syncing = true;
    const beat = setInterval(() => set("lock", { by: TAB, at: Date.now() }), 5000);
    set("lock", { by: TAB, at: Date.now() });
    // (v2: a full read once more, for what earlier versions skipped, see below; v3, 1.2.4: once more for the tools
    // lost on critical fails, which earlier versions didn't keep; v4, 1.2.5: and which outcomes were uniques. Logs are
    // stored by id, so a re-read only adds that.)
    const blank = { v: 4, newest: null, oldest: null, done: false };
    let st = memoryOnly && !syncedThisVisit ? { ...blank } : get("sync", blank);
    if (st.v !== 4) st = { ...blank };
    syncedThisVisit = true;
    try {
      syncError = "";
      // new logs: page back from now to the newest we have (a first run takes one page; history does the rest).
      // `to` is inclusive: one crime writes several logs in the same second, and a page can end part way through it,
      // so the next page starts at that same second (logs are stored once, by id); a page with nothing new steps
      // past it. Up to 1.2.2 a later visit read only its newest page: the lower bound followed the newest log as it
      // was read, so the logs between that page and the last visit were never read (and a split second was lost).
      const fresh = st.newest == null, had = st.newest;
      let to = null, prev = new Set();
      for (let i = 0; i < 300; i++) {
        const logs = await page(to, had ? had - 1 : null);
        if (!logs.length) { if (st.newest == null) st.done = true; break; }
        const ts = logs.map(l => l.timestamp), oldest = Math.min(...ts);
        st.newest = Math.max(st.newest || 0, ...ts);
        if (st.oldest == null) st.oldest = oldest;
        if (fresh || logs.length < 100) break;
        const more = logs.some(l => !prev.has(String(l.id)));
        prev = new Set(logs.map(l => String(l.id)));
        to = more ? oldest : oldest - 1;
      }
      set("sync", st);
      onProgress();
      // history: keep paging back while this page is open, until the start
      let pages = 0, batches = 0;
      while (!st.done && !(memoryOnly && pages++ >= 20)) {  // memory-only: just the latest ~2,000 logs each visit
        pace(true);
        // progress: where logs are already stored further back (a re-read, or a reload), how far through and how long
        // is left at this pace; on a first read nothing is known past what's loaded, so the date and the pace
        const older = olderThan(st.oldest), done = storedTs.length - older;
        const per = 100 * 60000 / gap, mins = Math.ceil(older / per);
        syncPct = older > 100 ? Math.floor(100 * done / (done + older)) : null;
        syncNote = syncPct != null ? `re-reading ${syncPct}% \u00b7 ~${mins} min`
          : `loading history \u00b7 ~${Math.round(per).toLocaleString()} logs a minute`;
        onProgress();
        const logs = await page(st.oldest, null);
        if (logs.length) st.oldest = Math.min(st.oldest, ...logs.map(l => l.timestamp)) - (logs.length === 100 ? 0 : 1);
        if (logs.length < 100) st.done = true;
        else if (logs.every(l => l.timestamp === st.oldest)) st.oldest -= 1;  // a full page within one second: step past it
        set("sync", st);
        // the numbers catch up as history loads: every ~2,000 logs, less often where a recompute is slow (see LOW)
        if (++batches % everyPages() === 0) await idle().then(recompute);
      }
      syncNote = ""; syncPct = null;
      set("synced_at", Date.now());
    } catch (e) {
      syncError = e.message; syncPct = null;
      if (e.code === 5) { backoffUntil = Date.now() + 600000; await sleep(60000); }
    } finally {
      pace(false);
      clearInterval(beat);
      releaseLock();
      syncing = false;
      onProgress();
    }
  }

  // ---------------- item prices (materials and rewards) and the community recipes, once a day ----------------
  // Prices are cached by item id: all of them refreshed once a day, and any item new to the stored logs (history
  // still loading, a new reward) priced at the next recompute, not the next day (up to 2.0 such items counted $0
  // until then).
  const priceMiss = new Set();  // (ids Torn returned no price for: not asked again this visit)
  const itemPrice = it => [it.name, (it.value || {}).market_price || 0];
  function savePrices(items) {  // merged into the stored cache (another tab, or a result's items, may have added some)
    const c = get("prices", { at: 0, byId: {} });
    c.byId = c.byId || {};
    for (const it of items) c.byId[it.id] = itemPrice(it);
    set("prices", c);
    return c;
  }
  async function refreshPrices(rows) {
    let cached = get("prices", { at: 0, byId: {} });
    cached.byId = cached.byId || {};
    const inLogs = new Set();
    for (const r of rows) for (const k of ["items_used", "items_added", "items_gained", "items_lost"]) for (const id of Object.keys((r.d || {})[k] || {})) if (/^\d+$/.test(id)) inLogs.add(id);
    if (Date.now() - cached.at < DAYMS) {
      const missing = [...inLogs].filter(id => !cached.byId[id] && !priceMiss.has(id));
      try {
        for (let i = 0; i < missing.length; i += 100) {
          const chunk = missing.slice(i, i + 100), j = await api(`/torn/${chunk.join(",")}/items`);
          cached = savePrices(j.items || []);
          chunk.forEach(id => { if (!cached.byId[id]) priceMiss.add(id); });
        }
        if (missing.length) priceDenied = false;
      } catch (e) { denied(e); /* the rest at the next recompute */ }
      return cached;
    }
    const ids = new Set([...Object.keys(cached.byId), ...inLogs]);  // (with the items priced for a crime's result: kept fresh too)
    const fuels = ["Gasoline", "Kerosene", "Diesel", "Hydrogen Tank", "Methane Tank", "Oxygen Tank", "Magnesium Shavings", "Potassium Nitrate", "Thermite"];
    const byId = {};
    const list = [...ids];
    try {
      for (let i = 0; i < list.length; i += 100) {
        const j = await api(`/torn/${list.slice(i, i + 100).join(",")}/items`);
        for (const it of j.items || []) byId[it.id] = [it.name, (it.value || {}).market_price || 0];
      }
      // fuels not in your logs yet (to cost community recipes): arson fuels are "Material" items
      if (fuels.some(f => !Object.values(byId).some(([n]) => n === f))) {
        const all = await api("/torn/items", { cat: "Material" }).catch(() => ({ items: [] }));
        for (const it of all.items || []) if (fuels.includes(it.name)) byId[it.id] = [it.name, (it.value || {}).market_price || 0];
      }
      const out = { at: Date.now(), byId };
      set("prices", out);
      priceDenied = false;
      return out;
    } catch (e) { denied(e); return cached; }
  }
  const DAYMS = 86400000;
  async function refreshRef() {
    const cached = get("ref", { at: 0, byTitle: {} });
    if (Date.now() - cached.at < DAYMS && Object.keys(cached.byTitle).length) return cached;
    try {
      const r = await http({ method: "GET", url: "https://balaclava.app/arsonists-ledger/scenarios.json" });
      const rows = JSON.parse(r.responseText);
      const out = { at: Date.now(), byTitle: Object.fromEntries(rows.filter(x => x.scenarioName).map(x => [x.scenarioName, x])) };
      set("ref", out);
      return out;
    } catch (e) { return cached; }
  }

  // ---------------- the numbers ----------------
  let values = null, summary = null, version = 0;
  // the stored logs' times, oldest first (the history progress line: how many lie further back than the sync has reached)
  let storedTs = [];
  const olderThan = t => { let lo = 0, hi = storedTs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (storedTs[m] < t) lo = m + 1; else hi = m; } return lo; };
  async function recompute() {
    const t0 = performance.now();
    try { return await recomputeNow(); } finally { rcMs = performance.now() - t0; }
  }
  async function recomputeNow() {
    const rows = get("key", "") ? await idb.all().catch(() => []) : [];
    storedTs = rows.map(r => r.ts).sort((a, b) => a - b);
    const [prices, ref] = await Promise.all([rows.length ? refreshPrices(rows) : get("prices", { at: 0, byId: {} }), refreshRef()]);
    const price = {}, names = {}, priceByName = {};
    for (const [id, [n, p]] of Object.entries(prices.byId || {})) { price[id] = p; names[id] = n; priceByName[n] = p; }
    const opts = { price, names, ref: ref.byTitle || {}, priceByName };
    const all = CA.report(rows, opts);
    // (seen: each crime page's text as you last saw it, so "Best crimes" only names what was on offer)
    values = CA.pageValues(all, opts.ref, priceByName, get("seen", {}));
    version++;  // chips drawn from older numbers are redrawn
    summary = { all, month: CA.report(rows, { ...opts, days: 30 }), logs: rows.length };
    renderPanel();
    if (onCrimes) schedule();
  }

  // ---------------- the look (DESIGN: Glance -> Peek -> Dig) ----------------
  // Tiers: S best on show and at or above your average, A above it, B half to 1x, C under half, X loses money,
  // Q little history, W careful, G ready to collect. Green go, amber careful, red loses, gold unique.
  const style = $("style");
  style.textContent = `
    .ca-btn{position:fixed;left:12px;bottom:12px;z-index:99998;display:grid;justify-items:start;gap:1px;max-width:min(340px,80vw);background:#1a1a19;color:#9cc8ff;
      border:1px solid #3a3a37;border-radius:12px;padding:6px 12px 7px;font:600 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4);white-space:nowrap;overflow:hidden;text-align:left}
    .ca-btn .ca-bt{font:700 9.5px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#9cc8ff}
    .ca-btn .ca-ba{display:flex;align-items:center;gap:6px;max-width:100%;min-width:0;overflow:hidden;font:600 13px system-ui,sans-serif;color:#f3f3f1}
    .ca-btn .ca-ba.muted{color:#a9a89f}
    .ca-btn .ca-bn{overflow:hidden;text-overflow:ellipsis;color:#f3f3f1}.ca-btn .ca-tier{width:18px;height:18px;font-size:11px;border-radius:5px}
    .ca-panel{position:fixed;left:12px;bottom:52px;z-index:99999;width:min(360px,92vw);max-height:70vh;overflow:auto;background:#1a1a19;color:#f3f3f1;box-sizing:border-box;
      border:1px solid #3a3a37;border-radius:10px;padding:12px 14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.55)}
    .ca-panel h4{margin:0 0 8px;color:#9cc8ff;font-size:13px;display:flex;justify-content:space-between;align-items:center}
    .ca-panel input{width:100%;box-sizing:border-box;background:#111;color:#f3f3f1;border:1px solid #3a3a37;border-radius:6px;padding:6px 8px;font:13px monospace}
    .ca-panel button.ca-pbtn{background:#2a78d6;color:#fff;border:0;border-radius:6px;padding:6px 10px;font:600 12px system-ui;cursor:pointer;margin:6px 6px 0 0}
    .ca-panel button.ca-ghost{background:#2c2c2a;color:#e8e8e4}
    .ca-panel button.ca-link{all:unset;cursor:pointer;color:#9cc8ff;font:600 12px system-ui,sans-serif;min-height:28px;display:inline-flex;align-items:center}
    .ca-panel button.ca-link:hover{text-decoration:underline}.ca-panel button.ca-link:focus-visible{outline:2px solid #9cc8ff;outline-offset:2px}
    .ca-panel table{width:100%;border-collapse:collapse;margin-top:6px;font-variant-numeric:tabular-nums}
    .ca-panel td,.ca-panel th{padding:3px 4px;text-align:right;border-bottom:1px solid #2c2c2a}.ca-panel td:first-child,.ca-panel th:first-child{text-align:left}
    .ca-panel th{color:#8f8e86;font-weight:500}.ca-muted{color:#8f8e86;font-size:12px}.ca-err{color:#ff9b8f}
    .ca-sec{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8f8e86;margin:6px 0 2px}.ca-sec span{text-transform:none;letter-spacing:0}
    .ca-pop .ca-x,.ca-panel .ca-x{background:none;border:0;color:#c3c2b7;cursor:pointer;font-size:14px;padding:0 4px;margin:0;min-width:28px;min-height:28px}
    .ca-ph{display:flex;align-items:center;gap:8px;margin:-4px -8px 6px 0}.ca-ph b{flex:1;font:700 14px system-ui,sans-serif;color:#f3f3f1}
    .ca-avg{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;background:#232321;color:#c3c2b7;font:600 11px system-ui,sans-serif;font-variant-numeric:tabular-nums;cursor:help;white-space:nowrap}
    .ca-avg i{display:inline-block;width:2px;height:10px;border-radius:1px;background:#c3c2b7;margin-right:6px}
    .ca-alert{background:#3a1d1b;border-radius:6px;padding:6px 8px;margin:0 0 8px;font-size:12px}
    .ca-yh{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 4px}.ca-yh .ca-sec{margin:0;cursor:help}
    .ca-seg{display:inline-flex;background:#232321;border-radius:999px;padding:2px}
    .ca-panel .ca-seg button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;font:600 11px system-ui,sans-serif;color:#8f8e86;min-height:16px}
    .ca-panel .ca-seg button.on{background:#3d3d3a;color:#f3f3f1}.ca-panel .ca-seg button:focus-visible{outline:2px solid #9cc8ff}
    .ca-bars{list-style:none;margin:0;padding:0;display:grid}
    .ca-bars li{display:grid;grid-template-columns:7.5em minmax(0,1fr) 3.8em;align-items:center;gap:10px;min-height:26px;margin:0}
    .ca-panel .ca-bars a{color:#e8e8e4!important;text-decoration:none;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ca-panel .ca-bars a:hover{color:#9cc8ff!important;text-decoration:underline}
    .ca-bar{position:relative;height:6px;border-radius:3px;background:#232321}
    .ca-bar span{display:block;height:100%;border-radius:3px;background:#4a4a45}
    .ca-bar span.A{background:#2fbf71}.ca-bar span.B{background:#4c7a5e}
    .ca-bar i{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;border-radius:1px;background:#c3c2b7;opacity:.75}
    .ca-bv{text-align:right;font:600 12px system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#e8e8e4}.ca-bv.C{color:#8f8e86}.ca-bv.X{color:#ff9b8f}
    .ca-sec2{margin-top:12px!important;cursor:help}.ca-none{padding:4px 0}
    .ca-bar span.sk{background:#2a78d6}.ca-bar span.uq{background:#a8842e}.ca-panel .ca-bv.ca-uqv{color:#e3b341;font-weight:600}
    .ca-panel .ca-bv.ca-sk{color:#9cc8ff;font-weight:500}.ca-uqn{color:#e3b341;font-weight:600;font-size:11px;margin-right:4px}.ca-up li{grid-template-columns:7.5em minmax(0,1fr) auto}.ca-up .ca-bv{min-width:3.8em}
    .ca-done{margin-top:10px;font-size:12px;color:#8f8e86;line-height:1.6}.ca-done .ca-sec{display:inline;margin:0 4px 0 0}
    .ca-panel .ca-done a{color:#a9a89f!important;text-decoration:none}.ca-panel .ca-done a:hover{color:#9cc8ff!important;text-decoration:underline}
    .ca-hubuq{margin-left:6px;vertical-align:middle}
    .ca-auto{display:flex;align-items:center;gap:6px;font-size:11px;color:#8f8e86;cursor:pointer;min-height:24px}.ca-panel .ca-auto input{width:auto;margin:0;accent-color:#2a78d6}
    .ca-list li.ca-weak{opacity:.6}.ca-list li.ca-weak:hover{opacity:1}
    .ca-about summary{cursor:pointer;font-size:11px;color:#8f8e86;min-height:24px;display:flex;align-items:center}
    .ca-diag{display:grid;gap:2px;font-size:11px;color:#c3c2b7;margin:4px 0}.ca-diag .ca-kv span:first-child{color:#8f8e86;flex:none}
    .ca-diag .ca-kv span:last-child{overflow-wrap:anywhere}
    .ca-tip{position:fixed;z-index:100001;background:#2c2c2a;color:#f3f3f1;border:1px solid #3a3a37;border-radius:8px;padding:8px 10px;
      font:12px/1.45 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.5);box-sizing:border-box}
    /* a phone (Torn PDA, a mobile browser): the panel is a bottom sheet, the button clear of the screen's edge */
    @media (max-width:600px){
      .ca-panel{left:0;right:0;bottom:var(--ca-bottom,0px);width:auto;max-height:calc(88vh - var(--ca-bottom,0px));border-radius:14px 14px 0 0;padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}
      .ca-btn{bottom:calc(12px + var(--ca-btn-lift,0px) + env(safe-area-inset-bottom,0px));max-width:var(--ca-room,calc(100vw - 24px))}
      .ca-btn{padding:6px 10px 7px}.ca-btn .ca-ba{font-size:12px;gap:5px}
      .ca-panel .ca-seg button{padding:6px 12px}.ca-bars li{min-height:30px}
      /* chips are the grade alone, beside the name (Torn's rows are one line high: a chip on a line of its own pushed
         the name and the risk bar out of view; with numbers, long names wrapped them; Aaron's iPhone) */
      .ca-badge.ca-hud.ca-chip{min-height:20px;font-size:10.5px;margin-left:6px}.ca-hud .ca-v:empty{display:none}
    }
    .ca-more{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px}
    .ca-foot{margin-top:10px;padding-top:8px;border-top:1px solid #2c2c2a;display:grid;gap:6px}
    .ca-prog{height:3px;border-radius:2px;background:#232321;overflow:hidden}.ca-prog span{display:block;height:100%;background:#2a78d6;transition:width .4s}
    .ca-frow{display:flex;justify-content:space-between;align-items:center;gap:8px}.ca-frow > .ca-muted{font-size:11px}
    .ca-panel .ca-frow .ca-link{font-size:11px;flex:none}.ca-panel .ca-ok{color:#9ff0c2!important}
    .ca-keyform,.ca-onb{display:grid;gap:6px}.ca-onb b{font:700 14px system-ui,sans-serif;color:#f3f3f1}
    .ca-panel a.ca-mk{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:#1d2733;color:#9cc8ff!important;text-decoration:none;font:600 12px system-ui,sans-serif}
    .ca-panel a.ca-mk:hover{background:#243244}
    .ca-krow{display:flex;gap:6px}.ca-krow input{flex:1;min-width:0}.ca-panel .ca-krow button.ca-pbtn{margin:0}
    .ca-panel button.ca-danger{color:#ff9b8f;font-weight:500;font-size:11px;justify-self:start}
    .ca-best{margin:0 0 10px;padding:0 0 8px;border-bottom:1px solid #2c2c2a}.ca-best:empty{display:none}
    .ca-best > .ca-sec:first-child{margin-top:0}
    .ca-list{margin:2px 0 0;padding:0;list-style:none}
    .ca-list li{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 0;border-top:1px solid #2c2c2a;margin:0}
    .ca-list a.ca-name,.ca-list .ca-name{color:#9cc8ff;text-decoration:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ca-list .ca-name:hover{text-decoration:underline}.ca-list li > .ca-muted{flex:none}
    .ca-list .ca-tier{width:18px;height:18px;font-size:11px;border-radius:5px}
    button.ca-bestbtn{all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;min-width:0;min-height:28px}
    button.ca-bestbtn:focus-visible{outline:2px solid #9cc8ff;outline-offset:2px}
    .ca-loc{color:#6f8fb3;font-size:13px;flex:none}button.ca-bestbtn:hover .ca-loc{color:#9cc8ff}button.ca-bestbtn:hover .ca-name{text-decoration:underline}
    .ca-legend{margin-top:6px;font-size:11px}
    .ca-badge{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font:600 11px system-ui,sans-serif;
      background:#2c2c2a;color:#e8e8e4;white-space:nowrap;vertical-align:middle}
    .ca-badge.ca-gold{background:#e3b341;color:#241a00}
    .ca-badge.ca-hud{display:inline-flex;align-items:stretch;padding:0;overflow:hidden;min-height:22px;border:0;cursor:pointer;
      font:600 11px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums;background:#2c2c2a;color:#e8e8e4}
    .ca-hud .ca-t{display:grid;place-items:center;min-width:20px;padding:0 5px;font-weight:800;background:#3d3d3a;color:#f3f3f1}
    .ca-hud .ca-v{display:flex;align-items:center;gap:3px;padding:0 8px 0 6px}.ca-hud .ca-bolt{color:#ffb84d;font-size:13px;line-height:1}
    .ca-hud .ca-star{color:#e3b341;font-size:15px;line-height:1;margin:-1px 1px 0 -1px}
    .ca-hud.S,.ca-hud.G{background:#173d29;color:#d9ffe9}.ca-hud.S .ca-t,.ca-hud.G .ca-t{background:#2fbf71;color:#04210f}
    .ca-hud.A{background:#16261d;color:#d9ffe9}.ca-hud.A .ca-t{background:#1d5e3a;color:#d9ffe9}
    .ca-hud.C{background:#242422;color:#a9a89f}.ca-hud.C .ca-t{background:#242422;color:#c3c2b7;box-shadow:inset -1px 0 #3a3a37}
    .ca-hud.X{background:#6b2020;color:#ffd6d6}.ca-hud.X .ca-t{background:#e5534b;color:#fff}
    .ca-hud.Q{background:#232321;color:#a9a89f;outline:1px dashed #55554f;outline-offset:-1px}.ca-hud.Q .ca-t{background:transparent;color:#c3c2b7}
    .ca-hud.W{background:#3a2f12;color:#ffe9a8}.ca-hud.W .ca-t{background:#5a4712;color:#ffe9a8}
    .ca-hud.mini .ca-v{display:none}.ca-hud.step{margin-left:10px}.ca-hud.tight .ca-v{padding:0 6px 0 4px;gap:2px}.ca-hud.tight .ca-t{min-width:16px;padding:0 4px}
    .ca-badge.ca-oval{align-self:center;margin-left:10px;cursor:help;min-height:24px;font-size:12px}
    .ca-hud .ca-lbl{display:flex;align-items:center;padding:0 7px;font:700 9px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;background:rgba(0,0,0,.28)}
    .ca-hud:hover{filter:brightness(1.15)}.ca-hud[aria-expanded="true"]{box-shadow:0 0 0 2px #9cc8ff}
    .ca-pop{position:fixed;z-index:100000;width:min(340px,92vw);background:#1a1a19;color:#f3f3f1;border:1px solid #3a3a37;border-radius:10px;
      padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.55);font:13px/1.45 system-ui,sans-serif;max-height:calc(100vh - 16px);overflow:auto}
    .ca-pop [hidden]{display:none!important}
    .ca-pop.ca-card{display:grid;gap:10px;padding:12px 14px 10px;width:min(320px,94vw)}
    .ca-card .ca-grade{margin-top:-8px;padding-left:30px;font-size:12px;color:#8f8e86}
    .ca-card .ca-hd{display:flex;align-items:center;gap:8px}.ca-card .ca-hd b{flex:1;min-width:0;font:700 15px system-ui,sans-serif;color:#f3f3f1}
    .ca-tier{display:grid;place-items:center;flex:none;width:22px;height:22px;border-radius:6px;font:800 13px system-ui,sans-serif;background:#3d3d3a;color:#f3f3f1}
    .ca-tier.S,.ca-tier.G{background:#2fbf71;color:#04210f}.ca-tier.A{background:#1d5e3a;color:#d9ffe9}.ca-tier.C{background:transparent;box-shadow:inset 0 0 0 1px #3a3a37;color:#c3c2b7}
    .ca-tier.X{background:#e5534b;color:#fff}.ca-tier.Q{background:transparent;outline:1px dashed #55554f;color:#a9a89f}.ca-tier.W{background:#5a4712;color:#ffe9a8}
    .ca-hero{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.ca-hero .ca-n{font:700 28px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums}.ca-hero .ca-u{color:#8f8e86}
    .ca-delta{padding:2px 8px;border-radius:999px;font:600 11px system-ui,sans-serif;background:#232321;color:#c3c2b7}
    .ca-delta.up{background:#173d29;color:#9ff0c2}.ca-delta.down{background:#3a2a1a;color:#ffcf9e}
    .ca-meter{display:grid;gap:4px}.ca-trk{display:flex;gap:2px;height:8px;border-radius:4px;overflow:hidden;background:#232321}.ca-trk span{height:100%}
    .ca-lg{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:#8f8e86;font-variant-numeric:tabular-nums}.ca-lg b{color:#f3f3f1;font-weight:600}
    .ca-k{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
    .ca-items{display:grid;gap:5px}.ca-it{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:12px;font-variant-numeric:tabular-nums}
    .ca-it .ca-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ca-it .ca-iv{color:#c3c2b7}
    .ca-it .ca-sh{grid-column:1/-1;height:3px;border-radius:2px;background:#232321;overflow:hidden}.ca-it .ca-sh span{display:block;height:100%;background:#4c7a5e}
    .ca-ft{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
    .ca-pill{padding:3px 9px;border-radius:999px;font:600 11px system-ui,sans-serif;background:#232321;color:#c3c2b7}
    .ca-pill.go{background:#173d29;color:#9ff0c2}.ca-pill.gold{background:#3a2f12;color:#e3b341}.ca-pill.warn{background:#5a4712;color:#ffe9a8}.ca-pill.bad{background:#6b2020;color:#ffd6d6}
    button.ca-dig-btn{all:unset;cursor:pointer;margin-left:auto;color:#9cc8ff;font:600 12px system-ui,sans-serif;min-height:28px;display:flex;align-items:center}
    button.ca-dig-btn:focus-visible{outline:2px solid #9cc8ff;outline-offset:2px}
    .ca-dig{display:grid;border-top:1px solid #33332f}.ca-dig details{border-bottom:1px solid #33332f}
    .ca-dig summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:6px;padding:8px 0;font:600 12px system-ui,sans-serif;color:#c3c2b7}
    .ca-dig summary::-webkit-details-marker{display:none}.ca-dig .ca-sub{margin-left:auto;color:#8f8e86;font-weight:500;text-align:right}
    .ca-dig .ca-car2{color:#8f8e86;display:inline-block;transition:transform .15s}.ca-dig details[open] .ca-car2{transform:rotate(90deg)}
    .ca-dig .ca-body{padding:0 0 10px;font-size:12px;color:#c3c2b7;display:grid;gap:4px}
    .ca-kv{display:flex;justify-content:space-between;gap:10px;font-variant-numeric:tabular-nums}.ca-kv span:last-child{text-align:right}
    .ca-card > .ca-body{display:grid;gap:4px;font-size:12px;color:#c3c2b7}.ca-kvl{display:grid;grid-template-columns:auto 1fr;gap:10px}.ca-kvl span:first-child{color:#8f8e86}
    .ca-pop.ca-sheet{left:0!important;right:0;bottom:0;top:auto!important;width:auto;max-height:75vh;border-radius:14px 14px 0 0;
      padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}
    .ca-meth{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-bottom:4px}
    .ca-meth th{color:#8f8e86!important;font:500 11px system-ui,sans-serif!important;text-align:right;padding:2px 4px;background:none!important}.ca-meth th:first-child{text-align:left}
    .ca-meth td{color:#f3f3f1!important;font-size:12px!important;text-align:right;padding:3px 4px;white-space:nowrap;background:none!important}
    .ca-meth td:first-child{text-align:left}.ca-meth tr.ca-pick td{font-weight:700;color:#9ff0c2!important}
    .ca-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:0}
    .ca-mdot{position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 2px #1a1a19;pointer-events:none;z-index:2}
    .ca-mdot.ca-ring{top:-3px;right:-3px;bottom:-3px;left:-3px;width:auto;height:auto;border:2px solid #2fbf71;box-shadow:none;background:none;z-index:1}
    .ca-flash{animation:caflash 1.6s ease-out 2}
    @keyframes caflash{0%{box-shadow:inset 0 0 0 2px #9cc8ff,0 0 0 2px #9cc8ff;background-color:rgba(156,200,255,.16)}100%{box-shadow:none;background-color:transparent}}
    @media (prefers-reduced-motion:reduce){.ca-dig .ca-car2{transition:none}.ca-flash{animation-duration:.01s}}
    /* Torn's own stylesheet (dark mode tables, headings) wins otherwise: pin what matters */
    .ca-panel td{color:#f3f3f1!important;background:none!important;font-size:13px!important}
    .ca-panel th,.ca-panel .ca-muted,.ca-panel .ca-sec{color:#8f8e86!important}
    .ca-panel .ca-err{color:#ff9b8f!important}
    .ca-panel h4{font:600 13px/1.4 system-ui,sans-serif!important;color:#9cc8ff!important;text-transform:none!important;letter-spacing:0!important}
    .ca-panel input{color:#f3f3f1!important;background:#111!important}`;
  document.head.appendChild(style);

  // ---------------- the panel: best crimes, key, sync status, your $/nerve by crime ----------------
  let panel = null;
  const btn = $("button", "ca-btn");
  btn.append($("span", "ca-bt", "Crime Advisor"));
  btn.type = "button";
  if (onCrimes) body.appendChild(btn);
  btn.onclick = () => { if (panel) { panel.remove(); panel = null; } else { setTimeout(() => { clearAt = 0; bottomClear(); }, 0); panel = $("div", "ca-panel"); body.appendChild(panel); renderPanel(); } };
  setInterval(async () => {  // while the panel is open: another tab's progress shows up here too
    if (!panel) return;
    const typing = panel.querySelector("input");
    if (typing && (typing.value || document.activeElement === typing)) return;
    if (!syncing && get("sync", {}).oldest !== (lastOldest ?? get("sync", {}).oldest)) await recompute();
    lastOldest = get("sync", {}).oldest;
    renderPanel();
  }, 5000);
  let lastOldest = null, keyOpen = false, keyErr = "";  // (keyOpen: the saved key's controls shown, after "Change")
  const bestBox = $("div", "ca-best");  // (kept between redraws of the panel: drawBest() fills it)

  // The panel, top to bottom: your average (the line every grade is measured against), best crimes here and elsewhere,
  // your crimes as bars (one number each), then the housekeeping in a quiet footer: logs, sync, the key.
  function renderPanel() {
    if (!panel) return;
    panel.replaceChildren();
    const key = get("key", ""), avg = (values && values.overall) || 0;
    const h = $("div", "ca-ph"), x = $("button", "ca-x", "\u2715");
    x.type = "button"; x.setAttribute("aria-label", "Close");
    x.onclick = () => { panel.remove(); panel = null; };
    h.append($("b", "", "Crime Advisor"));
    if (key && avg) {
      const a = $("span", "ca-avg");
      a.append($("i"), `your avg ${short(avg)}/n`);
      a.title = "Your average $/nerve across all crimes. Grades are measured against it; it's the line on each bar below.";
      h.append(a);
    }
    h.append(x);
    panel.append(h);
    if (priceDenied) {  // (a log-only key from 1.x: everything it found counts as $0 until it can read prices)
      panel.append($("div", "ca-err ca-alert", "This key can't read item prices, so items count as $0. Make a new key below."));
      keyOpen = true;
    }
    panel.append(bestBox);
    if (!key) {
      const onb = $("div", "ca-onb");
      onb.append($("b", "", "See your own $/nerve"), $("div", "ca-muted", "Grades every crime option from your own logs. Arson recipes work without a key."), keyForm(""), aboutBrowser());
      panel.append(onb);
      return;
    }
    if (summary && summary.logs) panel.append(yourCrimes(avg));
    panel.append(footer(key));
  }

  // Your crimes, stacked by what they're for (Aaron, 2026-10-17: "I have cash cow crimes and then progression crimes"):
  //  Earn: at or above your average $/nerve (over 30 days or all time), a $/nerve bar each, best first;
  //  Level up: still progressing (skill under 100, or uniques left), a skill bar each, nearest to done first;
  //  Done: finished and below your average, one quiet line.
  // Skill is from Torn's level-up logs. Uniques left: the count Torn's banner showed when the crime's page was last
  // open, else your unique logs against each crime's total (torn.report, 2026-10).
  const UQ_TOTAL = { 1: 34, 2: 4, 3: 41, 4: 60, 5: 22, 7: 34, 9: 11, 13: 16 };
  const more = { earn: false, up: false, uq: false };
  function yourCrimes(avg) {
    const box = $("div", "ca-yours"), p = get("period", "30") === "all" ? "all" : "30";
    const all = Object.fromEntries(summary.all.crimes.map(c => [c.id, c])), month = Object.fromEntries(summary.month.crimes.map(c => [c.id, c]));
    if (!avg) avg = summary.all.total.per_nerve || 0;
    const skill = summary.all.skill || {}, seenUq = get("uq", {});
    const earn = [], up = [], uq = [], done = [], histDone = !!get("sync", {}).done;
    let waiting = 0;
    for (const c of summary.all.crimes) {
      if (!c.id || !(c.nerve > 0) || c.per_nerve == null) continue;
      const k = CA.slug(c.name), mo = month[c.id];
      const recent = p === "30" && mo && mo.nerve > 0 && mo.per_nerve != null;
      const pn = p === "all" || recent ? (recent ? mo.per_nerve : c.per_nerve) : null;  // (30 days: nothing done, no number)
      const s = skill[k] != null ? skill[k] : null;
      // (uniques from your logs only once all your history is in: half-loaded, every crime looks unfound)
      const total = seenUq[k] ? seenUq[k][1] : histDone ? UQ_TOTAL[c.id] || 0 : 0, found = seenUq[k] ? seenUq[k][0] : Math.min(c.uniques || 0, total);
      const row = { c, k, pn, s, left: Math.max(0, total - found), total };
      const tip = `${c.name}: ${short(c.per_nerve)}/nerve all time \u00b7 `
        + (mo && mo.nerve ? `${short(mo.per_nerve)}/nerve over 30 days (${mo.nerve.toLocaleString()} nerve)` : "none in the last 30 days")
        + (s != null ? ` \u00b7 skill ${s}/100` : "") + (total ? ` \u00b7 uniques ${total - row.left}/${total}` : "");
      row.tip = tip;
      if (pn != null && pn > 0 && pn >= avg) earn.push(row);
      else if (s == null && !histDone) waiting++;  // (its skill logs are further back: not loaded yet)
      else if (s == null || s < 100) up.push(row);
      else if (row.left > 0) uq.push(row);
      else done.push(row);
    }
    earn.sort((a, b) => b.pn - a.pn);
    const nerve30 = r => (month[r.c.id] || {}).nerve || 0;
    up.sort((a, b) => nerve30(b) - nerve30(a) || (b.s ?? -1) - (a.s ?? -1));
    uq.sort((a, b) => a.left - b.left);

    // Earn
    const hd = $("div", "ca-yh"), lab = $("div", "ca-sec", "Earn ");
    lab.append($("span", "", "\u00b7 your cash crimes"));
    lab.title = "At or above your average $/nerve. Items at today's market prices; scamming includes spam waves and email farming. The line on each bar is your average.";
    const seg = $("div", "ca-seg");
    for (const [v, l] of [["30", "30 days"], ["all", "All time"]]) {
      const b = $("button", v === p ? "on" : "", l);
      b.type = "button"; b.setAttribute("aria-pressed", String(v === p));
      b.onclick = e => { e.stopPropagation(); set("period", v); more.earn = false; renderPanel(); };
      seg.append(b);
    }
    hd.append(lab, seg);
    box.append(hd);
    const link = (c, extra) => {
      const a = $("a", "", c.name);
      a.href = `/page.php?sid=crimes#/${CA.slug(c.name)}`;
      if (extra) a.append(extra);
      return a;
    };
    const toggle = (list, which, n, quiet) => {
      if (list.length <= n && !quiet) return null;
      const m = $("div", "ca-more");
      if (list.length > n) {
        const b = $("button", "ca-link", more[which] ? "Fewer \u25b4" : `All ${list.length} \u25be`);
        b.type = "button"; b.onclick = e => { e.stopPropagation(); more[which] = !more[which]; renderPanel(); };
        m.append(b);
      } else m.append($("span"));
      if (quiet) m.append($("span", "ca-muted", quiet));
      return m;
    };
    if (!earn.length) box.append($("div", "ca-muted ca-none", p === "30" ? "Nothing at your average in the last 30 days." : "Nothing at your average yet."));
    else {
      const max = Math.max(avg, ...earn.map(r => r.pn), 1), ul = $("ul", "ca-bars");
      for (const r of more.earn ? earn : earn.slice(0, 5)) {
        const li = $("li"), trk = $("span", "ca-bar"), fill = $("span", "A");
        fill.style.width = `${r.pn / max * 100}%`;
        trk.append(fill);
        if (avg > 0) { const t = $("i"); t.style.left = `${avg / max * 100}%`; trk.append(t); }
        li.title = r.tip;
        li.append(link(r.c), trk, $("span", "ca-bv", short(r.pn)));
        ul.append(li);
      }
      box.append(ul);
      const t = toggle(earn, "earn", 5, "");
      if (t) box.append(t);
    }

    // Level up: skill under 100, the ones you're working on (most nerve in 30 days) first; then Uniques: skill 100
    // but one-time uniques still to find, fewest left first (Aaron, 2026-10-17: the skill-100 ones hid his active skills)
    const bars = (list, which, n, label, sub, tip, draw) => {
      if (!list.length) return;
      const lab2 = $("div", "ca-sec ca-sec2", `${label} `);
      lab2.append($("span", "", `\u00b7 ${sub}`));
      lab2.title = tip;
      const ul = $("ul", "ca-bars ca-up");
      for (const r of more[which] ? list : list.slice(0, n)) {
        const li = $("li"), trk = $("span", "ca-bar"), right = $("span", "ca-bv ca-sk");
        li.title = r.tip;
        draw(r, trk, right);
        li.append(link(r.c), trk, right);
        ul.append(li);
      }
      box.append(lab2, ul);
      const t = toggle(list, which, n, "");
      if (t) box.append(t);
    };
    bars(up, "up", 4, "Level up", "skill to 100",
      "Skill under 100, from Torn's level-up logs. The crimes you've spent most nerve on in 30 days come first.", (r, trk, right) => {
        const fill = $("span", "sk");
        fill.style.width = `${r.s || 0}%`;
        trk.append(fill);
        if (r.left > 0) right.append($("span", "ca-uqn", `\u2605${r.left} `));
        right.append(r.s == null ? "?" : `${r.s}`);
      });
    bars(uq, "uq", 3, "Uniques", "left to find",
      "Skill 100, with one-time unique outcomes still to find. From the crime's banner when you last opened it, else your logs.", (r, trk, right) => {
        const fill = $("span", "uq");
        fill.style.width = `${(r.total - r.left) / r.total * 100}%`;
        trk.append(fill);
        right.className = "ca-bv ca-uqv";
        right.append(`\u2605${r.left} left`);
      });

    if (waiting) box.append($("div", "ca-muted ca-none", `+${waiting} more once your history has loaded`));

    // Done: one line
    if (done.length) {
      const d = $("div", "ca-done");
      d.append($("span", "ca-sec", "Done "));
      done.sort((a, b) => (b.pn ?? -1e9) - (a.pn ?? -1e9)).forEach((r, i) => {
        const a = link(r.c);
        a.title = `${r.tip} \u00b7 below your average`;
        if (i) d.append(", ");
        d.append(a);
      });
      box.append(d);
    }
    return box;
  }

  // the footer: logs stored, how far back, the sync's state (a thin bar while history re-reads), the key
  function footer(key) {
    const f = $("div", "ca-foot"), st = get("sync", {});
    if (syncing && syncPct != null) { const pr = $("div", "ca-prog"), s = $("span"); s.style.width = `${syncPct}%`; pr.append(s); f.append(pr); }
    const row = $("div", "ca-frow"), info = $("span", "ca-muted");
    const other = !syncing && lockNow().busy && lockNow().by !== TAB;
    const bits = [summary ? `${summary.logs.toLocaleString()} logs` : "",
      st.oldest ? `since ${new Date(st.oldest * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" })}` : ""].filter(Boolean);
    info.append(bits.join(" \u00b7 "));
    const state = syncError ? $("span", "ca-err", `sync problem: ${syncError}`)
      : syncing ? $("span", "", `${syncNote || "checking for new logs"}\u2026`)
      : other ? $("span", "", "loading in another tab\u2026")
      : st.done ? $("span", "ca-ok", "\u2713 up to date") : $("span", "", "more loads while Torn is open");
    if (bits.length) info.append(" \u00b7 ");
    info.append(state);
    const tog = $("button", "ca-link", keyOpen ? "Hide key" : pdaKey && key === pdaKey ? "PDA's key \u00b7 Change" : "Key \u00b7 Change");
    tog.type = "button"; tog.setAttribute("aria-expanded", String(keyOpen));
    tog.onclick = e => { e.stopPropagation(); keyOpen = !keyOpen; keyErr = ""; renderPanel(); };
    row.append(info, tog);
    f.append(row);
    if (memoryOnly) f.append($("div", "ca-muted", "This browser blocks site storage here (a private window?): logs are re-read each visit."));
    const auto = $("label", "ca-auto"), cb = $("input");
    cb.type = "checkbox"; cb.checked = !!get("autoOpen", false);
    cb.onchange = () => set("autoOpen", cb.checked);
    auto.append(cb, "Open automatically on crime pages");
    f.append(auto, aboutBrowser());
    if (keyOpen) f.append(keyForm(key));
    return f;
  }

  // "About this browser": what Crime Advisor is running in and how it's getting on, to copy into a bug report (and
  // for testing in Torn PDA, where there's no console to look at)
  let aboutOpen = false;
  function diagnostics() {
    const gi = typeof GM_info !== "undefined" ? GM_info : null, st = get("sync", {}), ago = t => `${Math.round((Date.now() - t) / 1000)} s ago`;
    return [
      ["Crime Advisor", (gi && gi.script && gi.script.version) || "?"],
      ["Runs in", PDA ? "Torn PDA" : gi && gi.scriptHandler ? `${gi.scriptHandler} ${gi.version || ""}`.trim() : "unknown"],
      ["Settings kept in", PDA ? "IndexedDB (Torn PDA)" : noGM ? "torn.com storage" : "the userscript manager"],
      ["Key", !get("key", "") ? "none" : pdaKey && get("key", "") === pdaKey ? "Torn PDA's" : "saved here"],
      ["Logs kept in", memoryOnly ? "memory only (storage blocked)" : "IndexedDB"],
      ["Logs", `${summary ? summary.logs.toLocaleString() : "?"}${st.done ? ", all history" : ", history loading"}`],
      ["Last request", lastNet ? `${lastNet.host} by ${lastNet.via}: ${lastNet.ok ? `HTTP ${lastNet.status}` : lastNet.err}, ${ago(lastNet.at)}` : "none yet"],
      ["Sync", syncError ? `problem: ${syncError}` : syncing ? syncNote || "running" : "idle"],
      ["This page", pageDiag()],
      ["Bottom bar", barSeen],
      ["Screen", `${innerWidth}\u00d7${innerHeight}, ${matchMedia("(hover: none)").matches ? "touch" : "mouse"}, ${LOW ? "low-end device" : "normal device"}`],
      ["Browser", navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 120)],
    ];
  }
  // On a crime page: the options it knows for this crime, how many of their names it found on the page, the chips on
  // it; and (copied only) how the first name it found sits in Torn's page: tag and class names, nothing personal
  function pageDiag() {
    if (!tab) return "the Crimes hub";
    const k = tabKey(tab), rows = (values && values.tabs && values.tabs[k]) || [], text = (crimeRoot().innerText || "").toLowerCase();
    const found = rows.filter(r => (r.find || [r.kind]).some(f => text.includes(String(f).toLowerCase())));
    return `${k}: ${rows.length} options known, ${found.length} named on the page, ${document.querySelectorAll(".ca-chip").length} chips, ` +
      `${onPage.length} graded (read from ${["the crimes app", "the content area", "the whole page"][rootWide]})`;
  }
  function pageOutline() {
    if (!tab) return "";
    const k = tabKey(tab), rows = (values && values.tabs && values.tabs[k]) || [];
    const names = rows.flatMap(r => r.find || [r.kind]).map(f => String(f).toLowerCase());
    const w = document.createTreeWalker(crimeRoot(), NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim().toLowerCase();
      if (t.length < 3 || !names.includes(t) || n.parentElement.closest(OURS)) continue;
      const chain = [];
      for (let e = n.parentElement, i = 0; e && i < 7; e = e.parentElement, i++) {
        const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
        chain.push(e.tagName.toLowerCase() + cls);
      }
      return `"${n.nodeValue.trim()}" in ${chain.join(" < ")}`;
    }
    return "no option name found as a whole text";
  }
  function aboutBrowser() {
    const d = $("details", "ca-about"), s = $("summary", "", "About this browser");
    d.open = aboutOpen;
    d.ontoggle = () => { aboutOpen = d.open; };
    const rows = diagnostics(), dl = $("div", "ca-diag");
    for (const [k, v] of rows) { const r = $("div", "ca-kv"); r.append($("span", "", k), $("span", "", v)); dl.append(r); }
    const copy = $("button", "ca-link", "Copy for a bug report");
    copy.type = "button";
    copy.onclick = e => {
      e.stopPropagation();
      const outline = pageOutline(), text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") + (outline ? `\nOutline: ${outline}` : "");
      const done = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy for a bug report"; }, 2000); };
      const pdaCopy = PDA && window.flutter_inappwebview && window.flutter_inappwebview.callHandler;  // (PDA's own: the webview's can fail)
      try { (pdaCopy ? window.flutter_inappwebview.callHandler("copyToClipboard", text) : navigator.clipboard.writeText(text)).then(done, () => { copy.textContent = "Couldn't copy: select the lines above"; }); }
      catch (err) { copy.textContent = "Couldn't copy: select the lines above"; }
    };
    d.append(s, dl, copy);
    return d;
  }

  // Phones can't hover: on a touch screen, tapping something in the panel with a tip shows the tip
  let tipEl = null;
  function showTip(host, text) {
    if (tipEl) tipEl.remove();
    tipEl = $("div", "ca-tip", text);
    body.appendChild(tipEl);
    const r = host.getBoundingClientRect(), w = Math.min(300, innerWidth - 16);
    tipEl.style.width = `${w}px`;
    tipEl.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    const below = r.bottom + 6, h = tipEl.offsetHeight;
    tipEl.style.top = `${below + h < innerHeight - 8 ? below : Math.max(8, r.top - h - 6)}px`;
    const mine = tipEl;
    setTimeout(() => { if (tipEl === mine) { mine.remove(); tipEl = null; } }, 5000);
  }
  document.addEventListener("click", e => {
    if (!matchMedia("(hover: none)").matches) return;
    const t = e.target.closest && e.target.closest(".ca-panel [title]");
    if (!t || t.closest("a, button, input, label, summary") || !t.title) { if (tipEl && !e.target.closest(".ca-tip")) { tipEl.remove(); tipEl = null; } return; }
    showTip(t, t.title);
  }, true);

  // the key: make one on Torn (the link pre-fills a Custom key: logs + item prices), paste it, save
  function keyForm(key) {
    const w = $("div", "ca-keyform");
    const mk = $("a", "ca-mk");
    mk.append($("span", "", "1 \u00b7 Make a key on Torn"), $("span", "ca-muted", "logs + item prices \u2197"));
    mk.href = KEY_LINK; mk.target = "_blank"; mk.rel = "noopener";
    const r = $("div", "ca-krow"), inp = $("input");
    inp.type = "password"; inp.autocomplete = "off";
    inp.placeholder = key ? "2 \u00b7 Paste a new key to replace it" : "2 \u00b7 Paste it here";
    inp.setAttribute("aria-label", "Torn API key");
    const save = $("button", "ca-pbtn", "Save");
    save.type = "button";
    save.onclick = async () => {
      const v = inp.value.trim();
      if (!/^[A-Za-z0-9]{16}$/.test(v)) { keyErr = "A Torn API key is 16 letters and numbers."; renderPanel(); return; }
      const before = get("key", "");
      set("key", v); inp.value = ""; keyErr = "";
      try { await api("/user/log", { cat: 136, limit: 1 }); } catch (e) { set("key", before); keyErr = `That key doesn't work: ${e.message}`; renderPanel(); return; }
      keyOpen = false; priceDenied = false;
      renderPanel(); start();
    };
    inp.onkeydown = e => { if (e.key === "Enter") save.click(); };
    r.append(inp, save);
    w.append(mk, r);
    if (keyErr) w.append($("div", "ca-err", keyErr));
    w.append($("div", "ca-muted", "It stays in this browser and is only sent to api.torn.com."));
    if (key) {
      const forget = $("button", "ca-link ca-danger", "Remove key and stored logs");
      forget.type = "button";
      forget.onclick = async () => { if (!confirm("Remove your key and the crime logs stored in this browser?")) return;
        set("key", ""); if (pdaKey) set("pdaKeyOff", true); set("sync", { v: 4, newest: null, oldest: null, done: false }); keyOpen = false; await idb.clear(); await recompute(); renderPanel(); };
      w.append(forget);
    }
    return w;
  }

  if (onCrimes && get("key", "") && get("autoOpen", false)) btn.onclick();  // (the footer's "Open automatically")

  // ---------------- the crime pages: a grade chip per option, a card behind it ----------------
  // Crime Advisor's own additions: the page watcher and the readers skip them, so a chip going in or changing doesn't
  // look like Torn redrawing its page. TornBrain's (for a player running both) are skipped by the readers too.
  const OURS = ".ca-badge, .ca-pop, .ca-mdot, .ca-panel, .ca-btn, .ca-tip";
  const SKIP = OURS + ", .tb-sb, .tb-badge, .tb-pb, .tb-pop, .tb-choices, .tb-mdot, .tb-uqstar";
  const ownMutation = m => !!(m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.(SKIP) ||
    (m.addedNodes.length + m.removedNodes.length > 0 && [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType === 1 && n.matches(SKIP)));
  const tabKey = t => (t || "").replace(/[^a-z]/gi, "").toLowerCase();
  const current = () => (location.hash.match(/^#\/([a-z-]+)/i) || [])[1] || null;
  // Where the crime's options are: the crimes app. On a phone it didn't hold the job list (Aaron's iPhone in Torn PDA,
  // Disposal: none of the names on show were in it), so when a crime's options are on the page but not in there, the
  // search widens: Torn's content area, then the whole page.
  let rootWide = Math.min(2, +get("rootWide", 0) || 0), widenAt = 0;
  const crimeRoot = () => (rootWide < 1 && document.querySelector("[class*='crimes-app'], #react-root, .content-wrapper"))
    || (rootWide < 2 && document.querySelector(".content-wrapper")) || body;
  function widenRoot(k) {
    if (rootWide >= 2 || onPage.length || !values || !values.tabs || !(values.tabs[k] || []).length) return;
    const names = values.tabs[k].flatMap(r => r.find || [r.kind]).map(f => String(f).toLowerCase());
    const has = el => { const t = ((el && el.innerText) || "").toLowerCase(); return names.some(f => t.includes(f)); };
    if (has(crimeRoot()) || !has(body)) return;
    // straight to the first that holds them, and remembered on this device (the phone took a while, a step at a time)
    rootWide = has(document.querySelector(".content-wrapper")) ? 1 : 2;
    set("rootWide", rootWide);
    schedule();
  }
  let tab = null, since = 0;

  // Disposal: each method's reliability, nerve and expected $/nerve (the card's Methods). How reliable a method is
  // (the community chart blended with your own record): the chart's colours.
  const RELY = p => p == null ? ["#6e7681", "not enough data"] : p >= 0.9 ? ["#3fb950", "very likely to work"]
    : p >= 0.78 ? ["#e3d341", "works, with caution"] : p >= 0.5 ? ["#e8913a", "works but fails often"] : ["#e5484d", "fails almost every time"];
  function methodTable(v) {
    const box = $("div"), t = $("table", "ca-meth"), hr = $("tr"), pk = pickOf(v);
    ["", "Works", "Nerve", "Expected", "Crits"].forEach(h => hr.append($("th", "", h)));
    t.append(hr);
    for (const m of v.methods) {
      const tr = $("tr"), name = $("td");
      if (m === pk) tr.className = "ca-pick";  // (the one to use)
      if (!m.available) { name.append($("span", "ca-muted", `${m.method}: not available for this job`)); name.colSpan = 5; tr.append(name); t.append(tr); continue; }
      const [col, word] = RELY(m.p), dot = $("span", "ca-dot");
      dot.style.background = col; dot.title = word;
      name.append(dot, m.method + (m.star ? " \u2605" : ""));
      if (m.star) name.title = "A unique outcome can turn up here";
      const cell = (txt, tip) => { const td = $("td", "", txt); if (tip) td.title = tip; return td; };
      tr.append(name,
        cell(m.p == null ? "\u2013" : `${Math.round(m.p * 100)}%`, `${word}: ${m.tries ? `${m.ok} of your ${m.tries} worked` : "you haven't tried it"}; the community chart counts as 8 tries`),
        cell(String(Math.round(m.nerve))),
        cell(m.ev == null ? "\u2013" : `${m.tries ? "" : "~"}${short(m.ev)}/n`, m.tries ? "chance it works x what the job pays, less the materials you used, over the nerve" : "chance it works x what the job pays, over the nerve: before materials (you have not tried it, so their cost is unknown)"),
        cell(m.tries ? String(m.crits) : "\u2013", "critical fails: jail or hospital"));
      t.append(tr);
    }
    box.append(t, $("div", "ca-muted", (v.pay ? `This job pays you ~${short(v.pay)} whichever way. ` : "") +
      "Cheaper methods can beat surer ones per nerve. Colours: the community chart, updated by your own results."));
    return box;
  }

  // ---- unique outcomes: one-time results. Each pays once, so $/nerve leaves them out. The crime's count from Torn's
  // banner ("Unique outcomes: 55 / 60", read without a click) goes beside its name; a spot Torn stars as having one
  // waiting gets a filled star in its chip.
  const UQ_RE = /^Unique outcomes:\s*(\d+)\s*\/\s*(\d+)/i;
  const isStar = x => { const l = x.getAttribute("aria-label") || ""; return /unique outcome/i.test(l) && !UQ_RE.test(l) && !x.closest(SKIP); };
  function uniquesOnPage(root) {
    const b = [...root.querySelectorAll("[aria-label]")].find(x => UQ_RE.test(x.getAttribute("aria-label")));
    const m = b && b.getAttribute("aria-label").match(UQ_RE);
    return m ? { found: +m[1], total: +m[2] } : null;
  }
  const uqTip = u => (u.found >= u.total ? `All ${u.total} one-time unique outcomes found. `
    : `One-time unique outcomes: you've found ${u.found} of ${u.total} (${u.total - u.found} left). `) +
    "Each pays once, so Crime Advisor leaves them out of $/nerve. Torn stars a spot when one is waiting there: its chip shows a gold star.";
  const SVGNS = "http://www.w3.org/2000/svg";
  function starCheck() {  // all found: a gold star with a check mark in it
    const s = document.createElementNS(SVGNS, "svg"), star = document.createElementNS(SVGNS, "path"), tick = document.createElementNS(SVGNS, "path");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "13"); s.setAttribute("height", "13"); s.setAttribute("aria-hidden", "true");
    s.style.cssText = "vertical-align:-2px";
    star.setAttribute("d", "M12 1.5l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.6l-6.4 3.5L7 14 1.7 9l7.2-.9z");
    star.setAttribute("fill", "#e3b341");
    tick.setAttribute("d", "M8 12.4l2.8 2.7 5.2-5.7");
    for (const [k, v] of [["fill", "none"], ["stroke", "#241a00"], ["stroke-width", "2.4"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) tick.setAttribute(k, v);
    s.append(star, tick);
    return s;
  }
  // The Crimes hub: each crime's card gets its uniques left ("\u2605 5 left"; all found: the star with its check), as Torn's
  // banner counted them when that crime was last open, else from your logs against the crime's total.
  function hubUniques(root) {
    // (from your logs only once all your history is in: half-loaded, every crime looks unfound; Aaron's phone showed
    // Shoplifting "59 left" two minutes into loading)
    const seen = get("uq", {}), histDone = !!get("sync", {}).done, logs = summary ? Object.fromEntries(summary.all.crimes.map(c => [CA.slug(c.name), c])) : {};
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), done = new Set(), hosts = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim(), k = tabKey(t), host = n.parentElement;
      if (t.length < 4 || t.length > 30 || done.has(k) || !host || host.closest(SKIP) || !host.closest("a[href*='#/']")) continue;
      let u = seen[k] ? { found: seen[k][0], total: seen[k][1], est: false } : null;
      if (!u && histDone && logs[k] && UQ_TOTAL[logs[k].id]) u = { found: Math.min(logs[k].uniques || 0, UQ_TOTAL[logs[k].id]), total: UQ_TOTAL[logs[k].id], est: true };
      if (!u || !u.total) { host.querySelector(":scope > .ca-hubuq")?.remove(); continue; }
      done.add(k);
      hosts.push([host, u, k]);
    }
    for (const [host, u, k] of hosts) {
      const all = u.found >= u.total, key = `${u.found}/${u.total}`;
      let b = host.querySelector(":scope > .ca-uq");
      if (b && b.dataset.k === key) continue;
      if (!b) { b = $("span"); b.dataset.tab = "hub"; host.appendChild(b); }
      b.dataset.k = key;
      b.className = `ca-badge ca-uq ca-hubuq${all ? "" : " ca-gold"}`;
      b.replaceChildren(...(all ? [starCheck()] : [`\u2605 ${u.total - u.found} left`]));
      b.title = uqTip(u) + (u.est ? " (From your logs: open the crime once for Torn's own count.)" : "");
    }
  }
  // The hub also lists Disposal's jobs on offer ("General Waste: 4"): kept as what Disposal shows, so "Better
  // elsewhere" only offers jobs there today. None listed (all done for the day): none offered.
  let hubLast = "";
  function hubSeen(root) {
    // (wait until the hub's cards have their labels: a card drawn before its labels isn't "no jobs")
    const card = root.querySelector("a[href='#/disposal']");
    if (!card || !root.querySelector("a[href*='#/'] [aria-label]")) return;
    const jobs = [...card.querySelectorAll("[aria-label]")].map(x => x.getAttribute("aria-label")).filter(l => /:\s*\d+$/.test(l) && !/:\s*0$/.test(l));
    const text = jobs.length ? jobs.join(" \u00b7 ") : "no jobs on offer";
    if (text === hubLast) return;
    hubLast = text;
    const seen = get("seen", {});
    if ((seen.disposal || {}).text === text) return;
    seen.disposal = { text, at: Date.now(), from: "hub" };
    set("seen", seen);
    if (values) { values.leaders = CA.leaders(values.tabs, seen); schedule(); }
  }
  // A leaf element whose text is the crime's name (the page title or its banner): where its count and grade go.
  const nameEl = (root, k) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim();
      if (t.length >= 4 && t.length <= 30 && tabKey(t) === k && n.parentElement && !n.parentElement.closest(SKIP)) return n.parentElement;
    }
    return null;
  };
  function headerUniques(root, k) {
    const u = uniquesOnPage(root);
    if (!u) return;
    const seen = get("uq", {});  // (kept for the panel's Level up: uniques left per crime, as Torn counts them)
    if (String(seen[k]) !== `${u.found},${u.total}`) set("uq", { ...seen, [k]: [u.found, u.total] });
    if (!u.total) { root.querySelector(".ca-uq")?.remove(); return; }  // (Forgery has none: no "0/0 uniques")
    let b = root.querySelector(".ca-uq");
    if (!b) {
      const host = nameEl(root, k);
      if (!host) return;
      b = $("span", "ca-badge ca-uq");
      b.dataset.tab = k;
      host.appendChild(b);
    }
    const done = u.found >= u.total, key = `${u.found}/${u.total}`;
    if (b.dataset.k !== key) {
      b.dataset.k = key; b.title = uqTip(u);
      b.replaceChildren(...(done ? [starCheck(), ` ${key} uniques`] : [`\u2605 ${key} uniques`]));
      b.className = `ca-badge ca-uq${done ? "" : " ca-gold"}`;
    }
  }

  // A phone's narrow picker can push a chip past its edge (Aaron's iPhone, Forgery's projects: "Ordination Certificate
  // C $2.4..." cut off): then the chip keeps its tier alone; the number is in its label and its card.
  // (measured with the number shown, once the picker has finished opening: mid-animation every chip looked too wide)
  function fitChip(b) {
    if (!b.isConnected) return;
    b.classList.remove("mini");
    let clip = b.parentElement;
    while (clip && clip !== body) {
      const cs = getComputedStyle(clip);
      if (cs.overflowX !== "visible" || cs.overflow !== "visible") break;
      clip = clip.parentElement;
    }
    const edge = clip && clip !== body ? clip.getBoundingClientRect().right : innerWidth;
    // past the list's edge, or squeezed by the row (Disposal on a phone: "C $26..." between the name and the icons)
    // ...or pushed onto a line of its own under a long name (a phone's rows are one line high)
    let wrapped = false;
    const tn = [...b.parentElement.childNodes].find(x => x.nodeType === 3 && x.nodeValue.trim());
    if (tn) {
      const r = document.createRange(); r.selectNodeContents(tn);
      const lines = r.getClientRects(), last = lines[lines.length - 1];
      if (last) wrapped = b.getBoundingClientRect().top >= last.bottom - 2;
    }
    b.classList.toggle("mini", b.getBoundingClientRect().right > edge - 2 || b.scrollWidth > b.clientWidth + 1 || wrapped);
  }
  // ---- the chip on each option (Glance): a tier and one number. The tier compares it with your average $/nerve
  // across all crimes (values.overall); S is also the best of the options on show.
  const TILE = { S: "S", A: "A", B: "B", C: "C", X: "\u2715", Q: "?", W: "\u26a0", G: "\u2713" };
  const TIERWORD = { S: "best here, above your average", A: "above your average", B: "half to all of your average",
    C: "under half your average", X: "loses money", Q: "little history yet", W: "careful", G: "ready to collect" };
  // Your way lost money but the community recipe pays: judged by the recipe, shown as an estimate (~).
  const recipeOver = v => !v.few && v.per_nerve < 0 && !!v.community && v.community.per_nerve > 0;
  // Disposal: judged by the best method's expected $/nerve (reliability x pay - materials, over its nerve), not your
  // own history (a Vehicle you'd mostly abandoned can lose money; burning it pays).
  const VERBS = { Abandoning: "Abandon", Burying: "Bury", Burning: "Burn", Sinking: "Sink", Dissolving: "Dissolve" };
  const pickOf = v => (v.methods || []).reduce((b, m) => m.available && m.ev != null && (!b || m.ev > b.ev) ? m : b, null);
  const pnOf = v => { const m = pickOf(v); return m ? m.ev : recipeOver(v) ? v.community.per_nerve : v.per_nerve; };
  // The nerve a job takes start to finish: the method's (Disposal), the recipe's, else yours (what you made over your
  // $/nerve). Flagged when it's more than you have now.
  const nerveFor = v => (pickOf(v) && Math.round(pickOf(v).nerve)) ||
    (v.community && v.community.nerve) || (v.per_nerve > 0 && v.avg_net > 0 ? Math.round(v.avg_net / v.per_nerve) : null);
  const nerveNow = () => {  // Torn's sidebar bar: "Nerve: 9/125"
    for (const p of document.querySelectorAll("[class*='bar-name']")) {
      if (!/^nerve/i.test(p.textContent.trim())) continue;
      const m = ((p.parentElement && p.parentElement.textContent) || "").match(/(\d+)\s*\/\s*(\d+)/);
      if (m) return +m[1];
    }
    return null;
  };
  function tierOf(v, best, short100, noFT, collect) {
    const pn = pnOf(v);
    if (short100 || (!v.few && pn < 0)) return "X";
    if (collect && v.avg_net) return "G";
    if (noFT) return "W";
    if (v.few) return "Q";
    const avg = values && values.overall;
    if (!(avg > 0)) return v.worth ? "A" : "B";
    if (pn >= avg) return pn >= best ? "S" : "A";
    return pn >= avg / 2 ? "B" : "C";
  }
  const chipText = (v, tier, short100, pct) => short100 ? `${pct}% short` : tier === "G" ? `collect ${short(v.avg_net)}`
    : v.few ? (v.per_nerve != null && v.source === "community" ? `~${short(v.per_nerve)}/n` : "new")
    : recipeOver(v) ? `~${short(pnOf(v))}/n` : `${short(pnOf(v))}/n`;
  // Where the chip goes: after the name, except on Arson, where the job's name is long and the chip wrapped to a third
  // line: there it goes on the place's line above ("Theater"), which is always short. Forgery: after the step label.
  const chipSlot = (host, k) => {  // (its own text only, and Torn's buttons only: once the chip is in, it's still the slot)
    if (k === "forgery") {  // after "Step #2: Casting" (the name's column is narrow); the project picker has no step
      for (let r = host.parentElement, i = 0; r && i < 6; r = r.parentElement, i++) {
        // (React splits the label's text: "Step #", "2", ": ", "Casting": its own text nodes, joined)
        const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join("").trim();
        const steps = [...r.querySelectorAll("*")].filter(e => !e.closest(SKIP) && /^Step #\d/.test(own(e)));
        if (steps.length === 1) return steps[0];
        if (steps.length > 1) break;
      }
      return host;
    }
    const p = host.previousElementSibling;
    const t = ((p && p.firstChild && p.firstChild.nodeType === 3 ? p.firstChild.nodeValue : p && p.textContent) || "").trim();
    return k === "arson" && p && t.length >= 3 && t.length <= 30 && !p.querySelector("button:not(.ca-badge):not(.tb-badge), img") ? p : host;
  };
  // Burglary's "Any Industrial" (a random target of that kind, 3 nerve to scout; a type of your choice is 9): the
  // types listed with it in Torn's menu, blended by how often you've burgled each.
  const chipV = new WeakMap();
  function anyChips(root, k) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim(), host = n.parentElement;
      if (!/^Any (Residential|Commercial|Industrial)$/i.test(t) || !host || host.closest(SKIP)) continue;
      let list = host;
      for (let i = 0; i < 6 && list.parentElement; i++) { list = list.parentElement; if (list.querySelectorAll(".ca-chip").length >= 2) break; }
      const vs = [...list.querySelectorAll(".ca-chip")].map(c => chipV.get(c)).filter(v => v && v.try_nerve && v.avg_net != null && !v.few);
      if (!vs.length) continue;
      const pn = Math.round(vs.reduce((s, v) => s + v.count * v.avg_net, 0) / vs.reduce((s, v) => s + v.count * (v.try_nerve + CA.SCOUT_ANY), 0));
      const tier = tierOf({ per_nerve: pn, few: false }, Infinity, false, false, false), sig = `${tier}|${pn}`;
      let b = host.querySelector(":scope > .ca-any");
      if (b && b.dataset.sig === sig) continue;
      b?.remove();
      b = $("span", `ca-badge ca-hud ca-any ${tier}`);
      b.dataset.sig = sig;
      // (a phone: the grade alone, as every chip there; "Any Industrial A $3.4k" ran off the scout menu's edge)
      b.append($("span", "ca-t", TILE[tier]), $("span", "ca-v", matchMedia("(max-width:600px)").matches ? "" : `${short(pn)}/n`));
      b.title = `${t}: a random target of this kind (${CA.SCOUT_ANY} nerve to scout). The ${vs.length} types listed with it, blended by your burgles of each: ${short(pn)}/nerve`;
      host.appendChild(b);
    }
  }
  // Bootlegging: which genre to copy next. Buyers want genres in fixed proportions (community guides, 2023-24):
  // copy the one with the least stock for its demand.
  const DEMAND = { Action: 10, Fantasy: 7, Comedy: 7, Drama: 5.5, Thriller: 4, Horror: 3, Romance: 3, "Sci-Fi": 2 };
  function copyNext(root) {
    const cols = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim(), host = n.parentElement;
      if (!(t in DEMAND) || !host || host.closest(SKIP) || !host.getClientRects().length || cols.some(c => c.genre === t)) continue;
      let col = host;  // the genre's column: the box around its name with no other genre in it
      for (let i = 0; i < 6 && col.parentElement; i++) {
        const up = col.parentElement, txt = up.textContent || "";
        if (Object.keys(DEMAND).filter(g => txt.includes(g)).length > 1) break;
        col = up;
      }
      if (!/queued/i.test(col.textContent || "")) continue;  // (a genre column, not the copy picker's "Comedy")
      const nums = [...col.querySelectorAll("*")].filter(e => !e.closest(SKIP) && !e.children.length && /^\d+$/.test((e.textContent || "").trim()));
      const stock = nums.length ? +nums[nums.length - 1].textContent.trim() : null;
      const queued = +(((col.textContent || "").match(/(\d+)\s*queued/i) || [])[1] || 0);
      if (stock != null) cols.push({ genre: t, host, stock, queued, score: (stock + queued) / DEMAND[t] });
    }
    if (cols.length < 4) return;
    const pick = cols.reduce((a, b) => b.score < a.score ? b : a);
    for (const c of cols) {
      const had = c.host.querySelector(":scope > .ca-next");
      if (c !== pick) { had?.remove(); continue; }
      if (had) continue;
      const b = $("span", "ca-badge ca-hud S ca-next");
      b.append($("span", "ca-t", "\u25b6"));  // (the tile alone: with "next" it wrapped and pushed the column down)
      b.setAttribute("aria-label", `Copy ${c.genre} next`);
      b.title = `Copy ${c.genre} next: the fewest in stock for what buyers want (${c.stock} in stock${c.queued ? `, ${c.queued} queued` : ""}; ` +
        `demand ${Object.entries(DEMAND).map(([g, d]) => `${g} ${d}`).join(", ")}, from the community guides)`;
      c.host.appendChild(b);
    }
  }
  // A crime valued only as a whole (Bootlegging pays when you sell, not per genre): its grade by the page's title.
  function titleGrade(root, k) {
    const pn = values.crime_pn && values.crime_pn[k], list = values.tabs && values.tabs[k];
    const had = root.querySelector(".ca-title");
    if (pn == null || (list && list.length)) { had?.remove(); return; }
    const tier = tierOf({ per_nerve: pn, few: false }, Infinity, false, false, false), sig = `${tier}|${pn}`;
    if (had && had.dataset.sig === sig) return;
    const host = nameEl(root, k);
    if (!host) return;
    had?.remove();
    const b = $("span", `ca-badge ca-hud ca-title ${tier}`);
    b.dataset.sig = sig; b.dataset.tab = k;
    b.append($("span", "ca-t", TILE[tier]), $("span", "ca-v", `${short(pn)}/n`));
    b.title = `${(values.crimes || {})[k] || "This crime"} as a whole: ${short(pn)}/nerve, ${TIERWORD[tier]}` +
      (values.overall ? ` (your average ${short(values.overall)}/nerve)` : "");
    host.appendChild(b);
  }
  // The crime path: a crime still below skill 100 shows where you are on it, with the advice for its stage on hover
  // where there is some. Card Skimming has its own plan: skill to 25, then stack skimmers at gas stations to 100.
  const ADVICE = {
    hustling: "Start a session with plenty of nerve: a game takes a while to pay. Demo until players bet. Lose to pull more bettors in; win once enough are in (a win makes some leave). " +
      "Your audience is capped by your skill: past it, gathering never draws anyone new.",
  };
  function pathChip(root, k) {
    if (k === "cardskimming") return skimPlan(root, k);
    const sk = values.crime_skill && values.crime_skill[k], host = nameEl(root, k);
    const had = root.querySelector(".ca-path"), s = sk == null ? null : Math.floor(sk);
    if (s == null || s >= 100 || !host) { had?.remove(); return; }
    if (had && had.dataset.sig === String(s)) return;
    had?.remove();
    const b = $("span", "ca-badge ca-hud ca-path B");
    b.dataset.sig = String(s); b.dataset.tab = k;
    b.append($("span", "ca-t", "\u25b6"), $("span", "ca-v", `skill ${s}/100`));
    b.title = `On your path: ${(values.crimes || {})[k] || "this crime"} skill ${sk} of 100.` + (ADVICE[k] ? ` ${ADVICE[k]}` : "");
    host.appendChild(b);
  }
  function skimPlan(root, k) {
    const sk = values.crime_skill && values.crime_skill[k], host = nameEl(root, k);
    if (sk == null || !host) return;
    const s = Math.floor(sk), stage = s >= 100 ? "done" : s >= 25 ? "gas" : "build";
    const text = stage === "done" ? "skill 100" : stage === "gas" ? `Gas Station \u00b7 skill ${s}/100` : `skill ${s}/25`;
    let b = root.querySelector(".ca-skim");
    if (!b || b.dataset.sig !== text) {
      b?.remove();
      b = $("span", `ca-badge ca-hud ca-skim ${stage === "done" ? "S" : stage === "gas" ? "A" : "B"}`);
      b.dataset.sig = text; b.dataset.tab = k;
      b.append($("span", "ca-t", stage === "done" ? "\u2713" : "\u25b6"));
      if (stage !== "done") b.append($("span", "ca-v", text));  // (at 100: the tile alone)
      b.title = stage === "done" ? "Card Skimming skill 100: done" : stage === "gas"
        ? `Stack skimmers at gas stations until skill 100 (now ${sk})` : `Build Card Skimming skill to 25 (now ${sk}), then stack skimmers at gas stations`;
      host.appendChild(b);
    }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);  // the install picker's Gas Station
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim(), p = n.parentElement;
      if (t !== "Gas Station" || !p || p.closest(SKIP)) continue;
      const had = p.querySelector(":scope > .ca-next");
      if (stage !== "gas" || !p.closest("button, [class*='dropdown'], [class*='select']")) { had?.remove(); continue; }
      if (had) continue;
      const g = $("span", "ca-badge ca-hud S ca-next");
      g.append($("span", "ca-t", "\u25b6"));
      g.title = "Install here: stack gas station skimmers until skill 100";
      p.appendChild(g);
    }
  }

  // A job that must look accidental (an insurance job) fails if it's lit or stoked with the Flamethrower, though the
  // community recipe often says to. When the job's requirements say so and the recipe uses one, the chip warns and
  // the card swaps in a Lighter. (Any requirement mentioning "accident" or "insurance" counts.)
  const ACCIDENT = /accident|insurance/i;
  const flameBanned = (needs, v) => needs.some(n => ACCIDENT.test(n)) && !!v.community &&
    v.community.steps.some(([k, t]) => /^(Ignite|Stoke)$/.test(k) && /flamethrower/i.test(t));
  // A job's requirements are icons whose labels end in "required"/"requested" (e.g. "Total destruction required"):
  // read them from the job's own row, the largest box around its name that holds no other job's name.
  function requirements(el, byName) {
    let row = el;
    for (let up = el.parentElement, i = 0; up && i < 8; up = up.parentElement, i++) {
      const t = (up.textContent || "").toLowerCase();
      let others = 0;
      const most = new Map();  // occurrences per entry (disposal repeats a job row by row; a scam matches two ways)
      byName.forEach((v, n) => { most.set(v, Math.max(most.get(v) || 0, t.split(n).length - 1)); });
      most.forEach(c => { others += c; });
      if (others > 1) break;
      row = up;
    }
    const labels = [...row.querySelectorAll("[aria-label], [title]")].filter(x => !x.closest(SKIP))
      .map(x => x.getAttribute("aria-label") || x.getAttribute("title") || "");
    const needs = [...new Set(labels.filter(l => /\b(required|requested)\s*$/i.test(l.trim()))
      .map(l => l.trim().replace(/\s*(required|requested)\s*$/i, "")))];
    return { needs, row };
  }

  let onPage = [], lastByName = new Map();  // (set by badges(): the options on show, best first, for Best crimes)
  function badges(root, k) {
    const list = values.tabs[k];
    if (!list || !list.length) { onPage = []; return; }
    const byName = new Map();
    list.forEach(v => v.find.forEach(f => byName.set(f.toLowerCase(), v)));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.nodeValue.trim(), t = raw.toLowerCase();
      if (t.length < 3 || t.length > 60 || !byName.has(t)) continue;
      const host = n.parentElement;  // (raw: the name as Torn's page shows it, for the card; the logs say "the pharmacy")
      // (not in Torn's statistics slide-out, which names every type too: on a phone its hidden labels took the chips)
      if (host && !host.closest(SKIP) && !host.closest("[class*='slidingPanel'], [class*='statistic']"))
        hits.push([host, byName.get(t), chipSlot(host, k).querySelector(":scope > .ca-chip"), raw]);
    }
    // the best $/nerve among the options on show (the S tier)
    const best = Math.max(-Infinity, ...hits.map(h => h[1]).filter(v => !v.few && v.per_nerve != null).map(pnOf));
    // (a chip already on is only looked at again when Torn's unique star might have come or gone, the best changed,
    // your nerve did, or the numbers were recomputed)
    const starsHere = [...root.querySelectorAll("[aria-label]")].some(isStar), nv = nerveNow(), phone = matchMedia("(max-width:600px)").matches;
    for (const [host, v, had, raw] of hits) {  // inside the name's own element: the page redrawing it just clears the chip
      // (two names in one row can lead to the same slot, e.g. Forgery's step label: one chip)
      const slot = chipSlot(host, k), cur = slot.querySelector(":scope > .ca-chip");
      if (cur && cur !== had) continue;
      if (had && !starsHere && had.dataset.star !== "1" && had.dataset.best === String(best) && had.dataset.nerve === String(nv) &&
          had.dataset.v === String(version)) continue;
      const { needs, row } = requirements(host, byName);
      const star = [...row.querySelectorAll("[aria-label]")].some(isStar);
      const rowText = row.textContent || "", pct = +((rowText.match(/(\d{1,3})%/) || [])[1] ?? NaN);
      const short100 = needs.some(n => /total destruction/i.test(n)) && /COLLECT/.test(rowText) && pct < 100;
      const collect = k === "arson" && !short100 && /COLLECT/.test(rowText);  // (Torn's COLLECT button on the job)
      const noFT = flameBanned(needs, v), tier = tierOf(v, best, short100, noFT, collect);
      // (Arson only: a fire you can't finish fails; other crimes are a step at a time)
      const need = k !== "arson" || collect || short100 ? null : nerveFor(v), low = !!need && nv != null && need > nv;
      const picker = !!host.closest("button:not(.ca-badge), [class*='dropdown'], [class*='select']");
      // (Disposal's name column is narrow, and Torn's pickers too: "$2.2k" without "/n")
      const tight = k === "disposal" || picker || phone, text = chipText(v, tier, short100, pct).replace(tight ? /\/n$/ : /^$/, "");
      const sig = [tier, star ? 1 : 0, text, needs.join(","), low ? 1 : 0, version].join("|");
      if (had) {
        Object.assign(had.dataset, { best: String(best), nerve: String(nv), v: String(version), star: star ? "1" : "0" });
        if (had.dataset.sig === sig) continue;
        had.remove();
      }
      const b = $("button", `ca-badge ca-hud ca-chip ${tier}${tight ? " tight" : ""}${picker ? " pick" : ""}${k === "forgery" ? " step" : ""}`), val = $("span", "ca-v");
      b.type = "button";
      Object.assign(b.dataset, { star: star ? "1" : "0", sig, best: String(best), nerve: String(nv), v: String(version), avg: v.avg_net || "" });
      if (star) val.append($("span", "ca-star", "\u2605"));  // (one star a row, in the chip: Torn shows a unique waiting now)
      if (low) val.append($("span", "ca-bolt", "\u26a1"));
      if (!phone) val.append(text);  // (a phone: the grade alone, Aaron 2026-10-17; the number is in the card and the label)
      b.append($("span", "ca-t", TILE[tier]), val);
      const avg = values.overall;
      b.title = (noFT ? "Lighters only: the Flamethrower fails an accidental cause"
        : `${TIERWORD[tier]}${avg && "SABC".includes(tier) ? ` (your average ${short(avg)}/nerve)` : ""}` +
          (recipeOver(v) ? `, by the community recipe: your way lost ${short(-v.per_nerve)}/nerve` : "") +
          (star ? ". Torn shows a unique waiting here now" : "")) +
        (low ? `. Needs ${need} nerve; you have ${nv}` : "");
      b.setAttribute("aria-label", `${raw}: ${TIERWORD[tier]}, ${text}`);
      b.setAttribute("aria-expanded", "false");
      b.onclick = e => { e.preventDefault(); e.stopPropagation(); openPop(b, v, needs, short100 ? pct : null, { name: raw, tier, best, noFT, star, need, nv, low }); };
      if (slot !== host) host.querySelector(":scope > .ca-chip")?.remove();  // (one chip a row)
      // before Torn's abandon cross where a row has one (Burglary's targets): it grows on hover and pushed the chip
      // out from under the cursor
      slot.insertBefore(b, slot.querySelector(":scope > [class*='abandonButton']"));
      if ((picker || tight) && !phone) [0, 450, 1200].forEach(ms => setTimeout(() => fitChip(b), ms));
      chipV.set(b, v);
      if (v.methods) markMethods(row, v);
    }
    if (k === "burglary") anyChips(root, k);
    // the options on show, best first, for Best crimes (Arson's with their place: "Library: Read the Room")
    lastByName = byName;
    const seenV = new Set();
    onPage = hits.map(([host, v, , raw]) => {
      const slot = chipSlot(host, k), chip = slot.querySelector(":scope > .ca-chip");
      const place = slot !== host && slot.firstChild && slot.firstChild.nodeType === 3 ? slot.firstChild.nodeValue.trim() : "";
      // (glance names: "Cemetery", not "Search the Cemetery")
      return { host, v, name: place ? `${place}: ${raw}` : raw.replace(/^Search (the )?/i, ""), pn: pnOf(v), est: recipeOver(v) || v.source === "community",
               tier: (chip && [...chip.classList].find(c => TILE[c])) || "B" };
    }).filter(x => !x.v.few && x.tier !== "G" && x.pn > 0 && x.host.getClientRects().length  // (on show: Disposal's
      && !seenV.has(x.v) && seenV.add(x.v)).sort((a, b) => b.pn - a.pn);                     // hidden history named jobs not on offer)
  }
  // Disposal: a reliability dot on each method's icon, and a green ring on the one to use. The icons are found by their
  // labels ("Abandon", "Bury"...); if Torn's labels don't say, nothing is drawn (the card still has it all).
  const VERB = { Abandoning: /abandon|leave/i, Burying: /bury/i, Burning: /burn/i, Sinking: /sink/i, Dissolving: /dissolv/i };
  function markMethods(row, v) {
    row.querySelectorAll(".ca-mdot").forEach(d => { if (d.dataset.v !== String(version)) d.remove(); });
    const labelled = [...row.querySelectorAll("[aria-label], [title]")].filter(x => !x.closest(SKIP));
    const pk = pickOf(v);
    for (const m of v.methods) {
      if (!m.available) continue;
      const icon = labelled.find(x => VERB[m.method].test(`${x.getAttribute("aria-label") || ""} ${x.getAttribute("title") || ""}`));
      if (!icon || icon.querySelector(":scope > .ca-mdot")) continue;
      const [col, word] = RELY(m.p), dot = $("span", "ca-mdot");
      dot.style.background = col; dot.title = `${m.method}: ${word}`; dot.dataset.v = String(version);
      if (getComputedStyle(icon).position === "static") icon.style.position = "relative";
      icon.appendChild(dot);
      if (m === pk) {
        const ring = $("span", "ca-mdot ca-ring");
        ring.dataset.v = String(version);
        ring.title = `Best here: ${VERBS[m.method]} (${short(m.ev)}/nerve expected)`;
        icon.appendChild(ring);
      }
    }
  }

  // ---- the card (Peek, with Dig behind "More"): the name as Torn shows it, one big number, the odds as one bar,
  // the top three items, pills; then folded sections, one line each. One at a time; on a phone, a sheet from the bottom.
  const pc = x => x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`;
  const ENOUGH = 15;  // (fewer tries than this and the odds are noise: a new player sees the number, not the odds)
  function meterEl(o) {
    const m = $("div", "ca-meter"), trk = $("div", "ca-trk"), lg = $("div", "ca-lg");
    for (const [word, x, col] of [["works", o.success, "#2fbf71"], ["fails", o.fail, "#6e6d66"], ["critical", o.crit, "#e5534b"]]) {
      if (!(x > 0)) continue;
      const s = $("span");
      s.style.cssText = `width:${x * 100}%;background:${col}`;
      const d = $("span"), key = $("span", "ca-k");
      key.style.background = col;
      d.append(key, $("b", "", pc(x)), ` ${word}`);
      trk.append(s); lg.append(d);
    }
    if (o.cash) lg.append($("span", "", `cash ${pc(o.cash)} \u00b7 ~${short(o.cash_avg)}`));
    m.append(trk, lg);
    return m;
  }
  function itemsEl(items) {  // each with a bar: its share of what the top items add to a try
    const box = $("div", "ca-items"), worth = items.map(i => i.rate * (i.qty || 1) * (i.value || 0)), mx = Math.max(1, ...worth);
    items.forEach((i, n) => {
      const r = $("div", "ca-it"), sh = $("div", "ca-sh"), bar = $("span");
      bar.style.width = `${(worth[n] / mx) * 100}%`;
      sh.append(bar);
      r.append($("span", "ca-nm", i.item + (i.qty > 1 ? ` \u00d7${i.qty}` : "")), $("span", "ca-iv", `${pc(i.rate)} \u00b7 ${i.value ? short(i.value) : "\u2013"}`), sh);
      r.title = `${i.item}: in ${pc(i.rate)} of tries${i.qty > 1 ? `, ${i.qty} at a time` : ""}, worth ${i.value ? money(i.value) : "?"} each at market value`;
      box.append(r);
    });
    return box;
  }
  const kv = (rows, cls = "ca-kv") => rows.filter(r => r && r[1] != null && r[1] !== "").map(([a, b]) => {
    const d = $("div", cls); d.append($("span", "", a), $("span", "", b)); return d;
  });
  let pop = null, popChip = null;
  function closePop() { pop?.remove(); pop = null; popChip?.setAttribute("aria-expanded", "false"); popChip = null; }
  function openPop(anchor, v, needs, fellShort, ctx) {
    const reopen = pop && pop.dataset.kind === v.kind;
    closePop();
    if (reopen) return;
    const { name, tier, best, noFT, star, need, nv, low } = ctx, avg = values && values.overall, o = v.outcomes;
    pop = $("div", "ca-pop ca-card");
    pop.dataset.kind = v.kind;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", name);
    if (innerWidth < 600) pop.classList.add("ca-sheet");
    popChip = anchor;
    anchor.setAttribute("aria-expanded", "true");
    const hd = $("div", "ca-hd"), x = $("button", "ca-x", "\u2715");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.onclick = closePop;
    hd.append($("span", `ca-tier ${tier}`, TILE[tier]), $("b", "", name), x);
    hd.firstChild.title = TIERWORD[tier];
    pop.append(hd);
    // the letter in words, under the name: "Grade C \u00b7 under half your average"
    const gw = "SABC".includes(tier) ? `Grade ${tier} \u00b7 ${TIERWORD[tier]}` : TIERWORD[tier][0].toUpperCase() + TIERWORD[tier].slice(1);
    const g = $("div", "ca-grade", gw);
    if (avg && "SABC".includes(tier)) g.title = `Its $/nerve against your average across all crimes (${short(avg)}/nerve). S is also the best on show.`;
    pop.append(g);
    // the one number
    const hero = $("div", "ca-hero"), big = (n, unit) => hero.append($("span", "ca-n", n), $("span", "ca-u", unit));
    const delta = pn => {
      if (!(avg > 0)) return;
      const d = $("span", `ca-delta ${pn >= avg ? "up" : "down"}`, `${(pn / avg).toFixed(1)}\u00d7 your avg`);
      d.title = `Your average across all crimes: ${short(avg)}/nerve`;
      hero.append(d);
    };
    const pk = pickOf(v);
    if (fellShort != null) big(`${fellShort}%`, "of the 100% needed");
    else if (tier === "G") big(`~${short(v.avg_net)}`, "to collect");
    else if (pk) { big(short(pk.ev), "/ nerve"); delta(pk.ev); }
    else if (recipeOver(v)) big(`~${short(v.community.per_nerve)}`, "/ nerve, by the recipe");
    else if (v.few) big(v.per_nerve != null ? `~${short(v.per_nerve)}` : "New", v.per_nerve != null ? "/ nerve, community" : `${v.count || 0} tries so far`);
    else { big(short(v.per_nerve), "/ nerve"); delta(v.per_nerve); }
    pop.append(hero);
    if (o && o.tries >= ENOUGH) {
      pop.append(meterEl(o));
      if (o.items.length) pop.append(itemsEl(o.items.slice(0, 3)));
    }
    // Arson: the recipe is what you act on, so it's on the card (Place / Ignite / Stoke), not behind "More"
    const c = v.community;
    const steps = c && c.steps ? c.steps.map(([s, t]) => [s, noFT && /^(Ignite|Stoke)$/.test(s) ? t.replace(/flamethrower/ig, "Lighter") : t]) : [];
    if (steps.length) {
      const box = $("div", "ca-body");
      box.append(...kv(steps, "ca-kvl"));
      box.title = "The community recipe";
      pop.append(box);
    }
    // pills: what you must know before you commit
    const ft = $("div", "ca-ft"), pill = (cls, t, tip) => { const p = $("span", `ca-pill ${cls}`, t); if (tip) p.title = tip; ft.append(p); };
    if (fellShort != null) pill("bad", "No payout", "It needs total destruction: 100%");
    if (noFT) pill("warn", "\u26a0 Lighters only", "Accidental cause: the Flamethrower fails it");
    if (pk) {
      pill("go", `${VERBS[pk.method]} \u00b7 ${pk.p == null ? "?" : pc(pk.p)} \u00b7 ${Math.round(pk.nerve)} nerve`, "The method with the best expected $/nerve here (reliability: the community chart, updated by your results)");
      if (v.count && v.per_nerve < pk.ev) pill("bad", `Your way: ${short(v.per_nerve)}/n`, `Your ${v.count} ${v.unit} here, the ways you did them`);
    }
    if (low) pill("warn", `\u26a1 Needs ${need} \u00b7 you have ${nv}`, "Nerve to finish the job, by the recipe (else your own average)");
    if (recipeOver(v)) pill("bad", `Your way: ${short(v.per_nerve)}/n`, `Your ${v.count} ${v.unit} lost money; the community recipe pays ~${short(v.community.per_nerve)}/nerve`);
    needs.forEach(n => pill("warn", n, "Torn says this job needs it"));
    if (star) pill("gold", "\u2605 Unique on offer now", "Torn shows a one-time unique outcome waiting here. It pays once, so it's left out of $/nerve.");
    for (const s of (o && o.seasonal) || []) pill("gold", `${s.event || "Event"}: ${s.item}`, `Drops here only around ${s.event || "its event"} (found ${s.found}\u00d7): left out of $/nerve the rest of the year`);
    if (c && c.min) pill("", `pays ${short(c.min)}\u2013${short(c.max)}`, "What the community recipe pays");
    if (o && o.tries) pill("", `${o.tries.toLocaleString()} tries`, o.tries < ENOUGH ? `The odds show after ${ENOUGH} tries` : "Your tries here, from your logs");
    const more = $("button", "ca-dig-btn", "More \u25be"), dig = $("div", "ca-dig");
    more.type = "button";
    dig.hidden = true;
    more.onclick = e => { e.stopPropagation(); dig.hidden = !dig.hidden; more.textContent = dig.hidden ? "More \u25be" : "Less \u25b4"; place(); };
    ft.append(more);
    pop.append(ft, dig);
    // Dig: folded sections, a one-line summary each
    const sec = (title, sub, kids, open, tip) => {
      if (!kids.length) return;
      const d = $("details"), s = $("summary"), bd = $("div", "ca-body");
      d.open = !!open;
      s.append($("span", "ca-car2", "\u25b8"), title, $("span", "ca-sub", sub || ""));
      if (tip) s.title = tip;
      bd.append(...kids);
      d.append(s, bd);
      d.addEventListener("toggle", place);
      dig.append(d);
    };
    if (v.methods && v.methods.length) sec("Methods", "reliability \u00b7 $/nerve", [methodTable(v)], !pk);
    if (!v.few && fellShort == null && tier !== "G") sec("SABC".includes(tier) ? `Grade ${tier}` : "Why", "$/nerve vs your average", kv([
      ...(pk ? [[`${VERBS[pk.method]} (best method)`, `${short(pk.ev)}/nerve`]] : []),
      [recipeOver(v) || pk ? "Your way" : "This", v.per_nerve != null ? `${short(v.per_nerve)}/nerve` : null],
      ["Your average, all crimes", avg ? `${short(avg)}/nerve` : null],
      ["Best on show", best > -Infinity ? `${short(best)}/nerve` : null],
      ["Vs your usual here", v.vs_crime != null ? `${v.vs_crime.toFixed(1)}\u00d7` : null],
      ["Community recipe", c && c.per_nerve != null ? `~${short(c.per_nerve)}/nerve` : null],
      ["From", v.source === "community" ? "community estimate" : "your logs"]]));
    const uq = ((o && o.uniques) || []).slice().sort((a, b) => b.value - a.value), nuq = Math.max(uq.length, v.uniques || 0);
    if (nuq) sec("Uniques", `${nuq} found`, [
      ...kv(uq.slice(0, 4).map(u => [u.items.join(" + ") || "cash", short(u.value)])),
      ...kv([["Left out of $/nerve", v.uniques ? short(v.uniqueNet) : null], ["More found", uq.length > 4 ? `${uq.length - 4}` : null]])]);
    if (o && o.tries >= ENOUGH && o.items.length > 3) sec("All items", `${o.kinds || o.items.length} kinds`,
      kv(o.items.slice(0, 8).map(i => [i.item + (i.qty > 1 ? ` \u00d7${i.qty}` : ""), `${pc(i.rate)} \u00b7 ${i.value ? short(i.value) : "\u2013"}`])),
      false, o.kinds > o.items.length ? `${o.kinds} kinds of item in all; the ${o.items.length} that add most to a try are listed` : "");
    const rec = v.record;
    if (rec) {  // how you ran it when it paid, step by step (lined up against the recipe above)
      const of = n => `${n}/${rec.paid}`, q = x => Number.isInteger(x) ? String(x) : x.toFixed(1);
      const items = (xs, out) => xs.map(x => `${x.item}${x.qty > 1 ? ` \u00d7${q(x.qty)}` : ""} ${x.jobs}/${out}`).join(" \u00b7 ");
      const stoked = !rec.stoked ? "never" : [of(rec.stoked), rec.stokes > 1 ? `${q(rec.stokes)}\u00d7 each` : "",
        rec.stoke_min != null ? `~${q(rec.stoke_min)} min in` : "",
        rec.stoke_fuel.length ? `fed ${items(rec.stoke_fuel, rec.stoked)}` : "",
        rec.tool_stokes ? `${rec.tool_stokes}/${rec.stoked} with a tool` : ""].filter(Boolean).join(" \u00b7 ");
      sec("Your record", `last ${rec.paid} payout${rec.paid === 1 ? "" : "s"}`, kv([["Placed", items(rec.place, rec.paid) || "nothing logged"],
        ["Stoked", stoked], ["Evidence", items(rec.evidence, rec.paid)], ["Dampened", rec.dampened ? of(rec.dampened) : ""]], "ca-kvl"), false,
        "From your logs. The Lighter and Flamethrower are never logged as used, so how a job was lit isn't known, and a stoke with nothing logged was done with one of them.");
    } else if (v.recipe || v.tend) sec("Your record", "", kv([["Recipe", v.recipe], ["Tending", v.tend]], "ca-kvl"));
    if (v.count) sec("History", `${v.count.toLocaleString()} ${v.unit}`, kv([["Each, on average", v.avg_net ? short(v.avg_net) : null],
      ["Paid out", v.win_rate != null ? `${pc(v.win_rate)} of targets` : null],
      ["Share of its top pay", v.your_share != null ? pc(v.your_share) : null]]));
    if (!dig.childNodes.length) more.remove();
    body.appendChild(pop);
    place();
    function place() {  // under the chip (above it when there's no room); a sheet on a phone stays put
      if (!pop || pop.classList.contains("ca-sheet")) return;
      const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, hgt = pop.offsetHeight;
      const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      const top = r.bottom + 6 + hgt < innerHeight ? r.bottom + 6 : Math.max(8, r.top - hgt - 6);
      Object.assign(pop.style, { left: left + "px", top: top + "px" });
    }
  }
  document.addEventListener("click", e => { if (pop && !pop.contains(e.target)) closePop(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(); });
  addEventListener("scroll", closePop, { passive: true });

  // ---- a crime's result, valued: "WORTH $12k" at the end of the result row (market value; the breakdown on hover).
  // Green at or above your usual per try there (the row's chip), grey below, bright green at 2x or $50k. Prices come
  // from the cache the numbers use; an item not in it yet is asked for (your key, queued behind the log sync).
  let valuing = false;
  const askedAt = {};
  function askPrices(ids) {
    if (valuing || !get("key", "")) return;
    const now = Date.now(), want = [...new Set(ids)].filter(id => now - (askedAt[id] || 0) > 600000).slice(0, 100);
    if (!want.length) return;
    valuing = true;
    want.forEach(id => { askedAt[id] = now; });
    api(`/torn/${want.join(",")}/items`).then(j => { savePrices(j.items || []); }).catch(e => { denied(e); /* tried again in 10 minutes */ }).finally(() => { valuing = false; schedule(); });
  }
  function outcomeValues(root) {
    let byId = null;
    for (const box of root.querySelectorAll("[class*='innerOutcomeWrapper']")) {
      const imgs = [...box.querySelectorAll("img[src*='/images/items/']")].filter(i => !i.closest(SKIP));
      if (!imgs.length) continue;
      const got = imgs.map(i => {
        const id = +(((i.getAttribute("src") || "").match(/\/images\/items\/(\d+)\//) || [])[1] || 0);
        const m = ((i.parentElement && i.parentElement.textContent) || "").match(/(?:x|\u00d7)\s?(\d+)|(\d+)\s?(?:x|\u00d7)/i);
        return { id, name: i.getAttribute("alt") || `item ${id}`, qty: m ? +(m[1] || m[2]) : 1 };
      }).filter(g => g.id);
      if (!got.length) continue;
      byId = byId || get("prices", { byId: {} }).byId || {};
      // against your usual per try here: the chip of the one crime row this result sits in
      let usual = 0;
      for (let up = box.parentElement, i = 0; up && i < 8; up = up.parentElement, i++) {
        const chips = up.querySelectorAll(".ca-chip");
        if (chips.length === 1) { usual = +chips[0].dataset.avg || 0; break; }
        if (chips.length > 1) break;
      }
      const missing = got.filter(g => !byId[g.id]).map(g => g.id);
      const key = `${got.map(g => `${g.id}x${g.qty}`).join(",")}|${missing.length}|${usual}`;
      let b = box.querySelector(".ca-oval");
      if (b && b.dataset.k === key) continue;
      if (missing.length) askPrices(missing);
      const each = got.map(g => ({ ...g, value: byId[g.id] ? (byId[g.id][1] || 0) * g.qty : null }));
      const total = each.reduce((s, g) => s + (g.value || 0), 0);
      if (!b) {  // at the end of the result row (inside an item's tile it was clipped)
        b = $("span", "ca-badge ca-hud ca-oval");
        (imgs[imgs.length - 1].closest("[class*='outcomeReward']") || box).appendChild(b);
      }
      b.dataset.k = key;
      const tierV = !total ? "Q" : total >= 50000 || (usual && total >= 2 * usual) ? "S" : !usual || total >= usual ? "A" : "C";
      b.className = `ca-badge ca-hud ca-oval ${tierV}`;
      b.replaceChildren($("span", "ca-lbl", "worth"), $("span", "ca-v", total ? short(total) : missing.length ? "no price yet" : "$0"));
      b.title = each.map(g => `${g.name}${g.qty > 1 ? ` \u00d7${g.qty}` : ""}: ${g.value == null ? "no price yet" : money(g.value)}`).join("\n") +
        (usual ? `\nYour usual here: ${short(usual)} a try.` : "") +
        "\nAt market value. A one-time unique outcome is left out of your $/nerve.";
    }
  }

  // ---- Best crimes (top of the panel): the best options here, then crimes whose best beats this page's. One here
  // scrolls to its option and flashes it; one elsewhere links to its page (one page per click, yours).
  function flash(x) {
    if (!x.host.isConnected) return;
    const { row } = requirements(x.host, lastByName), chip = chipSlot(x.host, tabKey(tab)).querySelector(":scope > .ca-chip");
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    for (const e of [row, chip]) {
      if (!e) continue;
      e.classList.remove("ca-flash"); void e.offsetWidth; e.classList.add("ca-flash");
      setTimeout(() => e.classList.remove("ca-flash"), 3400);
    }
  }
  // What to do, for the panel's Best crimes and the button's glance
  function plan(k) {
    const src = values || {}, lead = src.leaders || {}, crimes = src.crimes || {};
    // Worth doing here: options at or above your average. None: just the best on show, as one muted row, so the
    // crimes worth doing elsewhere get the room (Aaron, 2026-10-17: on Pickpocketing only waiting for a Cyclist was
    // worth it, and the weak marks on show crowded out the better crimes elsewhere)
    const avg = src.overall || 0, all = k ? onPage : [], top = all.length ? all[0].pn : 0;
    const here = all.filter(x => !avg || x.pn >= avg).slice(0, 3), weak = !here.length && all.length ? all[0] : null;
    // a crime whose options come and go (pickpocketing's marks): its best of all, with what to do ("wait for Cyclist")
    const reach = x => Math.max(x.per_nerve || 0, (x.ideal && x.ideal.per_nerve) || 0);
    const wait = k && lead[k] && lead[k].ideal && lead[k].ideal.per_nerve > top ? lead[k].ideal : null;
    // elsewhere: what beats the best you can do here now (waiting for a mark is a maybe), and is at your average
    const elsewhere = Object.entries(lead).filter(([t, x]) => t !== k && reach(x) > top && (!avg || reach(x) >= avg))
      .sort((a, b) => reach(b[1]) - reach(a[1])).slice(0, 3);
    return { src, crimes, avg, here, weak, wait, elsewhere };
  }
  function drawBest(k) {
    const { src, crimes, avg, here, weak, wait, elsewhere } = plan(k);
    const sig = JSON.stringify([k, here.map(x => [x.name, x.pn, x.tier, x.est]), weak && [weak.name, weak.pn, weak.tier], wait, elsewhere, avg]);
    if (bestBox.dataset.sig === sig) return;
    bestBox.dataset.sig = sig;
    bestBox.replaceChildren();
    if (!here.length && !elsewhere.length && !wait && !weak) return;
    const findRow = (x, cls) => {  // an option on show: tap to find it on the page
      const li = $("li", cls || ""), b = $("button", "ca-bestbtn");
      b.type = "button";
      b.title = "Show it on the page";
      b.append($("span", `ca-tier ${x.tier}`, TILE[x.tier]), $("span", "ca-name", x.name), $("span", "ca-loc", "\u2316"));
      b.onclick = e => { e.preventDefault(); e.stopPropagation(); flash(x); };
      li.append(b, $("span", "ca-muted", `${x.est ? "~" : ""}${short(x.pn)}/n`));
      return li;
    };
    if (here.length) {
      const ul = $("ul", "ca-list");
      for (const x of here) ul.append(findRow(x));
      const sec = $("div", "ca-sec", "Best here ");
      sec.append($("span", "", "\u00b7 tap to find \u2316"));
      bestBox.append(sec, ul);
    }
    if (wait || weak) {
      const ul = $("ul", "ca-list");
      if (wait) {
        const li = $("li");
        li.append($("span", "", `\u23f3 ${wait.verb[0].toUpperCase()}${wait.verb.slice(1)} ${wait.name}`), $("span", "ca-muted", `${short(wait.per_nerve)}/n`));
        li.title = `Not on show now: your best here when one turns up (${short(wait.per_nerve)}/nerve, from your logs)`;
        ul.append(li);
      }
      if (weak) {
        const li = findRow(weak, "ca-weak");
        li.title = `The best on show now, below your average (${short(avg)}/nerve)`;
        ul.append(li);
      }
      if (!here.length) bestBox.append($("div", "ca-sec", "Here"));
      bestBox.append(ul);
    }
    if (elsewhere.length) {
      const ul = $("ul", "ca-list");
      for (const [t, x] of elsewhere) {
        const li = $("li"), a = $("a", "ca-name");
        a.href = `/page.php?sid=crimes#/${t}`;
        const w = x.ideal && x.ideal.per_nerve >= (x.per_nerve || 0) ? x.ideal : null;
        a.title = `Open ${crimes[t] || t}: ${w ? `${w.verb} ${w.name}` : x.name} (what its page showed when you last looked)`;
        a.append($("b", "", crimes[t] || t), ` \u00b7 ${w ? `${w.verb} ${w.name}` : x.name}`);
        li.append(a, $("span", "ca-muted", w ? `${short(w.per_nerve)}/n` : `${x.est ? "~" : ""}${short(x.per_nerve)}/n`));
        ul.append(li);
      }
      bestBox.append($("div", "ca-sec", k ? "Better elsewhere" : "Best by crime"), ul);
    }
    if (here.length || weak) {  // what the letters mean
      const leg = $("div", "ca-muted ca-legend", "S best here \u00b7 A above your avg \u00b7 B half or more \u00b7 C under half");
      leg.title = src.overall ? `Each option's $/nerve against your average across all crimes: ${short(src.overall)}/nerve` : "Each option's $/nerve against your average across all crimes";
      bestBox.append(leg);
    }
  }
  // The button is a glance too: the best option on show ("Crime Advisor \u00b7 S Pharmacy").
  // Two lines (Aaron, 2026-10-17: it fits the space beside Torn's chat bar on a phone): "Crime Advisor", then the one
  // thing to do: the best here at your average or above, else what to wait for here, else the best crime elsewhere,
  // else (muted) the best on show. On the hub: the best crime.
  function glance() {
    const k = tab ? tabKey(tab) : null, { crimes, here, weak, wait, elsewhere } = plan(k);
    let tier = null, line = "", tip = "", muted = false;
    if (here.length) {
      const x = here[0]; tier = x.tier; line = x.name;
      tip = `Best here: ${x.name}, ${x.est ? "~" : ""}${short(x.pn)}/nerve (${TIERWORD[x.tier] || ""})`;
    } else if (wait) {
      line = `\u23f3 ${wait.name}`;  // (the hourglass says wait or scout: "Scout for Foundry" didn't fit beside the chat bar)
      tip = `Nothing here beats your average now: ${wait.verb} ${wait.name} (${short(wait.per_nerve)}/nerve)`;
    } else if (elsewhere.length) {
      const [t, x] = elsewhere[0], w = x.ideal && x.ideal.per_nerve >= (x.per_nerve || 0) ? x.ideal : null;
      // (one to wait for reads as the wait, as on its own page: "Wait for Cyclist", not "Pickpocketing - Cyclist")
      line = w ? `\u23f3 ${w.name}` : `\u2192 ${crimes[t] || t}`;  // (the crime's own page shows which job)
      tip = `${k ? "Better elsewhere" : "Your best crime"}: ${crimes[t] || t}, ${w ? `${w.verb} ${w.name}` : x.name} (${short(w ? w.per_nerve : x.per_nerve)}/nerve)`;
    } else if (weak) {
      tier = weak.tier; line = weak.name; muted = true;
      tip = `The best on show, below your average: ${weak.name}, ${short(weak.pn)}/nerve`;
    }
    const sig = `${tier}|${line}|${muted}`;
    if (btn.dataset.sig === sig) return;
    btn.dataset.sig = sig;
    btn.replaceChildren($("span", "ca-bt", "Crime Advisor"));
    btn.title = tip;
    if (line) {
      const a = $("span", `ca-ba${muted ? " muted" : ""}`);
      if (tier) a.append($("span", `ca-tier ${tier}`, TILE[tier]));
      a.append($("span", "ca-bn", line));
      btn.append(a);
    }
  }

  // ---- watching the page: Torn switches crimes without a page load. The chips go on as soon as a crime's names are
  // on the page; its text is kept (in this browser) once it has shown for 1.5 s, then at most every 20 s while it changes.
  function pageText(root) {  // the page's own text, without ours
    const ours = [...root.querySelectorAll(OURS)];
    ours.forEach(b => { b.style.display = "none"; });
    const text = (root.innerText || "").replace(/[ \t]+/g, " ").slice(0, 60000);
    ours.forEach(b => { b.style.display = ""; });
    return text;
  }
  let looking = null;
  function look() {
    looking = null;
    const t = current();
    if (t !== tab) { tab = t; since = Date.now(); onPage = []; closePop(); }
    const root = crimeRoot(), k = tabKey(tab);
    if (tab) {
      // (Torn can keep the title's element from one crime to the next: the last crime's badges go)
      root.querySelectorAll(".ca-uq, .ca-title, .ca-path, .ca-skim").forEach(b => { if (b.dataset.tab !== k) b.remove(); });
      headerUniques(root, k);
      if (values) { badges(root, k); titleGrade(root, k); pathChip(root, k); if (Date.now() - widenAt > 3000) { widenAt = Date.now(); widenRoot(k); } }
      if (k === "bootlegging") copyNext(root);
      outcomeValues(root);
    } else {  // the Crimes hub
      root.querySelectorAll(".ca-uq:not(.ca-hubuq), .ca-title, .ca-path, .ca-skim").forEach(b => b.remove());
      hubUniques(root);
      if (Date.now() - since >= 1500) hubSeen(root);
    }
    drawBest(tab ? k : null);
    glance();
    bottomClear();
  }
  const schedule = () => { if (!looking) looking = setTimeout(look, LOW ? 400 : 150); };
  // On a phone Torn's chat bar is fixed across the bottom of the screen (Aaron's iPhone in Torn PDA, 2026-10-17: it
  // covered the bottom of the panel). The button and the panel sit just above whatever Torn has fixed down there.
  var clearAt = 0;  // (var: the panel can open, on its own, before this line has run)
  function bottomClear() {
    if (Date.now() - clearAt < 2000) return;
    // (not mid-bounce: pulling past the end of an iPhone page springs Torn's bar up and back, and measured then the
    // button stayed under the bar for a while; Aaron, 2026-10-17)
    const max = document.documentElement.scrollHeight - innerHeight;
    if (scrollY < 0 || scrollY > max + 1) { setTimeout(() => { clearAt = 0; bottomClear(); }, 200); return; }
    clearAt = Date.now();
    let h = 0, left = innerWidth;
    for (const x of [innerWidth * 0.2, innerWidth * 0.5, innerWidth * 0.8, innerWidth - 12]) {
      for (const el of document.elementsFromPoint(x, innerHeight - 4)) {
        if (el.closest(OURS) || el === document.documentElement || el === body) continue;
        // A bar is fixed or sticky AND pinned to the bottom (its CSS bottom set): Torn's chat bar is sticky. Something
        // pinned to the top only reaches the bottom edge at the end of the page (it left the button mid-screen), and
        // a tall overlay isn't a bar: then the bar is the biggest short box from the tapped spot up that hugs the bottom.
        for (let n = el; n && n !== body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.position !== "fixed" && cs.position !== "sticky") continue;
          if (cs.bottom === "auto") break;
          let top = innerHeight;
          for (let m = el; m; m = m === n ? null : m.parentElement) {
            const r = m.getBoundingClientRect();
            if (r.height > innerHeight * 0.25 || r.bottom < innerHeight - 8) break;
            top = Math.min(top, r.top);
          }
          if (top < innerHeight) h = Math.max(h, innerHeight - top);
          // where the bar's own pieces start (its box can span the screen while its icons sit on the right): the
          // leftmost small box in it at the bottom of the screen
          for (const c of n.querySelectorAll("*")) {
            const r = c.getBoundingClientRect();
            if (r.width > 8 && r.height > 8 && r.width < innerWidth * 0.5 && r.bottom > innerHeight - 80 && r.top < innerHeight) left = Math.min(left, r.left);
          }
          if (left === innerWidth) left = Math.min(left, n.getBoundingClientRect().left);  // (a bar with no pieces of its own)
          break;
        }
      }
    }
    // The button: beside the bar when the space to its left fits it (Aaron's iPhone: about 40% of the width), else above
    const de = document.documentElement.style, room = Math.floor(left - 18), beside = h > 0 && room >= 120;
    de.setProperty("--ca-bottom", `${Math.round(Math.min(h, innerHeight * 0.3))}px`);
    de.setProperty("--ca-btn-lift", beside ? "0px" : `${Math.round(Math.min(h, innerHeight * 0.3))}px`);
    if (beside) de.setProperty("--ca-room", `${room}px`); else de.removeProperty("--ca-room");
    barSeen = h ? `${Math.round(h)} px high, from x ${Math.round(left)}${beside ? " (button beside it)" : " (button above it)"}` : "none";
  }
  var barSeen = "not measured";  // (var: the panel can ask before this line has run)
  addEventListener("resize", () => { clearAt = 0; bottomClear(); });
  let scrollT = null;  // (and again once a scroll settles)
  addEventListener("scroll", () => { clearTimeout(scrollT); scrollT = setTimeout(() => { clearAt = 0; bottomClear(); }, 250); }, { passive: true });
  const lastSeen = {};
  function seenTick() {
    if (current() !== tab) { schedule(); return; }
    if (!tab) { if (Date.now() - since >= 1500 && document.visibilityState !== "hidden") hubSeen(crimeRoot()); return; }
    if (Date.now() - since < 1500 || document.visibilityState === "hidden") return;
    const k = tabKey(tab), prev = lastSeen[k] || (lastSeen[k] = { text: "", at: 0, looked: 0 });
    if (Date.now() - prev.at < 20000 || Date.now() - prev.looked < 3000) return;  // (an unchanged page: re-read every 3 s)
    prev.looked = Date.now();
    const text = pageText(crimeRoot());
    if (text.length < 40 || text === prev.text) return;
    prev.text = text; prev.at = Date.now();
    const seen = get("seen", {});
    seen[k] = { text, at: Date.now() };
    set("seen", seen);
    if (values) { values.leaders = CA.leaders(values.tabs, seen); schedule(); }
  }

  // ---------------- run ----------------
  let started = false;
  async function start() {
    if (!started) {
      started = true;
      new MutationObserver(muts => { if (!muts.every(ownMutation)) schedule(); }).observe(body, { childList: true, subtree: true });
      addEventListener("hashchange", schedule);
      setInterval(seenTick, 1000);
      setInterval(() => sync(renderPanel).then(recompute), 5 * 60000);  // new logs every 5 minutes while Torn is open
      schedule();
    }
    await recompute();
    if (get("key", "")) sync(renderPanel).then(recompute);
  }
  if (onCrimes) start();
  else if (get("key", "")) {  // other Torn pages only keep the logs up to date (history keeps loading while you play)
    sync(() => {});
    setInterval(() => sync(() => {}), 5 * 60000);
  }
})();
