/* Travel Profits: your Torn travel logs, read in your browser with a log-only key (lib/torn.js), worked out by
   lib/travel-core.js (the same numbers as TornBrain's own Travel page). */
(function () {
  "use strict";
  const T = TravelCore, COMMENT = "TornBrainTravel", db = Torn.store("tornbrain-travel");
  const STREAMS = [{ id: "travel-a", types: [6000, 4201, 4210, 1113, 1226, 1500, 6001, 6002] },
                   { id: "travel-b", types: [4445, 4102, 4441, 8155] }];  // (10 log types a request at most)
  const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"], [0, "All"]];
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ls = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null"); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } };
  const money = n => n == null || isNaN(n) ? "–" : (n < 0 ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString();
  const short = n => {
    if (n == null || isNaN(n)) return "–";
    const a = Math.abs(n), s = n < 0 ? "-" : "";
    return s + (a >= 1e9 ? `$${(a / 1e9).toFixed(2)}b` : a >= 1e6 ? `$${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `$${(a / 1e3).toFixed(1)}k` : `$${Math.round(a)}`);
  };
  const m = n => `<span title="${money(n)}">${short(n)}</span>`;
  const tip = (label, text) => `<button type="button" class="pill tip" data-tip="${esc(text)}" aria-expanded="false">${label}</button>`;
  const hours = h => h == null ? "–" : h >= 10 ? `${Math.round(h)}h` : `${Math.floor(h)}h${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const when = ts => new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  // trade partners: Torn's logs carry their id (written @id here); the name once looked up (Torn.players), else the id
  const people = s => esc(s).replace(/@(\d+)/g, (_, id) => `<a class="player" href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener">${esc(playerNames[id] || `player ${id}`)}</a>`);

  const demo = new URLSearchParams(location.search).has("demo");
  let days = ls("tornbrain.travel.days") ?? 30;
  let sample = null, itemInfo = {}, playerNames = Torn.knownPlayers(), busy = false, pages = 0;

  function status(html, progress) {
    $("#status").innerHTML = html;
    $("#bar").hidden = progress == null;
    if (progress != null) $("#bar > i").style.width = `${Math.min(100, progress)}%`;
  }

  async function logs() { return demo ? sample.logs : db.all(); }

  async function render() {
    const all = await logs();
    const now = demo ? sample.now : Math.floor(Date.now() / 1000);
    const price = {}, names = {};
    for (const [id, [name, p]] of Object.entries(demo ? sample.items : itemInfo)) { names[id] = name; if (p) price[id] = p; }
    const r = T.report(all, days || null, { now, price, names, who: id => `@${id}` });
    const t = r.totals;
    $("#range").innerHTML = RANGES.map(([d, l]) => `<button class="chip" data-days="${d}" aria-pressed="${d === days}">${l}</button>`).join("");
    const best = r.countries.filter(c => c.trips >= 2 && c.per_flight_h != null).sort((a, b) => b.per_flight_h - a.per_flight_h)[0];
    $("#tiles").innerHTML = [
      ["Earned", m(t.total), t.fees ? `after ${short(t.fees)} in travel fees` : "goods sold + waiting, and mugs"],
      ["Per flight hour", m(t.per_flight_h), `${hours(t.flight_h)} in the air`],
      ["Trips", `${t.trips}`, t.per_trip != null ? `${short(t.per_trip)} a trip` : ""],
      ["Best per hour", best ? esc(best.country) : "–", best ? `${short(best.per_flight_h)} an hour over ${best.trips} trips` : "after a couple of trips"],
    ].map(([l, v, s]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
    const bits = [];
    if (t.pending) bits.push(`${t.pending} item${t.pending === 1 ? "" : "s"} waiting to sell are counted at your last sale price (${short(t.pending_value)}).`);
    if (t.kept) bits.push(`${t.kept} kept for yourself aren't counted in Earned (worth ${short(t.kept_value)} at today's prices).`);
    if (t.gifted) bits.push(`${t.gifted} sent or traded away count at market value (${short(t.gift_value)}).`);
    $("#tiles-note").textContent = bits.join(" ");

    $("#dest").innerHTML = `<thead><tr><th>Destination</th><th class="r">Trips</th><th class="r">Flying</th><th class="r">Spent</th><th class="r">Goods</th><th class="r">Mugs</th><th class="r">Earned</th><th class="r">Per trip</th><th class="r">Per flight hour</th></tr></thead>
      <tbody>${r.countries.map(c => `<tr><td>${esc(c.country)}</td><td class="r">${c.trips}</td><td class="r">${hours(c.flight_h)}</td><td class="r">${m(c.spent)}</td>
        <td class="r">${m(c.items_profit)}</td><td class="r">${c.mugs ? m(c.mugs) : "–"}</td><td class="r"><b>${m(c.total)}</b></td><td class="r">${m(c.per_trip)}</td><td class="r">${m(c.per_flight_h)}</td></tr>`).join("")
        || `<tr><td colspan="9" class="faint">No trips abroad in this period.</td></tr>`}</tbody>`;
    $("#items").innerHTML = `<thead><tr><th>Item</th><th>From</th><th class="r">Bought</th><th class="r">Paid each</th><th class="r">Sold</th><th class="r">Sold each</th><th class="r">Margin each</th><th>Goes to</th><th class="r">Profit</th><th>Not sold</th></tr></thead>
      <tbody>${r.items.map(i => `<tr><td>${esc(i.item)}</td><td>${esc(i.countries.join(", "))}</td><td class="r">${i.bought.toLocaleString()}</td><td class="r">${m(i.cost_each)}</td>
        <td class="r">${i.sold ? i.sold.toLocaleString() : "–"}</td><td class="r">${i.sold_each != null ? m(i.sold_each) : "–"}</td>
        <td class="r ${i.margin_each > 0 ? "good" : i.margin_each < 0 ? "bad" : ""}">${i.margin_each != null ? m(i.margin_each) : "–"}</td>
        <td>${i.sells_to ? people(i.sells_to) : i.gives_to ? `${people(i.gives_to)} <span class="faint">(sent)</span>` : "–"}</td>
        <td class="r"><b>${m(i.total)}</b>${i.kept_gain ? ` ${tip("incl. kept", `Includes ${money(i.kept_gain)} on units you kept: what they're worth at today's market price, minus what you paid abroad. That's what flying for them saved you over buying at home. It isn't cash, so it's left out of Earned at the top.`)}` : ""}</td>
        <td>${i.pending ? tip(`${i.pending} waiting`, `${i.pending} not sold yet of an item you do sell. Counted at your last sale price (or today's market price, if that's higher).`)
          : i.kept ? tip(`${i.kept} kept`, `${i.kept} bought abroad and never sold, traded or sent: usually ones you used yourself (the page can't tell used from still in your inventory). Valued at today's market price.`) : "–"}</td></tr>`).join("")
        || `<tr><td colspan="10" class="faint">Nothing bought abroad in this period.</td></tr>`}</tbody>`;
    $("#trips").innerHTML = `<thead><tr><th>Left</th><th>Destination</th><th class="r">Flying</th><th class="r">Stayed</th><th>Bought</th><th class="r">Spent</th><th class="r">Goods</th><th class="r">Mugs</th><th class="r">Total</th></tr></thead>
      <tbody>${r.trips.map(tr => `<tr><td>${when(tr.out)}</td><td>${esc(tr.country)}</td><td class="r">${hours(tr.flight_h)}</td><td class="r">${tr.stay_min != null ? `${tr.stay_min}m` : '<span class="faint">abroad</span>'}</td>
        <td>${esc(tr.bought.map(b => `${b.qty} ${b.item}`).join(", ")) || '<span class="faint">nothing</span>'}</td><td class="r">${tr.spent ? m(tr.spent) : "–"}</td>
        <td class="r">${m(tr.items_profit)}</td><td class="r">${tr.mugs ? m(tr.mugs) : "–"}</td><td class="r"><b>${m(tr.total)}</b></td></tr>`).join("")
        || `<tr><td colspan="9" class="faint">No trips abroad in this period.</td></tr>`}</tbody>`;
  }

  async function sync(older = false) {
    if (busy || demo) return;
    busy = true; pages = 0;
    let horizon = ls("tornbrain.travel.horizon");
    if (horizon == null) horizon = Math.floor(Date.now() / 1000) - 365 * 86400;  // a year to start with
    if (older) { horizon = 0; ls("tornbrain.travel.horizon", 0); }
    else if (ls("tornbrain.travel.horizon") == null) ls("tornbrain.travel.horizon", horizon);
    const label = () => horizon ? "the last year" : "all of your history";
    let reading = true;  // (a key that can't read logs goes back to the start; later steps never do)
    try {
      const ran = await Torn.withLock("travel", async () => {
        for (const [i, s] of STREAMS.entries()) {
          await Torn.syncStream({ db, types: s.types, id: s.id, horizon, comment: COMMENT,
            onPage: () => { pages++; status(`Reading your logs (${label()})… ${pages} page${pages === 1 ? "" : "s"} so far. <span class="faint">One request every 2 seconds.</span>`, Math.min(95, (i * 50) + pages * 2)); } });
          await render();
        }
        reading = false;
        status("Fetching item names and today's prices…", 97);
        const all = await db.all(), ids = new Set();
        for (const l of all) for (const [id] of T.lines(l.d)) ids.add(id);
        itemInfo = await Torn.items([...ids], COMMENT);
        // the names of who your items went to (the people the tables show, over all time)
        const r = T.report(all, null, { now: Math.floor(Date.now() / 1000), who: id => `@${id}` });
        const who = new Set(r.items.flatMap(i => `${i.sells_to || ""} ${i.gives_to || ""}`.match(/@\d+/g) || []).map(x => x.slice(1)));
        if (who.size) { status("Looking up who you trade with…", 98); playerNames = await Torn.players([...who], COMMENT); }
      });
      if (!ran) status("Another tab is reading your logs: this one shows them once it's done. <button class=\"btn ghost small\" id=\"again\">Check again</button>");
      ls("tornbrain.travel.synced", Date.now());
      showSynced(horizon);
      await render();
    } catch (e) {
      status(`<span class="err">${esc(e.message)}</span>`);
      if (reading && [2, 16, 13, 18].includes(e.code)) { Torn.forgetKey(); showStart(e.message); }
      else if (!reading) status(`<span class="err">Your logs are read, but ${esc(e.message.charAt(0).toLowerCase() + e.message.slice(1))}</span> <button class="btn ghost small" id="again">Try again</button>`);
      if (e.code === 5) setTimeout(() => sync(), 60000);
    } finally { busy = false; }
  }

  async function showSynced(horizon) {
    const n = await db.count(), at = ls("tornbrain.travel.synced");
    const lim = Torn.items.limited || (ls("tornbrain.items") || {}).limited, nameless = Torn.players.limited;
    status(`<b>${n.toLocaleString()}</b> logs read${horizon ? " (the last year)" : ""}${at ? `, updated ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}.${db.memoryOnly ? ' <span class="faint">Your browser blocks storage here, so they\'re read again next visit.</span>' : ""}${lim ? ` <span class="faint">Your key can't read Torn's item list, so unsold items are valued at Torn's prices${Torn.items.asOf ? ` from ${when(Torn.items.asOf)}` : " from a few days ago"}.</span>` : ""}${nameless ? ` <span class="faint">Your key can't look up names, so trade partners show by id: <a href="${Torn.keyLink("TornBrain Travel")}" target="_blank" rel="noopener">a key made with this link</a> (it adds <code>basic</code>) names them.</span>` : ""}`);
    $("#older").hidden = !horizon;
  }

  function showStart(err = "") {
    $("#start").hidden = false; $("#app").hidden = true;
    $("#key-err").textContent = err;
    $("#make-key").href = Torn.keyLink("TornBrain Travel");
  }

  async function start() {
    const k = $("#key-in").value.trim();
    if (!Torn.validKey(k)) { $("#key-err").textContent = "An API key is 16 letters and numbers: check you copied all of it."; return; }
    $("#go").disabled = true; $("#key-err").textContent = "";
    Torn.setKey(k, $("#remember").checked);
    try {
      await Torn.api("/user/log", { log: "6000", limit: 1 }, COMMENT);  // (the key works and can read logs)
    } catch (e) {
      Torn.forgetKey(); $("#go").disabled = false; $("#key-err").textContent = e.message; return;
    }
    $("#key-in").value = ""; $("#go").disabled = false;
    $("#start").hidden = true; $("#app").hidden = false;
    await render(); sync();
  }

  async function forget() {
    if (!confirm("Forget your key and every log this page has read? (The key itself keeps working in Torn until you delete it there.)")) return;
    Torn.forgetKey();
    STREAMS.forEach(s => Torn.forgetSync(s.id));
    Torn.forgetItems(); Torn.forgetPlayers(); playerNames = {};
    try { ["tornbrain.travel.horizon", "tornbrain.travel.synced"].forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
    await db.drop();
    itemInfo = {};
    showStart("Your key and data are gone from this browser.");
  }

  // one explanation bubble at a time, under the label tapped; a tap elsewhere or Escape closes it
  const bubble = Object.assign(document.createElement("div"), { className: "tipbox", hidden: true, role: "tooltip", id: "tipbox" });
  document.body.append(bubble);
  let tipFor = null;
  function closeTip() { bubble.hidden = true; if (tipFor) tipFor.setAttribute("aria-expanded", "false"); tipFor = null; }
  function openTip(btn) {
    closeTip();
    bubble.textContent = btn.dataset.tip; bubble.hidden = false;
    btn.setAttribute("aria-expanded", "true"); btn.setAttribute("aria-describedby", "tipbox"); tipFor = btn;
    const r = btn.getBoundingClientRect(), w = bubble.offsetWidth;
    bubble.style.left = `${Math.max(8, Math.min(r.left + scrollX, scrollX + document.documentElement.clientWidth - w - 8))}px`;
    bubble.style.top = `${r.bottom + scrollY + 6}px`;
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeTip(); });
  addEventListener("resize", closeTip);
  document.addEventListener("click", e => {
    const t = e.target.closest("[data-tip]");
    if (t) { if (t === tipFor) closeTip(); else openTip(t); return; }
    if (!e.target.closest("#tipbox")) closeTip();
    const d = e.target.closest("[data-days]");
    if (d) { days = Number(d.dataset.days); ls("tornbrain.travel.days", days); render(); }
    if (e.target.id === "again") sync();
  });
  $("#go").addEventListener("click", start);
  $("#key-in").addEventListener("keydown", e => { if (e.key === "Enter") start(); });
  $("#refresh").addEventListener("click", () => sync());
  $("#older").addEventListener("click", () => sync(true));
  $("#forget").addEventListener("click", forget);

  (async () => {
    if (demo) {
      $("#demo-note").hidden = false; $("#app").hidden = false; $("#status-card").hidden = true;
      sample = await (await fetch("../demo/travel-sample.json")).json();
      return render();
    }
    if (!Torn.key()) return showStart();
    $("#app").hidden = false;
    itemInfo = (ls("tornbrain.items") || {}).byId || {};
    await render();
    showSynced(ls("tornbrain.travel.horizon"));
    sync();
  })();
})();
