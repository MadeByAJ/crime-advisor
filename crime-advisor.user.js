// ==UserScript==
// @name         Crime Advisor ($/nerve)
// @namespace    ajthesecond.crime-advisor
// @version      1.2.2
// @description  Your own $/nerve for every crime, arson job and scam type, plus community arson recipes, right on Torn's crime pages. Everything stays in your browser.
// @author       AJTheSecond [3395781]
// @homepageURL  https://tornbrain.com/
// @updateURL    https://tornbrain.com/crime-advisor.user.js
// @downloadURL  https://tornbrain.com/crime-advisor.user.js
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
 *   - On Torn's crime pages, a small button next to each arson job, scam type, search spot, shop, document...
 *     shows YOUR $/nerve for it (from your own crime logs). Click it for a card: the verdict, your history,
 *     the job's requirements, the community recipe (arson) and your own winning recipe.
 *   - Arson works even without an API key: requirements, community recipes and "fell short" warnings.
 *
 * Your data
 *   - Your API key is stored by Tampermonkey in this browser and only ever sent to api.torn.com.
 *   - Your crime logs are copied into this browser's storage (IndexedDB) so it doesn't re-download them.
 *     Nothing is sent anywhere else. The community recipes are downloaded from balaclava.app (public data).
 *   - Key: a Custom key with only "log" is enough (Torn requires log access to read crime logs). Torn's form has no
 *     Custom option: the panel's "Make a log-only key" link opens it pre-filled.
 *
 * Read-only: it never clicks, commits a crime or does anything in Torn for you.
 */

/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, module */

