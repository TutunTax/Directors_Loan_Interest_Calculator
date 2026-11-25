/* ===== Director Loan Interest — calculation engine (no DOM, testable in Node) ===== */
const Engine = (() => {
  // ---------- date helpers (ISO yyyy-mm-dd, whole days, UTC) ----------
  const dnum = iso => { const p = iso.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); };
  const iso = n => new Date(n * 86400000).toISOString().slice(0, 10);
  const eom = isoDate => { const p = isoDate.split('-'); return iso(Math.round(Date.UTC(+p[0], +p[1], 0) / 86400000)); };
  const som = isoDate => isoDate.slice(0, 7) + '-01';
  const addDays = (isoDate, n) => iso(dnum(isoDate) + n);
  const ym = isoDate => isoDate.slice(0, 7);
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const MONLONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dmy = isoDate => isoDate.slice(8, 10) + '/' + isoDate.slice(5, 7) + '/' + isoDate.slice(0, 4);
  const dm = isoDate => isoDate.slice(8, 10) + '/' + isoDate.slice(5, 7);
  const round2 = x => Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
  const keyOf = name => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const pct = r => { let s = r.toFixed(2); if (Math.abs(r * 100 - Math.round(r * 100)) > 1e-9) s = String(+r.toFixed(4)); return s + '%'; };

  // ---------- Sage "Account Transactions Report" parser ----------
  const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/ /g, ' ');
  const strip = s => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const num = s => { s = String(s || '').replace(/[\s ,]/g, ''); if (!s) return 0; const neg = /^\(.*\)$/.test(s); const v = parseFloat(s.replace(/[()]/g, '')); return isNaN(v) ? 0 : (neg ? -v : v); };
  const parseDmy = s => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };

  function parseSageHtml(html) {
    const company = (() => { const m = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(html); return m ? strip(m[1]) : ''; })();
    const filterAcct = (() => { const m = /Account:<\/span>[\s\S]*?<span>([\s\S]*?)<\/span>/i.exec(html); return m ? strip(m[1]) : ''; })();
    const start = html.search(/<\/thead>/i);
    const body = start >= 0 ? html.slice(start) : html;
    const accounts = []; let cur = null;
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let tr;
    while ((tr = trRe.exec(body))) {
      const cells = []; const tdRe = /<td([^>]*)>([\s\S]*?)<\/td>/gi; let td;
      while ((td = tdRe.exec(tr[1]))) cells.push({ text: strip(td[2]), span: +((/colspan="?(\d+)/i.exec(td[1]) || [0, 1])[1]) });
      if (!cells.length) continue;
      const t0 = cells[0].text;
      if (cells.length === 1 && cells[0].span >= 6 && !/^(Opening|Closing|Movement)/i.test(t0)) { cur = { name: t0, rangeTo: null, opening: 0, openingDate: null, rows: [] }; accounts.push(cur); continue; }
      if (/^Opening Balance as at/i.test(t0)) {
        if (!cur) { cur = { name: filterAcct, rangeTo: null, opening: 0, openingDate: null, rows: [] }; accounts.push(cur); }
        const c = cells.slice(1).map(x => x.text); cur.opening = num(c[c.length - 2]) - num(c[0]) ; cur.openingDate = parseDmy((t0.split(':')[1] || '')); continue;
      }
      if (/^Closing Balance as at/i.test(t0)) { if (cur) cur.rangeTo = parseDmy(t0.split(':')[1] || ''); continue; }
      if (/^Movement/i.test(t0)) continue;
      const d = cells.length >= 8 ? parseDmy(t0) : null;
      if (d) {
        if (!cur) { cur = { name: filterAcct, rangeTo: null, opening: 0, openingDate: null, rows: [] }; accounts.push(cur); }
        cur.rows.push({ date: d, entity: cells[1].text, ref: cells[2].text, type: cells[3].text, desc: cells[4].text, debit: num(cells[5].text), credit: num(cells[6].text), bal: num(cells[7].text), hasBal: cells[7].text !== '' });
      }
    }
    accounts.forEach(a => { a.name = a.name.replace(/\s+/g, ' ').trim() || filterAcct; a.company = company; });
    return accounts.filter(a => a.rows.length || a.name);
  }

  function parseCsv(text, fallbackName) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) { const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c; }
    if (f || row.length) { row.push(f); rows.push(row); }
    const hi = rows.findIndex(r => r.some(x => /^debit$/i.test(x.trim())) && r.some(x => /^credit$/i.test(x.trim())));
    if (hi < 0) return [];
    const h = rows[hi].map(x => x.trim().toLowerCase());
    const ix = n => h.findIndex(x => x.includes(n));
    const iD = ix('date'), iR = ix('reference'), iT = ix('type'), iDe = ix('description'), iDb = h.indexOf('debit'), iCr = h.indexOf('credit'), iB = ix('balance'), iE = ix('customer');
    const out = []; rows.slice(hi + 1).forEach(r => { let d = parseDmy(r[iD] || ''); if (!d && /^\d{4}-\d{2}-\d{2}$/.test((r[iD] || '').trim())) d = r[iD].trim(); if (d) out.push({ date: d, entity: r[iE] || '', ref: r[iR] || '', type: r[iT] || '', desc: r[iDe] || '', debit: num(r[iDb]), credit: num(r[iCr]), bal: num(r[iB]), hasBal: (r[iB] || '') !== '' }); });
    return [{ name: fallbackName || 'Account', company: '', opening: 0, rangeTo: null, rows: out }];
  }

  // ---------- interest-line detection & ledger checks ----------
  const INT_DESC = /\bint[er]{1,4}st\b/i, INT_REF = /^i?int/i;
  const isInterestRow = r => /journal/i.test(r.type) && (INT_REF.test(r.ref) || INT_DESC.test(r.desc));
  function prepareAccount(a) {
    let run = a.opening, mismatches = 0, firstBad = null;
    a.rows.forEach((r, i) => { r.idx = i; r.net = round2(r.credit - r.debit); r.isInterest = isInterestRow(r); run = round2(run + r.net); if (r.hasBal && Math.abs(run - r.bal) > 0.011) { mismatches++; if (!firstBad) firstBad = r; } });
    a.balanceMismatches = mismatches; a.firstMismatch = firstBad;
    a.closing = run;
    return a;
  }

  // ---------- rates ----------
  function primeOn(day, prime) { let v = null, f = ''; for (const p of prime) if (p.from <= day && p.from >= f) { v = p.rate; f = p.from; } return v; }
  function rateOn(day, cfg, prime) {
    let e = null; for (const r of (cfg.rates || [])) if (r.from <= day && (!e || r.from >= e.from)) e = r;
    if (!e) return null;
    if (e.basis === 'fixed') return +e.value;
    const p = primeOn(day, prime); return p == null ? null : p + (+e.value);
  }

  // ---------- interest for one period [from..to] inclusive ----------
  // Interest for day d is charged on the balance at the CLOSE of day d-1 (a payment/receipt dated t changes interest from t+1),
  // as in the practice's spreadsheets. Rows flagged `exclude` are ignored (the month's own interest journal).
  function computePeriod(acct, cfg, prime, from, to, extraRows, excludeFn) {
    const ev = []; acct.rows.concat(extraRows || []).forEach(r => { if (excludeFn && excludeFn(r)) return; ev.push([dnum(r.date), r.net]); });
    ev.sort((a, b) => a[0] - b[0]);
    let bal = acct.opening, p = 0;
    const segs = []; const warns = []; let sum = 0;
    for (let d = dnum(from); d <= dnum(to); d++) {
      while (p < ev.length && ev[p][0] <= d - 1) { bal = round2(bal + ev[p][1]); p++; }
      const day = iso(d); const rate = rateOn(day, cfg, prime);
      if (rate == null) { warns.push({ t: 'norate', day }); continue; }
      const useBal = bal > 0 ? bal : 0;
      if (bal < 0 && !warns.some(w => w.t === 'debit')) warns.push({ t: 'debit', day, bal });
      const amt = useBal * rate / 100 / 365;
      const last = segs[segs.length - 1];
      if (last && last.bal === useBal && last.rate === rate && last.toN === d - 1) { last.to = day; last.toN = d; last.days++; last.interest += amt; }
      else segs.push({ from: day, to: day, toN: d, days: 1, bal: useBal, rate, interest: amt });
      sum += amt;
    }
    return { from, to, segs, total: round2(sum), raw: sum, warns, days: dnum(to) - dnum(from) + 1 };
  }

  function rateText(segs) {
    const rs = []; segs.forEach(s => { if (!rs.length || rs[rs.length - 1].rate !== s.rate) rs.push({ rate: s.rate, from: s.from, to: s.to }); else rs[rs.length - 1].to = s.to; });
    if (rs.length === 1) return '@ ' + pct(rs[0].rate);
    return '@ ' + rs.map((r, i) => i === 0 ? `${pct(r.rate)} to ${dm(r.to)}` : (i === rs.length - 1 ? `${pct(r.rate)} from ${dm(r.from)}` : `${pct(r.rate)} ${dm(r.from)}-${dm(r.to)}`)).join(', ');
  }

  // ---------- month splitting ----------
  function monthsBetween(from, to) { // inclusive periods, calendar months
    const out = []; let s = from;
    while (s <= to) { const e = eom(s); const end = e < to ? e : to; out.push({ from: s, to: end, month: ym(s) }); s = addDays(end, 1); }
    return out;
  }

  function detectAccrued(acct) {
    const ints = acct.rows.filter(r => r.isInterest);
    if (!ints.length) return null;
    const last = ints.reduce((m, r) => r.date >= m.date ? r : m, ints[0]);
    return { date: eom(last.date), row: last };
  }

  // Build the run for one account: months not yet posted up to asAt.
  function planRun(acct, cfg, prime, asAt, opts) {
    opts = opts || {};
    const det = detectAccrued(acct);
    let through = opts.accruedThrough || (det ? det.date : null);
    let start;
    if (through) start = addDays(through, 1);
    else if (acct.rows.length) start = acct.rows[0].date; else start = som(asAt);
    const res = { detected: det, accruedThrough: through, start, months: [], blocked: null };
    if (!cfg || !(cfg.rates && cfg.rates.length)) { res.blocked = 'norates'; return res; }
    if (start > asAt) return res;
    const gen = [];
    monthsBetween(start, asAt).forEach(m => {
      const jdate = (opts.journalDates && opts.journalDates[m.month]) || m.to;
      const c = computePeriod(acct, cfg, prime, m.from, m.to, gen, null);
      const prefix = cfg.descPrefix || ('Interest Loan - ' + (cfg.label || acct.name));
      const [y, mo] = m.month.split('-');
      const desc = `${prefix} ${MONLONG[+mo - 1].slice(0, 3)} ${y} ${c.segs.length ? rateText(c.segs) : ''}`.trim();
      const row = { month: m.month, from: m.from, to: m.to, date: jdate, amount: c.total, segs: c.segs, warns: c.warns, desc, days: c.days };
      res.months.push(row);
      gen.push({ date: jdate, net: c.total, isInterest: true, generated: true });
    });
    return res;
  }

  // Posted vs calculated for already-posted months.
  function checkPosted(acct, cfg, prime, throughDate, nMonths) {
    const out = []; if (!throughDate || !cfg || !(cfg.rates && cfg.rates.length)) return out;
    const lastM = ym(throughDate); const first = (() => { const [y, m] = lastM.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - (nMonths - 1), 1)); return d.toISOString().slice(0, 7); })();
    for (let mo = first; mo <= lastM; mo = (() => { const [y, m] = mo.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); })()) {
      const from = mo + '-01', to = eom(from); if (to > throughDate) break;
      if (acct.rows.length && to < acct.rows[0].date) continue;
      const posted = round2(acct.rows.filter(r => r.isInterest && ym(r.date) === mo).reduce((s, r) => s + r.net, 0));
      const c = computePeriod(acct, cfg, prime, from, to, null, r => r.isInterest && ym(r.date) === mo);
      out.push({ month: mo, from, to, posted, calc: c.total, diff: round2(c.total - posted), warns: c.warns });
    }
    return out;
  }

  // ---------- statements ----------
  // lines: ledger rows + generated rows, sorted by date (stable), running balance recomputed.
  function buildStatement(acct, generated, from, to) {
    const all = acct.rows.map(r => ({ date: r.date, ref: r.ref, desc: r.desc, debit: r.debit, credit: r.credit, net: r.net, gen: false, pend: r.inSage === false, ord: r.idx }))
      .concat((generated || []).map((g, i) => ({ date: g.date, ref: g.ref, desc: g.desc, debit: g.amount < 0 ? -g.amount : 0, credit: g.amount > 0 ? g.amount : 0, net: g.amount, gen: true, ord: 1e9 + i })));
    all.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord);
    let bal = acct.opening, opening = acct.opening; const lines = [];
    let totD = 0, totC = 0;
    all.forEach(l => { if (l.date < from) { bal = round2(bal + l.net); opening = bal; return; } if (l.date > to) return; bal = round2(bal + l.net); lines.push({ ...l, bal }); totD += l.debit; totC += l.credit; });
    return { opening, lines, closing: bal, totD: round2(totD), totC: round2(totC) };
  }

  // ---------- Sage journal CSV (Sage Accounting journal-import layout) ----------
  // Sage "Journal Entries" import layout: one row per journal line.
  // Account = the account debited/credited; Affecting Account = the opposite side.
  function journalRows(months, settings) { // months: [{ref,date,desc,items:[{amount,desc,loanAcct}]}]
    const rows = [];
    months.forEach(j => j.items.forEach(it => {
      const a = Math.abs(it.amount).toFixed(2); const pos = it.amount >= 0;
      // positive: Dr interest expense / Cr loan account; negative (adjustment): reverse
      rows.push({ date: j.date, dc: pos ? 'Debit' : 'Credit', acct: settings.expenseAccount || '', ref: j.ref, desc: it.desc, vatType: 'No VAT', excl: a, vat: '0.00', total: a, aff: it.loanAcct || '' });
    }));
    return rows;
  }
  const csvEsc = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  function journalCsv(rows) {
    const head = ['Date', 'Debit/Credit', 'Account', 'Reference', 'Description', 'VAT Type', 'Exclusive', 'VAT', 'Total', 'Affecting Account', 'Comment', 'Analysis Code 1', 'Analysis Code 2', 'Analysis Code 3'];
    const lines = [head.join(',')];
    rows.forEach(r => lines.push([dmy(r.date), r.dc, r.acct, r.ref, r.desc, r.vatType, r.excl, r.vat, r.total, r.aff, '', '', '', ''].map(csvEsc).join(',')));
    return lines.join('\r\n') + '\r\n';
  }
  const journalRef = (prefix, month) => { const [y, m] = month.split('-'); return (prefix || 'INTJNL') + MON[+m - 1] + y; };

  return { dnum, iso, eom, som, addDays, ym, dmy, dm, round2, keyOf, pct, MON, MONLONG, parseSageHtml, parseCsv, prepareAccount, isInterestRow, primeOn, rateOn,
    computePeriod, rateText, monthsBetween, detectAccrued, planRun, checkPosted, buildStatement, journalRows, journalCsv, journalRef };
})();

