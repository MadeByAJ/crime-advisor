/* TornBrain Travel: what your trips abroad earn, from your own logs. Pure functions, no browser APIs (tested in Node
   against TornBrain's travel.py, which this ports).

   Purchases abroad are lots; every later sale of that item (NPC shop, item market, bazaar, Big Al's) takes from the
   oldest lot first. Profit is what the sold units fetched minus what they cost. Units not sold yet are either "waiting
   to sell" (an item you sell: valued at your last sale price, or the market price if higher) or "kept" (valued at
   today's market price, i.e. what buying abroad saved you; at cost when there's no price). Items traded or sent are
   gifts at market value, unless the trade paid money: then it's a sale at that price.

   A log here is {id, ts, type, d}: Torn's log id, timestamp, log type id and its data. */
(function (root) {
  "use strict";
  const BUY = 4201;
  const SALES = { 4210: "shop", 1113: "Item market", 1226: "Bazaar", 1500: "Big Al's" };
  const FEES = [6001, 6002];
  const GIFTS = [4445, 4102];  // trade items outgoing, item send
  const TRADE_ITEMS_OUT = 4445, TRADE_MONEY_IN = 4441;
  const TRADE_MAX_RATIO = 3;   // a trade paying over 3x its items' market value carried other money too
  const TORN = 1, MUG = 8155, DEPART = 6000;
  const LOG_TYPES = [DEPART, BUY, 4210, 1113, 1226, 1500, ...FEES, ...GIFTS, TRADE_MONEY_IN, MUG];
  const COUNTRIES = { 1: "Torn", 2: "Mexico", 3: "Hawaii", 4: "South Africa", 5: "Japan", 6: "China", 7: "Argentina",
    8: "Switzerland", 9: "Canada", 10: "United Kingdom", 11: "United Arab Emirates", 12: "Cayman Islands" };

  const byTs = (a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id));
  const num = v => (v == null || v === "" ? 0 : Number(v) || 0);
  const of = (logs, types) => logs.filter(l => types.includes(l.type)).sort(byTs);
  // the first key with the largest value (Python's max over an insertion-ordered dict)
  const top = m => { let k = null, v = -Infinity; for (const [kk, vv] of m) if (vv > v) { k = kk; v = vv; } return k; };
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

  // (item, quantity, total $) for each item in one buy or sale log
  function lines(d) {
    d = d || {};
    if (Array.isArray(d.items)) {  // market / bazaar: cost_total is what you received, after any fee
      const items = d.items.filter(i => i.id).map(i => [Number(i.id), Number(i.qty) || 1]);
      const n = items.reduce((a, [, q]) => a + q, 0) || 1;
      const total = num(d.cost_total) || num(d.cost_each) * n;
      return items.map(([it, q]) => [it, q, total * q / n]);
    }
    const item = d.item, qty = Number(d.quantity || d.qty) || 1;
    if (!item) return [];
    const each = num(d.value_each) || num(d.cost_each);
    const total = num(d.total_value) || num(d.cost_total) || num(d.value) || each * qty;
    return [[Number(item), qty, total]];
  }

  function channel(type, d) {
    if (type === 4210) {  // "to Nikeh Performance"
      const area = String((d && d.area) || "");
      return area.startsWith("to ") ? area.slice(3) : area.startsWith("in ") ? `Shop ${area}` : area || "NPC shop";
    }
    return SALES[type];
  }

  // Every purchase abroad, with what has sold or been given away from it so far (oldest lot first per item).
  function lots(logs, price = {}, who = id => `player ${id}`) {
    const out = [], byItem = new Map();
    for (const r of of(logs, [BUY])) {
      for (const [item, qty, total] of lines(r.d)) {
        const lot = { ts: r.ts, item, qty, cost: total, country: (r.d || {}).area, sold: 0, proceeds: 0, channels: new Map(),
          last_sale: null, gifted: 0, gift_value: 0, gift_channels: new Map() };
        out.push(lot);
        if (!byItem.has(item)) byItem.set(item, []);
        byItem.get(item).push(lot);
      }
    }
    const paid = new Map();  // money that came back in each trade: those trades are sales at that price
    for (const r of of(logs, [TRADE_MONEY_IN])) {
      const d = r.d || {};
      if (d.parsed_trade_id) add(paid, d.parsed_trade_id, num(d.money) || num(d.amount));
    }
    for (const r of of(logs, [...Object.keys(SALES).map(Number), ...GIFTS])) {
      const d = r.d || {};
      let gift = GIFTS.includes(r.type), ln = lines(d), ch;
      if (gift) {
        const name = who(d.user || d.receiver);
        let money = r.type === TRADE_ITEMS_OUT ? paid.get(d.parsed_trade_id) : null;
        if (money) {  // a paid trade: the money split across its items by market value
          gift = false; ch = `Trade with ${name}`;
          const weights = ln.map(([item, qty]) => (price[item] || 1) * qty);
          const totalW = weights.reduce((a, b) => a + b, 0) || 1;
          const market = ln.reduce((a, [item, qty]) => a + (price[item] || 0) * qty, 0);
          if (market && money > TRADE_MAX_RATIO * market) money = market;
          ln = ln.map(([item, qty], i) => [item, qty, money * weights[i] / totalW]);
        } else ch = name;
      } else ch = channel(r.type, d);
      for (const [item, qty, total] of ln) {
        let left = qty;
        for (const lot of byItem.get(item) || []) {
          if (left <= 0) break;
          if (lot.ts > r.ts || lot.sold + lot.gifted >= lot.qty) continue;
          const take = Math.min(left, lot.qty - lot.sold - lot.gifted);
          if (gift) {
            const each = price[item] || (lot.qty ? lot.cost / lot.qty : 0);
            lot.gifted += take; lot.gift_value += each * take; add(lot.gift_channels, ch, each * take);
          } else {
            const share = total * take / qty;
            lot.sold += take; lot.proceeds += share; add(lot.channels, ch, share); lot.last_sale = r.ts;
          }
          left -= take;
        }
      }
    }
    return out;
  }

  // Round trips abroad: the flight out, the stay, the flight home.
  function trips(logs) {
    const legs = of(logs, [DEPART]).map(r => ({ ts: r.ts, from: (r.d || {}).origin, to: (r.d || {}).destination,
      dur: num((r.d || {}).duration) }));
    const out = [];
    legs.forEach((leg, i) => {
      if (leg.from !== TORN || leg.to == null || leg.to === TORN) return;
      const back = i + 1 < legs.length && legs[i + 1].from === leg.to ? legs[i + 1] : null;
      out.push({ country: leg.to, out: leg.ts, arrive: leg.ts + leg.dur, leave: back ? back.ts : null,
        home: back ? back.ts + back.dur : null, flight_s: leg.dur + (back ? back.dur : leg.dur) });
    });
    return out;
  }

  // Your most recent sale price per unit, by item (any channel).
  function lastSaleEach(logs) {
    const out = {};
    for (const r of of(logs, Object.keys(SALES).map(Number)))
      for (const [item, qty, total] of lines(r.d)) if (qty) out[item] = total / qty;
    return out;
  }

  function value(lot, price, sale) {
    const each = lot.qty ? lot.cost / lot.qty : 0;
    const unsold = lot.qty - lot.sold - lot.gifted;
    const waiting = lot.item in sale;
    const worth = unsold * (waiting ? Math.max(sale[lot.item], price[lot.item] || 0) : (price[lot.item] || each));
    const gain = worth - each * unsold;
    return { cost_sold: each * lot.sold, profit: lot.proceeds - each * lot.sold, unsold,
      gift_gain: lot.gift_value - each * lot.gifted, held: worth, held_gain: gain,
      pending: waiting ? unsold : 0, pending_gain: waiting ? gain : 0,
      kept: waiting ? 0 : unsold, kept_value: waiting ? 0 : worth, kept_gain: waiting ? 0 : gain };
  }

  const round2 = x => Math.round(x * 100) / 100;
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

  // The whole report for the last `days` (null: all time). opts: {price: {item: $}, names: {item: name},
  // countries: {id: name}, who: id -> trade partner's name, now: unix seconds}
  function report(logs, days = 30, opts = {}) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const lo = days ? now - days * 86400 : 0;
    const price = opts.price || {}, names = opts.names || {}, places = { ...COUNTRIES, ...(opts.countries || {}) };
    const sale = lastSaleEach(logs);
    const place = c => places[c] || String(c);
    const allLots = lots(logs, price, opts.who).filter(l => l.ts >= lo);
    for (const l of allLots) Object.assign(l, value(l, price, sale));

    const mugs = of(logs, [MUG]).filter(r => r.ts >= lo - 86400).map(r => [r.ts, num((r.d || {}).money_mugged)]);
    const tripRows = [];
    for (const t of trips(logs).filter(t => t.out >= lo)) {
      const end = t.leave || now;
      const mine = allLots.filter(l => l.country === t.country && t.arrive - 60 <= l.ts && l.ts <= end + 60);
      const mug = mugs.filter(([ts]) => t.arrive - 60 <= ts && ts <= end + 60).reduce((a, [, m]) => a + m, 0);
      const itemsProfit = sum(mine, l => l.profit + l.pending_gain + l.gift_gain);
      tripRows.push({ out: t.out, country: place(t.country), flight_h: round2(t.flight_s / 3600),
        stay_min: t.leave ? Math.round((end - t.arrive) / 60) : null, home: t.home,
        bought: mine.map(l => ({ item: names[l.item] || String(l.item), qty: l.qty })),
        spent: sum(mine, l => l.cost), proceeds: sum(mine, l => l.proceeds), pending: sum(mine, l => l.pending),
        kept: sum(mine, l => l.kept), kept_gain: sum(mine, l => l.kept_gain), gifted: sum(mine, l => l.gifted),
        gift_value: sum(mine, l => l.gift_value), items_profit: itemsProfit, mugs: mug, total: itemsProfit + mug });
    }

    const items = new Map();
    for (const l of allLots) {
      if (!items.has(l.item)) items.set(l.item, { bought: 0, cost: 0, sold: 0, proceeds: 0, profit: 0, unsold: 0, pending: 0,
        pending_gain: 0, kept: 0, kept_gain: 0, gifted: 0, gift_value: 0, gift_gain: 0, gift_channels: new Map(),
        countries: new Set(), channels: new Map() });
      const it = items.get(l.item);
      for (const k of ["bought", "cost", "sold", "proceeds", "profit", "unsold", "pending", "pending_gain", "kept",
        "kept_gain", "gifted", "gift_value", "gift_gain"]) it[k] += k === "bought" ? l.qty : l[k];
      for (const [ch, v] of l.gift_channels) add(it.gift_channels, ch, v);
      it.countries.add(place(l.country));
      for (const [ch, v] of l.channels) add(it.channels, ch, v);
    }
    const itemRows = [];
    for (const [item, it] of items) {
      const costEach = it.bought ? it.cost / it.bought : 0;
      const soldEach = it.sold ? it.proceeds / it.sold : null;
      itemRows.push({ item: names[item] || String(item), id: item, countries: [...it.countries].sort(),
        bought: it.bought, cost: it.cost, cost_each: costEach, sold: it.sold, proceeds: it.proceeds, sold_each: soldEach,
        margin_each: soldEach != null ? soldEach - costEach : null, profit: it.profit, pending: it.pending,
        pending_gain: it.pending_gain, kept: it.kept, kept_gain: it.kept_gain, gifted: it.gifted,
        gift_value: it.gift_value, gift_gain: it.gift_gain, gives_to: top(it.gift_channels),
        total: it.profit + it.pending_gain + it.kept_gain + it.gift_gain, sells_to: top(it.channels),
        sale_each: sale[item] ?? null, price_now: price[item] ?? null });
    }
    itemRows.sort((a, b) => b.total - a.total);

    const byC = new Map();
    for (const t of tripRows) {
      if (!byC.has(t.country)) byC.set(t.country, { trips: 0, flight_h: 0, spent: 0, items_profit: 0, mugs: 0 });
      const c = byC.get(t.country);
      c.trips += 1; c.flight_h += t.flight_h; c.spent += t.spent; c.items_profit += t.items_profit; c.mugs += t.mugs;
    }
    const countryRows = [...byC].map(([k, v]) => ({ country: k, ...v, total: v.items_profit + v.mugs,
      per_trip: (v.items_profit + v.mugs) / v.trips, per_flight_h: v.flight_h ? (v.items_profit + v.mugs) / v.flight_h : null }));
    countryRows.sort((a, b) => b.total - a.total);

    const chans = new Map(), gifts = new Map();
    for (const l of allLots) {
      for (const [ch, v] of l.channels) add(chans, ch, v);
      for (const [ch, v] of l.gift_channels) add(gifts, ch, v);
    }
    const fees = sum(of(logs, FEES).filter(r => r.ts >= lo), r => num((r.d || {}).cost));
    const realised = sum(allLots, l => l.profit), pendingGain = sum(allLots, l => l.pending_gain);
    const flightH = sum(tripRows, t => t.flight_h), mugTotal = sum(tripRows, t => t.mugs);
    const giftGain = sum(allLots, l => l.gift_gain);
    const earned = realised + pendingGain + giftGain + mugTotal - fees;  // kept items are shown apart
    return {
      days, generated_at: now,
      totals: { trips: tripRows.length, flight_h: Math.round(flightH * 10) / 10, spent: sum(allLots, l => l.cost),
        proceeds: sum(allLots, l => l.proceeds), realised, pending: sum(allLots, l => l.pending), pending_gain: pendingGain,
        pending_value: sum(allLots.filter(l => l.pending), l => l.held), kept: sum(allLots, l => l.kept),
        kept_value: sum(allLots, l => l.kept_value), kept_gain: sum(allLots, l => l.kept_gain),
        gifted: sum(allLots, l => l.gifted), gift_value: sum(allLots, l => l.gift_value),
        gift_cost: sum(allLots, l => l.gift_value - l.gift_gain), gift_gain: giftGain, mugs: mugTotal, fees, total: earned,
        per_trip: tripRows.length ? earned / tripRows.length : null, per_flight_h: flightH ? earned / flightH : null },
      trips: tripRows.sort((a, b) => b.out - a.out).slice(0, 40),
      items: itemRows.slice(0, 40),
      countries: countryRows,
      channels: [...[...chans].map(([k, v]) => ({ channel: k, proceeds: v, gift: false })),
        ...[...gifts].map(([k, v]) => ({ channel: `To ${k}`, proceeds: v, gift: true }))].sort((a, b) => b.proceeds - a.proceeds),
    };
  }

  const api = { LOG_TYPES, COUNTRIES, SALES, lines, channel, lots, trips, lastSaleEach, report };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TravelCore = api;
})(typeof self !== "undefined" ? self : this);