// ======================================================================================================
// The analysis (pure functions: no browser APIs, so it can be tested outside Torn)
// ======================================================================================================
const CA = (() => {
  "use strict";
  const DAY = 86400;
  const ARSON = 13, SCAMMING = 12, FORGERY = 11, DISPOSAL = 9;
  const ARSON_EXPIRE = 7 * DAY, SCAM_EXPIRE = DAY, SCAM_LOST_AFTER = 3600, MIN_NERVE = 30;
  const NAMES = { 1: "Search for Cash", 2: "Bootlegging", 3: "Graffiti", 4: "Shoplifting", 5: "Pickpocketing", 6: "Card Skimming",
                  7: "Burglary", 8: "Hustling", 9: "Disposal", 10: "Cracking", 11: "Forgery", 12: "Scamming", 13: "Arson" };
  // Crimes whose every step names what it's done to: $/nerve by that is meaningful. In the others the money lands
  // on a different step than the nerve (skimming pays when you sell the details), so they're valued as a whole.
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
        e.isStep = true;
      } else e.crime = EVENT_CRIME[r.type] ?? null;
      return e;
    });
  }

  // Each arson job from inquire/breach to collect; items in the same second as a step are that step's job's.
  function arsonJobs(events, price, now) {
    const jobs = [], open = new Map(), stepAt = new Map();
    for (const e of events) if (e.crime === ARSON && e.isStep && e.detail) (stepAt.get(e.ts) || stepAt.set(e.ts, []).get(e.ts)).push([e.detail, e.action]);
    const close = (j, state, ts) => { j.state = state; j.closed = ts; open.delete(j.job); };
    for (const e of events) {
      if (e.crime !== ARSON) continue;
      if (COST_TYPES.has(e.type)) {
        const near = [0, -1, 1, -2, 2].flatMap(dt => stepAt.get(e.ts + dt) || []);
        const step = near.find(s => ["Place combustible", "Plant evidence", "Stoke"].includes(s[1])) || near[0];
        const j = step ? open.get(step[0]) : [...open.values()].sort((a, b) => b.last - a.last)[0];
        if (j) {
          const used = [...items(e.d, ["items_used"])];
          j.itemCost += used.reduce((s, [i, n]) => s + (price[i] || 0) * n, 0);
          const bucket = step && step[1] === "Plant evidence" ? j.evidence : j.fuel;
          for (const [i, n] of used) bucket[i] = (bucket[i] || 0) + n;
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
              lit: false, stokes: 0, dampens: 0, fuel: {}, evidence: {} };
        jobs.push(j); open.set(job, j);
      }
      j.last = e.ts;
      if (e.isStep) {
        j.nerve += e.nerve; j.steps += 1; j.money += e.money;
        j.worked = j.worked || e.action !== "Make entry";
        j.lit = j.lit || (e.action === "Ignite" && e.result === "success");
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
    const fuel = Object.entries(j.fuel).sort((a, b) => b[1] - a[1]).map(([i, n]) => n > 1 ? `${n}x ${nm(i)}` : nm(i)).join(" + ");
    const ev = Object.keys(j.evidence).map(nm).join(" + ");
    const text = [fuel, ev && `${ev} evidence`].filter(Boolean).join(" + ") || "no fuel logged";
    return text + (j.stokes ? `, ${j.stokes} stoke${j.stokes > 1 ? "s" : ""}` : "") + (j.dampens ? `, ${j.dampens} dampen${j.dampens > 1 ? "s" : ""}` : "");
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
    const done = Object.values(stats).filter(t => t.success);
    const paid = done.reduce((s, t) => s + t.success, 0);
    const pay = paid ? done.reduce((s, t) => s + t.money + t.itemValue, 0) / paid : null;
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
               per_nerve: n && t.nerve ? Math.round((t.money + t.itemValue - t.itemCost) / t.nerve) : null };
    });
    const live = methods.filter(m => m.available && m.p != null);
    const score = m => m.ev != null ? m.ev : m.p / m.nerve;  // same pay whichever way: odds per nerve
    const best = live.reduce((a, m) => !a || score(m) > score(a) ? m : a, null);
    const steady = live.reduce((a, m) => !a || m.p > a.p || (m.p === a.p && m.nerve < a.nerve) ? m : a, null);
    return { methods, pay: pay ? Math.round(pay) : null, best: best && best.method, steady: steady && steady.method };
  }

  // The whole picture: $/nerve per crime and per kind (job, scam type, spot...), all costs in.
  function report(rows, { price = {}, names = {}, ref = {}, priceByName = {}, days = null, now = Date.now() / 1000 } = {}) {
    const since = days ? now - days * DAY : 0, events = load(rows);
    const blank = () => ({ attempts: 0, nerve: 0, success: 0, fail: 0, crit: 0, money: 0, itemValue: 0, itemCost: 0 });
    const crimes = {}, actions = new Map(), kinds = new Map();
    const add = (t, e) => { t.attempts++; t.nerve += e.nerve; t[e.result]++; t.money += e.money;
      for (const [i, n] of items(e.d, ["items_gained"])) t.itemValue += (price[i] || 0) * n; };
    const get = (m, k) => m.get(k) || m.set(k, blank()).get(k);
    // Materials are logged in the same second as the step they were for: charged to what that step was done to (and,
    // for disposal, to how: burning's gasoline, dissolving's acid).
    const stepAt = new Map(), how = new Map();
    for (const e of events) if (e.isStep && KIND_CRIMES.has(e.crime)) stepAt.set(`${e.ts}|${e.crime}`, [e.detail || e.action, e.action]);
    for (const e of events) {
      if (e.ts < since) continue;
      const cid = e.crime;
      if (e.isStep) {
        const c = cid ?? 0;
        add(crimes[c] ||= blank(), e);
        add(get(actions, `${c}|${e.action}|${c === SCAMMING ? e.detail : ""}`), e);
        if (KIND_CRIMES.has(c)) add(get(kinds, `${c}|${e.detail || e.action}`), e);
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
    const finish = t => { t.net = t.money + t.itemValue - t.itemCost; t.per_nerve = t.nerve ? t.net / t.nerve : null; return t; };
    const byCrime = {};
    for (const [c, t] of Object.entries(crimes)) byCrime[c] = { id: +c, name: NAMES[c] || "Unrecognised", ...finish(t) };

    // arson jobs in range, and how each has been tended and fuelled when it paid (all time)
    const allJobs = arsonJobs(events, price, now), arson = new Map(), tend = new Map();
    for (const j of allJobs.filter(j => (j.closed || j.last) >= since)) {
      const a = arson.get(j.job) || arson.set(j.job, { job: j.job, instances: 0, paid: 0, expired: 0, open: 0, skipped: 0, nerve: 0, money: 0, itemCost: 0 }).get(j.job);
      a[j.state]++; a.instances += j.state !== "skipped"; a.nerve += j.nerve; a.money += j.money; a.itemCost += j.itemCost;
    }
    for (const j of allJobs) if (j.state === "paid" && j.lit) {
      const t = tend.get(j.job) || tend.set(j.job, { paid: 0, stoked: 0, recipes: {}, last: null, payouts: [] }).get(j.job);
      t.paid++; t.stoked += j.stokes > 0; t.payouts.push(j.money);
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
                 tend: tendHint(t), recipe: topRecipe(t), community: community(r, priceByName),
                 your_share: r && r.payoutMax && recent.length ? Math.round(100 * median(recent) / r.payoutMax) / 100 : null });
    }
    for (const m of methods.values()) if (m.conversations)
      out.push({ crime_id: SCAMMING, kind: m.method, nerve: m.allNerve, net: m.net, count: m.conversations, unit: "targets",
                 win_rate: m.winRate, paid: m.paid });
    for (const [k, v] of kinds) { const [c, kind] = [+k.split("|")[0], k.slice(k.indexOf("|") + 1)];
      const row = { crime_id: c, kind, nerve: v.nerve, net: v.money + v.itemValue - v.itemCost, count: v.attempts, unit: "crimes" };
      if (c === DISPOSAL) {  // which method to use for this job: the choice the page asks you to make
        const stats = Object.fromEntries([...how].filter(([hk]) => hk.slice(0, hk.lastIndexOf("|")) === kind).map(([hk, t]) => [hk.slice(hk.lastIndexOf("|") + 1), t]));
        Object.assign(row, disposalMethods(kind, stats));
      }
      out.push(row); }
    for (const k of out) {
      k.crime = NAMES[k.crime_id] || "Unrecognised";
      k.per_nerve = k.nerve ? k.net / k.nerve : null;
      k.avg_net = k.count ? k.net / k.count : null;
      k.vs_crime = k.per_nerve != null && base[k.crime_id] ? k.per_nerve / base[k.crime_id] : null;
      k.few = k.nerve < MIN_NERVE || k.count < 2;
    }
    const total = finish(Object.values(crimes).reduce((t, c) => { for (const f of ["attempts", "nerve", "success", "fail", "crit", "money", "itemValue", "itemCost"]) t[f] += c[f]; return t; }, blank()));
    return { total, crimes: Object.values(byCrime).sort((a, b) => b.nerve - a.nerve), kinds: out, events: events.length };
  }

  // What the page badges: for each crime tab, the names to look for and your $/nerve for each.
  const slug = s => s.toLowerCase().replace(/[^a-z]/g, "");
  function pageValues(rep, ref = {}, priceByName = {}) {
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
    return { overall, tabs };
  }

  return { classify, load, arsonJobs, scamConversations, community, report, pageValues, jobTitle, slug, NAMES, disposalMethods };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CA;  // for tests (node)
