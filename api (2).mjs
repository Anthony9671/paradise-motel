import crypto from 'node:crypto';

/* Paradise Motel API — per-record storage.
   Each room/request/payment is its own blob key, so fast
   consecutive saves never overwrite each other. Zero deps. */

const STORE = 'paradise-motel';
const SECRET = process.env.SESSION_SECRET || 'paradise-default-secret-change-me';
const STAFF_PASS = process.env.STAFF_PASSWORD || '2018';
const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days, survives refreshes

function ctx() {
  const raw = process.env.NETLIFY_BLOBS_CONTEXT;
  if (raw) { try { const c = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); if (c && c.token) return c; } catch {} }
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return { siteID, token, apiURL: 'https://api.netlify.com' };
  return null;
}
function urlsFor(c, key) {
  const site = c.siteID || process.env.SITE_ID || '';
  const out = [];
  if (c.edgeURL) { out.push(`${c.edgeURL}/${site}/${STORE}/${encodeURIComponent(key)}`); out.push(`${c.edgeURL}/${site}/site:${STORE}/${encodeURIComponent(key)}`); }
  if (c.apiURL) out.push(`${c.apiURL}/api/v1/blobs/${site}/${STORE}/${encodeURIComponent(key)}`);
  if (!c.edgeURL && !c.apiURL) out.push(`https://api.netlify.com/api/v1/blobs/${site}/${STORE}/${encodeURIComponent(key)}`);
  return out;
}
async function blobGet(key) {
  const c = ctx(); if (!c) throw new Error('NO_STORAGE_CREDENTIALS');
  let last = 0;
  for (const url of urlsFor(c, key)) {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${c.token}` } });
      if (res.status === 404) return null;
      if (res.ok) { const t = await res.text(); if (!t) return null; try { return JSON.parse(t); } catch { return null; } }
      last = res.status;
    } catch { last = -1; }
  }
  throw new Error('STORAGE_READ_FAILED_' + last);
}
async function blobSet(key, value) {
  const c = ctx(); if (!c) throw new Error('NO_STORAGE_CREDENTIALS');
  let last = 0;
  for (const url of urlsFor(c, key)) {
    try {
      const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
      if (res.ok) return true;
      last = res.status;
    } catch { last = -1; }
  }
  throw new Error('STORAGE_WRITE_FAILED_' + last);
}
async function blobDelete(key) {
  const c = ctx(); if (!c) return;
  for (const url of urlsFor(c, key)) {
    try { const res = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${c.token}` } }); if (res.ok || res.status === 404) return; } catch {}
  }
}

const K = {
  room: n => 'room:' + n, fix: id => 'fix:' + id, pay: id => 'pay:' + id,
  settings: 'settings', roomIdx: 'idx:rooms', fixIdx: 'idx:fix', payIdx: 'idx:pays'
};
const DEFAULT_SETTINGS = { zelle: '', cashapp: '', venmo: '', card: 'Pay at the front desk', cash: 'Front desk' };

async function blobList(prefix) {
  const c = ctx(); if (!c) return null;
  const site = c.siteID || process.env.SITE_ID || '';
  const bases = [];
  if (c.edgeURL) bases.push(`${c.edgeURL}/${site}/${STORE}`);
  if (c.apiURL) bases.push(`${c.apiURL}/api/v1/blobs/${site}/${STORE}`);
  if (!bases.length) bases.push(`https://api.netlify.com/api/v1/blobs/${site}/${STORE}`);
  for (const base of bases) {
    try {
      const res = await fetch(`${base}?prefix=${encodeURIComponent(prefix)}`, { headers: { authorization: `Bearer ${c.token}` } });
      if (res.ok) {
        const data = await res.json();
        const blobs = data.blobs || data.keys || [];
        return blobs.map(b => (typeof b === 'string' ? b : b.key)).filter(Boolean);
      }
    } catch {}
  }
  return null; // list not available in this environment
}

async function indexAdd(indexKey, id) {
  // Re-read right before writing to minimize the race window, and
  // retry a couple times if a concurrent write slipped in.
  for (let attempt = 0; attempt < 3; attempt++) {
    const idx = (await blobGet(indexKey)) || [];
    if (idx.includes(id)) return;
    idx.push(id);
    await blobSet(indexKey, idx);
    const check = (await blobGet(indexKey)) || [];
    if (check.includes(id)) return; // landed
  }
}
async function indexRemove(indexKey, id) {
  const idx = (await blobGet(indexKey)) || [];
  const next = idx.filter(x => x !== id);
  if (next.length !== idx.length) await blobSet(indexKey, next);
}
async function readByIndex(indexKey, keyFn, prefix) {
  // Prefer the real blob list (collision-proof). Fall back to the
  // maintained index if list isn't supported in this environment.
  let keys = await blobList(prefix);
  let ids = null;
  if (keys && keys.length) {
    ids = keys.map(k => k.slice(prefix.length));
  } else {
    ids = (await blobGet(indexKey)) || [];
  }
  const items = await Promise.all(ids.map(id => blobGet(keyFn(id)).catch(() => null)));
  return items.filter(Boolean);
}
async function getRooms() { return readByIndex(K.roomIdx, K.room, 'room:'); }
async function getFix() { return readByIndex(K.fixIdx, K.fix, 'fix:'); }
async function getPays() { return readByIndex(K.payIdx, K.pay, 'pay:'); }
async function getSettings() { return { ...DEFAULT_SETTINGS, ...((await blobGet(K.settings)) || {}) }; }

