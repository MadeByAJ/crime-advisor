/* TornBrain web apps: your Torn API key and your logs, kept in this browser. The key is sent to api.torn.com only (the
   page's Content-Security-Policy allows no other address), one request every 2 s at most, so these tools use a small
   part of the 100 a minute Torn allows you across all your tools. Ported from Crime Advisor's userscript. */
(function (root) {
  "use strict";
  const KEY = "tornbrain.key";
  const GAP_MS = 2000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- the key: this tab only, unless you ask this browser to remember it ----
  const key = () => { try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || ""; } catch (e) { return ""; } };
  const remembered = () => { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } };
  function setKey(k, remember) {
    try {
      sessionStorage.setItem(KEY, k);
      if (remember) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY);
    } catch (e) { /* storage blocked: the key lives as long as this page */ memKey = k; }
  }
  let memKey = "";
  const currentKey = () => key() || memKey;
  function forgetKey() { memKey = ""; try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
  // A custom key with only the selections a tool needs (Torn's own "new key" form, filled in)
  const keyLink = (title, user = "log,basic") =>  // (basic: players' public names, e.g. who you traded with)
    `https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=${encodeURIComponent(title)}&user=${user}`;
  const validKey = k => /^[A-Za-z0-9]{16}$/.test(k || "");

  // ---- the Torn API ----
  const MESSAGES = { 2: "That API key isn't right: check you copied all 16 characters.",
    16: "This key can't read your logs: make a key with the button above (it only needs \"log\").",
    5: "Too many requests to Torn from your tools: waiting a minute.",
    8: "Torn has paused requests from your connection for a while (too many requests).",
    13: "Torn has turned this key off: its owner hasn't been active for a week.",
    18: "This key is paused: turn it back on in Torn's settings, or make a new one.",
    10: "This key's owner is in federal jail.", 9: "Torn's API is down for maintenance: try again shortly.",
    17: "Torn's API had a problem: try again shortly.", 24: "Torn's API is temporarily off: try again shortly." };
  let lastReq = 0;
  async function api(path, params = {}, comment = "TornBrain") {
    const k = currentKey();
    if (!k) throw Object.assign(new Error("No API key yet."), { code: 0 });
    const wait = lastReq + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    const q = new URLSearchParams(Object.entries({ ...params, comment }).filter(([, v]) => v != null && v !== ""));
    let r, j;
    try {
      r = await fetch(`https://api.torn.com/v2${path}?${q}`, { headers: { Authorization: `ApiKey ${k}` }, cache: "no-store" });
      j = await r.json();
    } catch (e) {
      throw Object.assign(new Error("Couldn't reach Torn: check your connection and try again."), { code: -1 });
    }
    if (j && j.error) throw Object.assign(new Error(MESSAGES[j.error.code] || j.error.error || "Torn refused the request."), { code: j.error.code });
    if (!r.ok) throw Object.assign(new Error(`Torn answered ${r.status}: try again shortly.`), { code: -1 });
    return j;
  }

  // ---- logs, kept in this browser (IndexedDB; in memory for this visit where a browser blocks it) ----
  function store(name) {
    let p = null, memoryOnly = false;
    const mem = new Map();
    const open = () => p || (p = new Promise(res => {
      const fail = () => { memoryOnly = true; res(null); };
      const timer = setTimeout(fail, 5000);
      try {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore("logs", { keyPath: "id" });
        r.onsuccess = () => { clearTimeout(timer); res(r.result); };
        r.onerror = () => { clearTimeout(timer); fail(); };
      } catch (e) { clearTimeout(timer); fail(); }
    }));
    const tx = async (mode, fn, memFn) => {
      const db = await open();
      if (!db) return memFn();
      return new Promise((res, rej) => {
        const t = db.transaction("logs", mode), s = t.objectStore("logs"), out = fn(s);
        t.oncomplete = () => res(out && "result" in out ? out.result : out);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get memoryOnly() { return memoryOnly; },
      put: rows => tx("readwrite", s => { rows.forEach(r => s.put(r)); }, () => rows.forEach(r => mem.set(r.id, r))),
      all: () => tx("readonly", s => s.getAll(), () => [...mem.values()]),
      count: () => tx("readonly", s => s.count(), () => mem.size),
      clear: () => tx("readwrite", s => s.clear(), () => mem.clear()),
      drop: async () => { mem.clear(); const db = await open(); if (db) db.close(); p = null; try { indexedDB.deleteDatabase(name); } catch (e) { /* ignore */ } },
    };
  }
  const slim = l => ({ id: String(l.id), ts: l.timestamp, type: (l.details || {}).id, d: l.data || {} });
  const state = (k, v) => {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null");
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  };

  // One stream of log types (10 at most per request: Torn returns nothing above that): new logs first, then back
  // through history to `horizon` (unix seconds; 0 = all of it). Progress is kept, so a later visit carries on.
  // `to` is inclusive. Several logs often share one second (a few stacks sold at once), and a page can end part way
  // through it, so the next page starts at that same second; logs are stored once (by id) and a page that brings
  // nothing new steps past the second. (Stepping past it straight away lost the rest of the second on a later visit
  // with over 100 new logs: a tester's shark fins sold to Nikeh read as unsold, 2026-10-16.) SYNC_V 2 reads once more
  // what earlier versions may have skipped.
  const SYNC_V = 2;
  async function syncStream({ db, types, id, horizon = 0, comment, onPage }) {
    const sk = `tornbrain.sync.${id}`;
    const blank = { v: SYNC_V, newest: null, oldest: null, done: false, horizon: null };
    let st = state(sk) || blank;
    if (st.v !== SYNC_V || (db.memoryOnly && !syncStream.seen?.[id])) st = { ...blank };
    (syncStream.seen = syncStream.seen || {})[id] = true;
    if (st.horizon != null && horizon < st.horizon) st.done = false;  // (asked for older history than before)
    const page = async (to, from) => {
      const j = await api("/user/log", { log: types.join(","), limit: 100, to, from }, comment);
      const logs = j.log || [];
      if (logs.length) await db.put(logs.map(slim));
      onPage && onPage(logs.length);
      return logs;
    };
    // new logs: back from now to the newest we already have (a first visit takes one page; history does the rest)
    const had = st.newest;
    let to = null, prev = new Set();
    for (let i = 0; i < 300; i++) {
      const logs = await page(to, had ? had - 1 : null);
      if (!logs.length) { if (st.newest == null) st.done = true; break; }
      const ts = logs.map(l => l.timestamp), oldest = Math.min(...ts);
      st.newest = Math.max(st.newest || 0, ...ts);
      st.oldest = st.oldest == null ? oldest : Math.min(st.oldest, oldest);
      if (logs.length < 100) break;
      if (horizon && oldest <= horizon) { st.done = true; break; }  // (a first visit: as far back as asked)
      if (had == null) break;
      const fresh = logs.some(l => !prev.has(String(l.id)));
      prev = new Set(logs.map(l => String(l.id)));
      to = fresh ? oldest : oldest - 1;
    }
    state(sk, st);
    // history: back to the horizon (or the start of your logs)
    while (!st.done && st.oldest != null && st.oldest > horizon) {
      const logs = await page(st.oldest, horizon || null);
      if (logs.length) st.oldest = Math.min(st.oldest, ...logs.map(l => l.timestamp)) - (logs.length === 100 ? 0 : 1);
      if (logs.length < 100) st.done = true;
      else if (logs.every(l => l.timestamp === st.oldest)) st.oldest -= 1;  // a full page within one second: step past it
      state(sk, st);
    }
    if (st.oldest != null && st.oldest <= horizon) st.done = true;
    st.horizon = horizon;
    state(sk, st);
    return st;
  }
  const forgetSync = id => state(`tornbrain.sync.${id}`, null);

  // One tab syncs at a time (another tab's sync keeps a heartbeat)
  async function withLock(name, fn) {
    const k = `tornbrain.lock.${name}`;
    if (Date.now() - (state(k) || 0) < 15000) return false;
    state(k, Date.now());
    const beat = setInterval(() => state(k, Date.now()), 4000);
    try { await fn(); return true; } finally { clearInterval(beat); state(k, null); }
  }

  // Item names and today's market prices, once a day, from Torn's item list. A log-only key can't read that list
  // (Torn: "access level not high enough"), so the names, and market values as of the file's date, also ship with the
  // site (lib/items.json, public game data); items.limited says which this visit used.
  const SITE = (document.currentScript && document.currentScript.src) || location.href;
  let shipped = null;
  async function shippedItems() {
    if (!shipped) {
      try { shipped = await (await fetch(new URL("items.json", SITE), { cache: "force-cache" })).json(); }
      catch (e) { shipped = { at: 0, items: {} }; }
    }
    return shipped;
  }
  async function items(ids, comment) {
    const cache = state("tornbrain.items") || { at: 0, byId: {} };
    const fresh = Date.now() - cache.at < 86400000 && !cache.limited;
    const need = ids.filter(id => !fresh || !cache.byId[id]);
    items.limited = false;
    try {
      for (let i = 0; i < need.length; i += 100) {
        const j = await api(`/torn/${need.slice(i, i + 100).join(",")}/items`, {}, comment);
        for (const it of j.items || []) cache.byId[it.id] = [it.name, (it.value || {}).market_price || null];
      }
    } catch (e) {
      if (e.code !== 16) throw e;
      items.limited = true;  // (the key can't read Torn's item list: names and dated prices from the site's file)
      const s = await shippedItems();
      items.asOf = s.at || null;
      for (const id of need) if (s.items[id]) cache.byId[id] = s.items[id];
    }
    if (need.length) { cache.at = fresh ? cache.at : Date.now(); cache.limited = items.limited; state("tornbrain.items", cache); }
    return cache.byId;
  }
  const forgetItems = () => state("tornbrain.items", null);

  // Players' names (your trade partners: Torn's logs only carry their id), looked up once and kept in this browser for
  // a month. Needs "basic" on the key; with a key without it, players.limited is set and they show by id.
  async function players(ids, comment, max = 25) {
    const cache = state("tornbrain.players") || {}, now = Date.now();
    const need = ids.filter(id => !cache[id] || now - cache[id][1] > 30 * 86400000).slice(0, max);
    players.limited = false;
    for (const id of need) {
      try {
        const p = (await api(`/user/${id}/basic`, {}, comment)).profile || {};
        cache[id] = [p.name || null, now];
      } catch (e) {
        if (e.code === 16) players.limited = true;
        break;  // (anything else: try again next time; names aren't worth an error)
      }
    }
    if (need.length) state("tornbrain.players", cache);
    return knownPlayers();
  }
  const knownPlayers = () => Object.fromEntries(Object.entries(state("tornbrain.players") || {}).filter(([, v]) => v[0]).map(([k, v]) => [k, v[0]]));
  const forgetPlayers = () => state("tornbrain.players", null);

  root.Torn = { key: currentKey, setKey, forgetKey, remembered, keyLink, validKey, api, store, syncStream, forgetSync,
    withLock, items, forgetItems, players, knownPlayers, forgetPlayers, sleep };
})(typeof self !== "undefined" ? self : this);