else (function main() {
  "use strict";
  const url = new URL(location.href);
  const onCrimes = url.searchParams.get("sid") === "crimes";
  const body = document.body;
  if (!body) return;
  const KEY_LINK = "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Crime%20Advisor&user=log";
  const $ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const short = n => n == null ? "\u2013" : (n < 0 ? "-" : "") + (Math.abs(n) >= 1e6 ? `$${(Math.abs(n) / 1e6).toFixed(1).replace(/\.0$/, "")}m`
    : Math.abs(n) >= 1e3 ? `$${(Math.abs(n) / 1e3).toFixed(1).replace(/\.0$/, "")}k` : `$${Math.round(Math.abs(n))}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------- storage: settings in Tampermonkey, logs in IndexedDB ----------------
  const get = (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch (e) { return d; } };
  const set = (k, v) => { try { GM_setValue(k, v); } catch (e) { /* ignore */ } };
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
        r.onsuccess = () => { clearTimeout(timer); res(r.result); };
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

  // ---------------- the Torn API (your key, one request every 3 s at most) ----------------
  const GAP_MS = 3000;
  let lastReq = 0;
  function http(opts) {
    return new Promise((res, rej) => GM_xmlhttpRequest({ ...opts, timeout: 30000, onload: res, onerror: () => rej(new Error("network error")),
                                                         ontimeout: () => rej(new Error("timed out")) }));
  }
  async function api(path, params = {}) {
    const key = get("key", "");
    if (!key) throw new Error("no API key");
    const wait = lastReq + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    const q = new URLSearchParams(Object.fromEntries(Object.entries({ ...params, comment: "CrimeAdvisor" }).filter(([, v]) => v != null)));
    const r = await http({ method: "GET", url: `https://api.torn.com/v2${path}?${q}`, headers: { Authorization: `ApiKey ${key}` } });
    const j = JSON.parse(r.responseText);
    if (j.error) {
      const msg = { 2: "the API key isn't right", 16: "the key can't read logs: use the panel's \"Make a log-only key\" link", 5: "too many requests: waiting",
                    8: "IP blocked by Torn for too many requests", 13: "the key's owner is inactive", 18: "the key is paused" }[j.error.code] || j.error.error;
      const e = new Error(msg); e.code = j.error.code; throw e;
    }
    return j;
  }

  // ---------------- syncing your crime logs (new ones first, then history, gently) ----------------
  const keep = ["crime_action", "nerve", "money_gained", "money_lost", "items_used", "items_added", "items_gained", "target", "method", "crime", "skill_level"];
  const slim = l => ({ id: String(l.id), ts: l.timestamp, type: (l.details || {}).id, title: (l.details || {}).title,
                       d: Object.fromEntries(keep.filter(k => l.data && l.data[k] != null).map(k => [k, l.data[k]])) });
  let syncing = false, syncNote = "", syncError = "", syncedThisVisit = false;
  async function page(to, from) {
    const j = await api("/user/log", { cat: 136, limit: 100, to, from });
    const logs = j.log || [];
    if (logs.length) await idb.put(logs.map(slim));
    return logs;
  }
  async function sync(onProgress) {
    if (syncing || !get("key", "")) return;
    // one tab at a time: a lock that another tab's sync refreshes
    const lock = get("lock", 0);
    if (Date.now() - lock < 20000) return;
    syncing = true;
    const beat = setInterval(() => set("lock", Date.now()), 5000);
    set("lock", Date.now());
    const st = memoryOnly && !syncedThisVisit ? { newest: null, oldest: null, done: false } : get("sync", { newest: null, oldest: null, done: false });
    syncedThisVisit = true;
    try {
      syncError = "";
      // new logs: page back from now to the newest we have (a first run takes one page; history does the rest)
      const fresh = st.newest == null;
      let to = null;
      for (let i = 0; i < 30; i++) {
        const logs = await page(to, st.newest ? st.newest - 1 : null);
        if (!logs.length) { if (st.newest == null) st.done = true; break; }
        const ts = logs.map(l => l.timestamp);
        st.newest = Math.max(st.newest || 0, ...ts);
        if (st.oldest == null) st.oldest = Math.min(...ts);
        if (fresh || logs.length < 100) break;
        to = Math.min(...ts) - 1;
      }
      set("sync", st);
      onProgress();
      // history: keep paging back while this page is open, until the start
      let pages = 0, batches = 0;
      while (!st.done && !(memoryOnly && pages++ >= 20)) {  // memory-only: just the latest ~2,000 logs each visit
        syncNote = `loading history (back to ${new Date(st.oldest * 1000).toLocaleDateString()})`;
        onProgress();
        const logs = await page(st.oldest, null);
        if (logs.length) st.oldest = Math.min(st.oldest, ...logs.map(l => l.timestamp)) - (logs.length === 100 ? 0 : 1);
        if (logs.length < 100) st.done = true;
        else if (logs.every(l => l.timestamp === st.oldest)) st.oldest -= 1;  // a full page within one second: step past it
        set("sync", st);
        if (++batches % 20 === 0) await recompute();  // every ~2,000 logs: the numbers catch up as history loads
      }
      syncNote = "";
      set("synced_at", Date.now());
    } catch (e) {
      syncError = e.message;
      if (e.code === 5) await sleep(60000);
    } finally {
      clearInterval(beat);
      set("lock", 0);
      syncing = false;
      onProgress();
    }
  }

  // ---------------- item prices (materials and rewards) and the community recipes, once a day ----------------
  async function refreshPrices(rows) {
    const cached = get("prices", { at: 0, byId: {} });
    if (Date.now() - cached.at < DAYMS) return cached;
    const ids = new Set();
    for (const r of rows) for (const k of ["items_used", "items_added", "items_gained"]) for (const id of Object.keys((r.d || {})[k] || {})) if (/^\d+$/.test(id)) ids.add(id);
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
      return out;
    } catch (e) { return cached; }
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
  async function recompute() {
    const rows = get("key", "") ? await idb.all().catch(() => []) : [];
    const [prices, ref] = await Promise.all([rows.length ? refreshPrices(rows) : get("prices", { at: 0, byId: {} }), refreshRef()]);
    const price = {}, names = {}, priceByName = {};
    for (const [id, [n, p]] of Object.entries(prices.byId || {})) { price[id] = p; names[id] = n; priceByName[n] = p; }
    const opts = { price, names, ref: ref.byTitle || {}, priceByName };
    const all = CA.report(rows, opts);
    values = CA.pageValues(all, opts.ref, priceByName);
    version++;  // buttons drawn from older numbers are redrawn
    summary = { all, month: CA.report(rows, { ...opts, days: 30 }), logs: rows.length };
    renderPanel();
  }

  // ---------------- the panel: key, sync status, your $/nerve by crime ----------------
  const style = $("style");
  style.textContent = `
    .ca-btn{position:fixed;left:12px;bottom:12px;z-index:99998;background:#1a1a19;color:#9cc8ff;border:1px solid #3a3a37;border-radius:18px;
      padding:6px 12px;font:600 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)}
    .ca-panel{position:fixed;left:12px;bottom:52px;z-index:99999;width:min(360px,92vw);max-height:70vh;overflow:auto;background:#1a1a19;color:#f3f3f1;
      border:1px solid #3a3a37;border-radius:10px;padding:12px 14px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.55)}
    .ca-panel h4{margin:0 0 8px;color:#9cc8ff;font-size:13px;display:flex;justify-content:space-between}
    .ca-panel input{width:100%;box-sizing:border-box;background:#111;color:#f3f3f1;border:1px solid #3a3a37;border-radius:6px;padding:6px 8px;font:13px monospace}
    .ca-panel button{background:#2a78d6;color:#fff;border:0;border-radius:6px;padding:6px 10px;font:600 12px system-ui;cursor:pointer;margin:6px 6px 0 0}
    .ca-panel button.ca-ghost{background:#2c2c2a;color:#e8e8e4}
    .ca-panel table{width:100%;border-collapse:collapse;margin-top:6px;font-variant-numeric:tabular-nums}
    .ca-panel td,.ca-panel th{padding:3px 4px;text-align:right;border-bottom:1px solid #2c2c2a}.ca-panel td:first-child,.ca-panel th:first-child{text-align:left}
    .ca-panel th{color:#8f8e86;font-weight:500}.ca-muted{color:#8f8e86;font-size:12px}.ca-err{color:#ff9b8f}
    .ca-chip{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;border:0;cursor:pointer;font:600 11px/1.6 system-ui,sans-serif;
      background:#2c2c2a;color:#b5b4ad;vertical-align:middle}
    .ca-chip.good{background:#1d5e3a;color:#d9ffe9}.ca-chip.mid{background:#5a4712;color:#ffe9a8}.ca-chip.bad{background:#6b2020;color:#ffd6d6}
    .ca-chip:hover{filter:brightness(1.2)}
    .ca-pop{position:fixed;z-index:100000;width:min(340px,92vw);background:#1a1a19;color:#f3f3f1;border:1px solid #3a3a37;border-radius:10px;
      padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.55);font:13px/1.45 system-ui,sans-serif}
    .ca-pop h5{margin:0 0 6px;font-size:13px;color:#9cc8ff;display:flex;justify-content:space-between;gap:8px}
    .ca-pop .ca-x,.ca-panel .ca-x{background:none;border:0;color:#c3c2b7;cursor:pointer;font-size:14px;padding:0 4px;margin:0}
    .ca-verdict{padding:6px 10px;border-radius:6px;background:#232321;margin-bottom:8px}
    .ca-pop dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:4px 0 8px}.ca-pop dt{color:#8f8e86}.ca-pop dd{margin:0}
    .ca-sec{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8f8e86;margin:6px 0 2px}.ca-sec span{text-transform:none;letter-spacing:0}
    .ca-meth{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-bottom:4px}
    .ca-meth th{color:#8f8e86!important;font:500 11px system-ui,sans-serif!important;text-align:right;padding:2px 4px}.ca-meth th:first-child{text-align:left}
    .ca-meth td{color:#f3f3f1!important;font-size:12px!important;text-align:right;padding:3px 4px;white-space:nowrap;background:none!important}
    .ca-meth td:first-child{text-align:left}.ca-meth tr.ca-best td{background:rgba(63,185,80,.08)!important}
    .ca-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:0}
    .ca-mdot{position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 2px #1a1a19;pointer-events:none;z-index:2}
    .ca-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font:600 10px/1.6 system-ui,sans-serif;background:#2c2c2a;color:#e8e8e4}
    .ca-tag.good{background:#1d5e3a;color:#d9ffe9}
    .ca-verdict.ca-warn{background:#5a4712!important;color:#ffe9a8!important}
    .ca-req{display:inline-block;background:#3a2f12;color:#ffe9a8;border-radius:999px;padding:1px 8px;margin:0 4px 4px 0;font-size:11px}
    /* Torn's own stylesheet (dark mode tables, headings) wins otherwise: pin what matters */
    .ca-panel td,.ca-pop dd,.ca-verdict{color:#f3f3f1!important;background:none!important;font-size:13px!important}
    .ca-verdict{background:#232321!important}
    .ca-panel th,.ca-pop dt,.ca-panel .ca-muted,.ca-pop .ca-sec,.ca-panel .ca-sec{color:#8f8e86!important}
    .ca-panel .ca-err{color:#ff9b8f!important}
    .ca-panel h4,.ca-pop h5{font:600 13px/1.4 system-ui,sans-serif!important;color:#9cc8ff!important;text-transform:none!important;letter-spacing:0!important}
    .ca-panel input{color:#f3f3f1!important;background:#111!important}
    .ca-chip{color:#b5b4ad!important;background:#2c2c2a!important}
    .ca-chip.good{background:#1d5e3a!important;color:#d9ffe9!important}.ca-chip.mid{background:#5a4712!important;color:#ffe9a8!important}
    .ca-chip.bad{background:#6b2020!important;color:#ffd6d6!important}`;
  document.head.appendChild(style);

  let panel = null;
  const btn = $("button", "ca-btn", "Crime Advisor");
  btn.type = "button";
  if (onCrimes) body.appendChild(btn);
  btn.onclick = () => { if (panel) { panel.remove(); panel = null; } else { panel = $("div", "ca-panel"); body.appendChild(panel); renderPanel(); } };
  setInterval(async () => {  // while the panel is open: another tab's progress shows up here too
    if (!panel) return;
    const typing = panel.querySelector("input");
    if (typing && (typing.value || document.activeElement === typing)) return;
    if (!syncing && get("sync", {}).oldest !== (lastOldest ?? get("sync", {}).oldest)) await recompute();
    lastOldest = get("sync", {}).oldest;
    renderPanel();
  }, 5000);
  let lastOldest = null;

  function renderPanel() {
    if (!panel) return;
    panel.replaceChildren();
    const h = $("h4"); const x = $("button", "ca-x", "\u2715"); x.onclick = () => { panel.remove(); panel = null; };
    h.append($("span", "", "Crime Advisor"), x);
    panel.append(h);
    const key = get("key", "");
    if (!key) {
      panel.append($("div", "", "Add your Torn API key to see your own $/nerve. Arson recipes and requirements work without it."),
        $("div", "ca-muted", "It stays in this browser and is only sent to api.torn.com."));
    }
    const mk = $("a", "", "Make a log-only key on Torn \u2197");  // Torn's form has no Custom option: this link pre-fills one
    mk.href = KEY_LINK; mk.target = "_blank"; mk.rel = "noopener"; mk.style.cssText = "display:inline-block;margin:6px 0;color:#9cc8ff";
    panel.append(mk);
    const inp = $("input"); inp.type = "password"; inp.placeholder = key ? "\u2022\u2022\u2022\u2022 key saved (paste to replace)" : "API key"; inp.autocomplete = "off";
    const save = $("button", "", key ? "Replace key" : "Save key");
    save.onclick = async () => {
      const v = inp.value.trim();
      if (!/^[A-Za-z0-9]{16}$/.test(v)) { alert("A Torn API key is 16 letters and numbers."); return; }
      set("key", v); inp.value = "";
      try { await api("/user/log", { cat: 136, limit: 1 }); } catch (e) { set("key", ""); alert(`That key doesn't work: ${e.message}`); renderPanel(); return; }
      renderPanel(); start();
    };
    panel.append(inp, save);
    if (key) {
      const forget = $("button", "ca-ghost", "Remove key and data");
      forget.onclick = async () => { if (!confirm("Remove your key and the crime logs stored in this browser?")) return;
        set("key", ""); set("sync", { newest: null, oldest: null, done: false }); await idb.clear(); await recompute(); renderPanel(); };
      panel.append(forget);
      const st = get("sync", {});
      const status = syncError ? $("div", "ca-err", `Sync problem: ${syncError}`)
        : $("div", "ca-muted", (summary ? `${summary.logs.toLocaleString()} crime logs stored` : "") + (st.oldest ? `, back to ${new Date(st.oldest * 1000).toLocaleDateString()}` : "")
          + (syncing ? ` \u00b7 ${syncNote || "checking for new logs"}\u2026`
             : Date.now() - get("lock", 0) < 20000 ? " \u00b7 loading in another Torn tab\u2026"
             : st.done ? " \u00b7 up to date" : " \u00b7 more history loads while Torn is open"));
      status.style.marginTop = "8px";
      panel.append(status);
      if (memoryOnly) panel.append($("div", "ca-muted", "This browser blocks site storage here (a private window?): your logs are re-read each visit."));
    }
    if (summary && summary.logs) {
      panel.append($("div", "ca-sec", "Your $/nerve by crime"));
      const t = $("table");
      const hr = $("tr"); ["Crime", "All time", "30 days", "Nerve (30d)"].forEach(c => hr.append($("th", "", c))); t.append(hr);
      const m = Object.fromEntries(summary.month.crimes.map(c => [c.id, c]));
      for (const c of summary.all.crimes.filter(c => c.id)) {
        const r = $("tr"); const mm = m[c.id] || {};
        [c.name, short(c.per_nerve), mm.nerve ? short(mm.per_nerve) : "\u2013", mm.nerve ? mm.nerve.toLocaleString() : "\u2013"].forEach(v => r.append($("td", "", v)));
        t.append(r);
      }
      panel.append(t, $("div", "ca-muted", `All crimes: ${short(summary.all.total.per_nerve)}/nerve all time. Materials and item rewards at today's market prices; scamming includes spam waves and email farming.`));
    }
  }

  // ---------------- the crime pages: a button per job, spot or scam type; a card with the details ----------------
  let tab = null, pop = null;
  const currentTab = () => (location.hash.match(/^#\/([a-z-]+)/i) || [])[1] || null;
  function requirements(el, byName) {  // icons whose labels end in "required"/"requested", from the job's own row
    let row = el;
    for (let up = el.parentElement, i = 0; up && i < 8; up = up.parentElement, i++) {
      const t = (up.textContent || "").toLowerCase();
      let n = 0; const most = new Map();  // occurrences per entry (disposal repeats a job row by row; a scam matches two ways)
      byName.forEach((v, k) => { most.set(v, Math.max(most.get(v) || 0, t.split(k).length - 1)); });
      most.forEach(c => { n += c; });
      if (n > 1) break;
      row = up;
    }
    const labels = [...row.querySelectorAll("[aria-label], [title]")].map(x => (x.getAttribute("aria-label") || x.getAttribute("title") || "").trim());
    return { row, needs: [...new Set(labels.filter(l => /\b(required|requested)$/i.test(l)).map(l => l.replace(/\s*(required|requested)$/i, "")))] };
  }
  function closePop() { if (pop) pop.remove(); pop = null; }
  function openPop(anchor, v, needs, fellShort) {
    const again = pop && pop.dataset.kind === v.kind;
    closePop();
    if (again) return;
    pop = $("div", "ca-pop"); pop.dataset.kind = v.kind;
    const x = $("button", "ca-x", "\u2715"); x.onclick = closePop;
    const h = $("h5"); h.append($("span", "", v.kind), x); pop.append(h);
    pop.append($("div", "ca-verdict", fellShort != null ? `Fell short: ${fellShort}% of the 100% it needs. No payout.`
      : v.source === "community" ? "New to you: the community's numbers below."
      : v.few ? "Little history yet." : v.per_nerve < 0 ? "Has lost you money: materials cost more than it paid."
      : v.worth ? "Worth it: above your usual for this crime and your average across crimes."
      : v.vs_crime >= 1 ? "Above your usual for this crime, below your average across crimes." : "Below your usual for this crime."));
    const dl = rows => { const d = $("dl"); rows.filter(r => r && r[1]).forEach(([k, val]) => d.append($("dt", "", k), $("dd", "", val))); return d; };
    if (v.source !== "community") pop.append(dl([
      ["Your $/nerve", `${short(v.per_nerve)}` + (v.vs_crime != null ? ` \u00b7 ${v.vs_crime.toFixed(1)}\u00d7 your usual` : "")],
      ["Your history", `${v.count} ${v.unit}` + (v.avg_net ? ` \u00b7 about ${short(v.avg_net)} each` : "") +
        (v.your_share != null ? ` \u00b7 ${Math.round(v.your_share * 100)}% of its top pay` : "") + (v.win_rate != null ? ` \u00b7 ${Math.round(v.win_rate * 100)}% paid` : "")]]));
    if (v.methods && v.methods.length) pop.append(methodTable(v));
    if (needs.length) { pop.append($("div", "ca-sec", "Needs")); const d = $("div"); needs.forEach(n => d.append($("span", "ca-req", n))); pop.append(d); }
    const c = v.community;
    if (c) {
      const noFT = flameBanned(needs, v);
      if (noFT) pop.append($("div", "ca-verdict ca-warn", "\u26a0 Accidental cause: the Flamethrower isn't accidental, so lighting or stoking with it fails the job. Use a Lighter."));
      const sec = $("div", "ca-sec", "Community recipe ");
      sec.append($("span", "", `\u00b7 pays ${short(c.min)}\u2013${short(c.max)}` + (c.per_nerve != null ? ` \u00b7 ~${short(c.per_nerve)}/nerve` : "")));
      pop.append(sec, dl(c.steps.map(([k, t]) => [k, noFT && /^(Ignite|Stoke)$/.test(k) ? t.replace(/flamethrower/ig, "Lighter (not the Flamethrower)") : t])));
    }
    if (v.recipe || v.tend) { pop.append($("div", "ca-sec", "Your record")); pop.append(dl([["Winning recipe", v.recipe], ["Tending", v.tend]])); }
    body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, ht = pop.offsetHeight;
    Object.assign(pop.style, { left: `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`,
                               top: `${r.bottom + 6 + ht < innerHeight ? r.bottom + 6 : Math.max(8, r.top - ht - 6)}px` });
  }
  document.addEventListener("click", e => { if (pop && !pop.contains(e.target)) closePop(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(); });
  addEventListener("scroll", closePop, { passive: true });

  // A job that must look accidental (an insurance job) fails if it's lit or stoked with the Flamethrower, though the
  // community recipe often says to. When the job's requirements say so and the recipe uses one, the button warns and
  // the card swaps in a Lighter. (Any requirement mentioning "accident" or "insurance" counts.)
  const ACCIDENT = /accident|insurance/i;
  const flameBanned = (needs, v) => needs.some(n => ACCIDENT.test(n)) && !!v.community &&
    v.community.steps.some(([k, t]) => /^(Ignite|Stoke)$/.test(k) && /flamethrower/i.test(t));
  // Disposal: each method's reliability, nerve and expected $/nerve, in the card (not a pick: cheap abandoning tops nearly everything).
  // How reliable a method is (the community chart blended with your own record): the chart's colours.
  const RELY = p => p == null ? ["#6e7681", "not enough data"] : p >= 0.9 ? ["#3fb950", "very likely to work"]
    : p >= 0.78 ? ["#e3d341", "works, with caution"] : p >= 0.5 ? ["#e8913a", "works but fails often"] : ["#e5484d", "fails almost every time"];
  function methodTable(v) {
    const box = $("div");
    box.append($("div", "ca-sec", "Which method"));
    const t = $("table", "ca-meth"), hr = $("tr");
    ["", "Works", "Nerve", "Expected", "Crits"].forEach(h => hr.append($("th", "", h)));
    t.append(hr);
    for (const m of v.methods) {
      const tr = $("tr"), name = $("td");
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
  // A reliability dot on each method's icon on the page. The icons are found
  // by their labels ("Abandon", "Bury"...); if Torn's labels don't say, nothing is drawn (the card still has it all).
  const VERB = { Abandoning: /abandon|leave/i, Burying: /bury/i, Burning: /burn/i, Sinking: /sink/i, Dissolving: /dissolv/i };
  function markMethods(row, v) {
    const labelled = [...row.querySelectorAll("[aria-label], [title]")].filter(x => !x.closest(".ca-chip, .ca-pop"));
    for (const m of v.methods) {
      if (!m.available) continue;
      const icon = labelled.find(x => VERB[m.method].test(`${x.getAttribute("aria-label") || ""} ${x.getAttribute("title") || ""}`));
      if (!icon || icon.querySelector(":scope > .ca-mdot")) continue;
      const [col, word] = RELY(m.p), dot = $("span", "ca-mdot");
      dot.style.background = col; dot.title = `${m.method}: ${word}`;
      if (getComputedStyle(icon).position === "static") icon.style.position = "relative";
      icon.appendChild(dot);
    }
  }
  function badges() {
    const list = values && values.tabs[CA.slug(tab || "")];
    if (!list || !list.length) return;
    const root = document.querySelector("[class*='crimes-app'], #react-root, .content-wrapper") || body;
    root.querySelectorAll(".ca-chip").forEach(c => { if (+c.dataset.v !== version) c.remove(); });
    const byName = new Map();
    list.forEach(v => v.find.forEach(f => byName.set(f.toLowerCase(), v)));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue.trim().toLowerCase();
      if (t.length < 3 || t.length > 60 || !byName.has(t)) continue;
      const el = n.parentElement;
      if (el && !el.closest(".ca-chip, .ca-pop, .ca-panel") && !el.querySelector(":scope > .ca-chip")) hits.push([el, byName.get(t)]);
    }
    for (const [el, v] of hits) {
      const { needs, row } = requirements(el, byName);
      const text = row.textContent || "", pct = +((text.match(/(\d{1,3})%/) || [])[1] ?? NaN);
      const short100 = needs.some(n => /total destruction/i.test(n)) && /COLLECT/.test(text) && pct < 100;
      const noFT = flameBanned(needs, v);
      const b = $("button", "ca-chip " + (short100 ? "bad" : noFT ? "mid" : v.worth ? "good" : !v.few && v.vs_crime >= 1 ? "mid" : ""));
      b.type = "button";
      b.dataset.v = version;
      if (noFT) b.title = "Accidental cause: the community recipe uses the Flamethrower, which fails it. Ignite and stoke with a Lighter.";
      b.textContent = (noFT ? "\u26a0 " : "") + (short100 ? `fell short ${pct}%` : v.per_nerve < 0 ? "lost money" : `${short(v.per_nerve)}/nerve`)
        + " \u25be";
      b.onclick = e => { e.preventDefault(); e.stopPropagation(); openPop(b, v, needs, short100 ? pct : null); };
      el.appendChild(b);
      if (v.methods) markMethods(row, v);
    }
  }

  // ---------------- run ----------------
  let started = false;
  async function start() {
    await recompute();
    if (!started) {
      started = true;
      setInterval(() => { const t = currentTab(); if (t !== tab) { tab = t; closePop(); } if (tab) badges(); }, 1000);
      setInterval(() => sync(renderPanel).then(recompute), 5 * 60000);  // new logs every 5 minutes while Torn is open
    }
    if (get("key", "")) sync(renderPanel).then(recompute);
  }
  if (onCrimes) start();
  else if (get("key", "")) {  // other Torn pages only keep the logs up to date (history keeps loading while you play)
    sync(() => {});
    setInterval(() => sync(() => {}), 5 * 60000);
  }
})();