function sign(pl) {
  const body = Buffer.from(JSON.stringify(pl)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(t) {
  if (!t || !t.includes('.')) return null;
  const [body, mac] = t.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try { const pl = JSON.parse(Buffer.from(body, 'base64url').toString()); return Date.now() > pl.exp ? null : pl; } catch { return null; }
}

const isoD = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function parseD(s) { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addCycle(iso, cycle) {
  const d = parseD(iso) || new Date();
  if (cycle === 'daily') d.setDate(d.getDate() + 1);
  else if (cycle === 'weekly') d.setDate(d.getDate() + 7);
  else if (cycle === 'biweekly') d.setDate(d.getDate() + 14);
  else { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); }
  return isoD(d);
}
const uid = () => crypto.randomBytes(8).toString('hex');
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const publicRoom = ({ pin, ...rest }) => rest;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let p;
  try { p = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const { action, token } = p;
  const s = verify(token);
  const isStaff = s?.kind === 'staff';
  const guestRoom = s?.kind === 'guest' ? s.room : null;

  try {
    if (action === 'health') {
      const c = ctx(); let storage = 'not tested';
      if (c) { try { await blobGet('__health'); storage = 'working'; } catch (e) { storage = 'FAILED: ' + e.message; } }
      return json({ functionRunning: true, credentialsFound: !!c, storage, staffPasswordFromEnv: !!process.env.STAFF_PASSWORD, sessionSecretFromEnv: !!process.env.SESSION_SECRET });
    }
    if (action === 'staffLogin') {
      const given = String(p.password || '');
      const a = Buffer.from(given.padEnd(64).slice(0, 64)); const b = Buffer.from(String(STAFF_PASS).padEnd(64).slice(0, 64));
      if (!crypto.timingSafeEqual(a, b)) return json({ error: 'Wrong password' }, 401);
      return json({ token: sign({ kind: 'staff', exp: Date.now() + TTL }) });
    }
    if (action === 'guestLogin') {
      const r = await blobGet(K.room(String(p.room || '').trim()));
      if (!r || !r.occupied || !r.pin || String(r.pin) !== String(p.pin || '').trim()) return json({ error: 'That room number and PIN don\u2019t match' }, 401);
      return json({ token: sign({ kind: 'guest', room: String(r.number), exp: Date.now() + TTL }) });
    }
    if (action === 'guestData') {
      if (!guestRoom) return json({ error: 'Sign in again' }, 401);
      const [r, fix, settings] = await Promise.all([blobGet(K.room(guestRoom)), getFix(), getSettings()]);
      if (!r) return json({ error: 'Room not found' }, 404);
      return json({ room: publicRoom(r), requests: fix.filter(f => f.room === guestRoom).map(f => ({ type: f.type, status: f.status, at: f.at })).sort((a, b) => b.at - a.at), settings });
    }
    if (action === 'declarePayment') {
      if (!guestRoom) return json({ error: 'Sign in again' }, 401);
      const method = String(p.method || '').slice(0, 40); if (!method) return json({ error: 'Pick a payment method' }, 400);
      const id = uid();
      await blobSet(K.pay(id), { id, room: guestRoom, method, note: String(p.note || '').slice(0, 500), at: Date.now(), confirmed: false });
      await indexAdd(K.payIdx, id);
      return json({ ok: true });
    }
    if (action === 'submitRequest') {
      if (!guestRoom) return json({ error: 'Sign in again' }, 401);
      const note = String(p.note || '').trim().slice(0, 1000); if (!note) return json({ error: 'Add a short description' }, 400);
      const id = uid();
      await blobSet(K.fix(id), { id, room: guestRoom, type: String(p.type || 'Something else').slice(0, 60), urgent: !!p.urgent, note, at: Date.now(), status: 'new' });
      await indexAdd(K.fixIdx, id);
      return json({ ok: true });
    }

    if (!isStaff) return json({ error: 'Sign in again' }, 401);

    if (action === 'load') {
      const [rooms, fix, pays, settings] = await Promise.all([getRooms(), getFix(), getPays(), getSettings()]);
      return json({ rooms: rooms.map(r => ({ ...publicRoom(r), hasPin: !!r.pin })), fix, pays, settings });
    }
    if (action === 'saveRoom') {
      const d = p.room || {}; const num = String(d.number || '').trim();
      if (!num) return json({ error: 'Room number is required' }, 400);
      const existing = await blobGet(K.room(num));
      if (p.isNew && existing) return json({ error: 'Room ' + num + ' already exists' }, 409);
      const occ = !!d.occupied;
      const rec = {
        number: num, occupied: occ,
        guest: occ ? String(d.guest || '') : '', phone: occ ? String(d.phone || '') : '',
        email: occ ? String(d.email || '') : '', rate: occ ? String(d.rate || '') : '',
        cycle: occ ? (d.cycle || 'weekly') : 'weekly', dueDate: occ ? (d.dueDate || '') : '',
        paidThru: occ ? (d.paidThru || '') : '', checkout: occ ? (d.checkout || '') : '',
        notes: occ ? String(d.notes || '') : '',
        pin: occ ? (String(d.pin || '').trim() || (existing ? existing.pin : '')) : ''
      };
      await blobSet(K.room(num), rec);
      await indexAdd(K.roomIdx, num);
      return json({ ok: true });
    }
    if (action === 'deleteRoom') {
      const num = String(p.number);
      await blobDelete(K.room(num)); await indexRemove(K.roomIdx, num);
      return json({ ok: true });
    }
    if (action === 'markPaid') {
      const r = await blobGet(K.room(String(p.number)));
      if (!r) return json({ error: 'Room not found' }, 404);
      r.paidThru = addCycle(r.paidThru || r.dueDate, r.cycle); r.dueDate = addCycle(r.dueDate, r.cycle);
      await blobSet(K.room(r.number), r);
      const pays = await getPays();
      await Promise.all(pays.filter(x => x.room === String(p.number) && !x.confirmed).map(x => { x.confirmed = true; return blobSet(K.pay(x.id), x); }));
      return json({ ok: true, paidThru: r.paidThru, dueDate: r.dueDate });
    }
    if (action === 'addFix') {
      const id = uid();
      await blobSet(K.fix(id), { id, room: String(p.room), type: String(p.type || 'Something else').slice(0, 60), urgent: !!p.urgent, note: String(p.note || '').slice(0, 1000), at: Date.now(), status: 'new' });
      await indexAdd(K.fixIdx, id);
      return json({ ok: true });
    }
    if (action === 'setFixStatus') {
      const f = await blobGet(K.fix(p.id)); if (!f) return json({ error: 'Request not found' }, 404);
      if (['new', 'working', 'done'].includes(p.status)) f.status = p.status;
      await blobSet(K.fix(p.id), f);
      return json({ ok: true });
    }
    if (action === 'deleteFix') {
      await blobDelete(K.fix(p.id)); await indexRemove(K.fixIdx, p.id);
      return json({ ok: true });
    }
    if (action === 'addPay') {
      const id = uid();
      await blobSet(K.pay(id), { id, room: String(p.room), method: String(p.method || '').slice(0, 40), note: String(p.note || '').slice(0, 500), at: Date.now(), confirmed: !!p.confirmed });
      await indexAdd(K.payIdx, id);
      if (p.confirmed) { const r = await blobGet(K.room(String(p.room))); if (r) { r.paidThru = addCycle(r.paidThru || r.dueDate, r.cycle); r.dueDate = addCycle(r.dueDate, r.cycle); await blobSet(K.room(r.number), r); } }
      return json({ ok: true });
    }
    if (action === 'confirmPay') {
      const x = await blobGet(K.pay(p.id)); if (!x) return json({ error: 'Payment not found' }, 404);
      x.confirmed = true; await blobSet(K.pay(p.id), x);
      const r = await blobGet(K.room(x.room)); if (r) { r.paidThru = addCycle(r.paidThru || r.dueDate, r.cycle); r.dueDate = addCycle(r.dueDate, r.cycle); await blobSet(K.room(r.number), r); }
      return json({ ok: true });
    }
    if (action === 'deletePay') {
      await blobDelete(K.pay(p.id)); await indexRemove(K.payIdx, p.id);
      return json({ ok: true });
    }
    if (action === 'saveSettings') {
      const st = p.settings || {};
      await blobSet(K.settings, { zelle: String(st.zelle || '').slice(0, 120), cashapp: String(st.cashapp || '').slice(0, 120), venmo: String(st.venmo || '').slice(0, 120), card: String(st.card || '').slice(0, 200), cash: String(st.cash || '').slice(0, 200) });
      return json({ ok: true });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    const m = String(err.message || err);
    if (m === 'NO_STORAGE_CREDENTIALS') return json({ error: 'Storage credentials missing on this site' }, 500);
    return json({ error: 'Server error: ' + m }, 500);
  }
};

export const config = { path: '/api' };
