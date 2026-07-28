import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

/* =========================================================
   Paradise Motel API
   Deployed from Git, so @netlify/blobs installs during the
   build and getStore() works with no manual credentials.
   ========================================================= */

const store = () => getStore({ name: 'paradise-motel', consistency: 'strong' });

const SECRET = process.env.SESSION_SECRET || 'paradise-default-change-me';
const STAFF_PASS = process.env.STAFF_PASSWORD || '2018';
const TTL = 12 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  zelle: '', cashapp: '', venmo: '',
  card: 'Pay at the front desk', cash: 'Front desk'
};

async function read(key, fallback) {
  const v = await store().get(key, { type: 'json' });
  return v ?? fallback;
}
const write = (key, value) => store().setJSON(key, value);

/* ---------- tokens ---------- */
function sign(p) {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(t) {
  if (!t || !t.includes('.')) return null;
  const [body, mac] = t.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return Date.now() > p.exp ? null : p;
  } catch { return null; }
}

/* ---------- dates ---------- */
const isoD = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function parseD(s) { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addCycle(iso, cycle) {
  const d = parseD(iso) || new Date();
  if (cycle === 'daily') d.setDate(d.getDate() + 1);
  else if (cycle === 'weekly') d.setDate(d.getDate() + 7);
  else if (cycle === 'biweekly') d.setDate(d.getDate() + 14);
  else {
    const day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  return isoD(d);
}

const uid = () => crypto.randomBytes(8).toString('hex');
const json = (b, s = 200) => new Response(JSON.stringify(b), {
  status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
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
      let storage = 'not tested';
      try { await read('__health', null); storage = 'working'; }
      catch (e) { storage = 'FAILED: ' + e.message; }
      return json({
        functionRunning: true, storage,
        staffPasswordFromEnv: !!process.env.STAFF_PASSWORD,
        sessionSecretFromEnv: !!process.env.SESSION_SECRET
      });
    }

    if (action === 'staffLogin') {
      const given = String(p.password || '');
      const a = Buffer.from(given.padEnd(64).slice(0, 64));
      const b = Buffer.from(String(STAFF_PASS).padEnd(64).slice(0, 64));
      if (!crypto.timingSafeEqual(a, b)) return json({ error: 'Wrong password' }, 401);
      return json({ token: sign({ kind: 'staff', exp: Date.now() + TTL }) });
    }

    if (action === 'guestLogin') {
      const rooms = await read('rooms', []);
      const r = rooms.find(x => String(x.number) === String(p.room || '').trim());
      if (!r || !r.occupied || !r.pin || String(r.pin) !== String(p.pin || '').trim()) {
        return json({ error: 'That room number and PIN don\u2019t match' }, 401);
      }
      return json({ token: sign({ kind: 'guest', room: String(r.number), exp: Date.now() + TTL }) });
    }

    if (action === 'guestData') {
      if (!guestRoom) return json({ error: 'Sign in again' }, 401);
      const [rooms, fix, settings] = await Promise.all([read('rooms', []), read('fix', []), read('settings', DEFAULT_SETTINGS)]);
      const r = rooms.find(x => String(x.number) === guestRoom);
      if (!r) return json({ error: 'Room not found' }, 404);
      return json({
        room: publicRoom(r),
        requests: fix.filter(f => f.room === guestRoom).map(f => ({ type: f.type, status: f.status, at: f.at })).sort((a, b) => b.at - a.at),
        settings: { ...DEFAULT_SETTINGS, ...settings }
      });
    }

    if (action === 'declarePayment') {
      if (!guestRoom) return json({ error: 'Sign in again' }, 401);
      const method = String(p.method || '').slice(0, 40);
      if (!method) return json({ error: 'Pick a payment method' }, 400);
      const pays = await read('pays', []);
      pays.push({ id: uid(), room: guestRoom, method, note: String(p.note || '').slice(0, 500), at: Date.now(), confirmed: false });
      await write('pays', pays);
      return json({ ok: true });
    }

    if (action === 'submitRequest') {
      if (!guestRoom) return json({ error: 'Sign in again' }, 401);
      const note = String(p.note || '').trim().slice(0, 1000);
      if (!note) return json({ error: 'Add a short description' }, 400);
      const fix = await read('fix', []);
      fix.push({ id: uid(), room: guestRoom, type: String(p.type || 'Something else').slice(0, 60), urgent: !!p.urgent, note, at: Date.now(), status: 'new' });
      await write('fix', fix);
      return json({ ok: true });
    }

    if (!isStaff) return json({ error: 'Sign in again' }, 401);

    if (action === 'load') {
      const [rooms, fix, pays, settings] = await Promise.all([read('rooms', []), read('fix', []), read('pays', []), read('settings', DEFAULT_SETTINGS)]);
      return json({ rooms: rooms.map(r => ({ ...publicRoom(r), hasPin: !!r.pin })), fix, pays, settings: { ...DEFAULT_SETTINGS, ...settings } });
    }

    if (action === 'saveRoom') {
      const rooms = await read('rooms', []);
      const d = p.room || {};
      const num = String(d.number || '').trim();
      if (!num) return json({ error: 'Room number is required' }, 400);
      const i = rooms.findIndex(x => String(x.number) === num);
      if (p.isNew && i !== -1) return json({ error: 'Room ' + num + ' already exists' }, 409);
      const occ = !!d.occupied;
      rooms[i === -1 ? rooms.length : i] = {
        number: num, occupied: occ,
        guest: occ ? String(d.guest || '') : '', phone: occ ? String(d.phone || '') : '',
        email: occ ? String(d.email || '') : '', rate: occ ? String(d.rate || '') : '',
        cycle: occ ? (d.cycle || 'weekly') : 'weekly', dueDate: occ ? (d.dueDate || '') : '',
        paidThru: occ ? (d.paidThru || '') : '', checkout: occ ? (d.checkout || '') : '',
        notes: occ ? String(d.notes || '') : '',
        pin: occ ? (String(d.pin || '').trim() || (i !== -1 ? rooms[i].pin : '')) : ''
      };
      await write('rooms', rooms);
      return json({ ok: true });
    }

    if (action === 'deleteRoom') {
      await write('rooms', (await read('rooms', [])).filter(r => String(r.number) !== String(p.number)));
      return json({ ok: true });
    }

    if (action === 'markPaid') {
      const [rooms, pays] = await Promise.all([read('rooms', []), read('pays', [])]);
      const r = rooms.find(x => String(x.number) === String(p.number));
      if (!r) return json({ error: 'Room not found' }, 404);
      r.paidThru = addCycle(r.paidThru || r.dueDate, r.cycle);
      r.dueDate = addCycle(r.dueDate, r.cycle);
      pays.filter(x => x.room === String(p.number) && !x.confirmed).forEach(x => { x.confirmed = true; });
      await Promise.all([write('rooms', rooms), write('pays', pays)]);
      return json({ ok: true, paidThru: r.paidThru, dueDate: r.dueDate });
    }

    if (action === 'addFix') {
      const fix = await read('fix', []);
      fix.push({ id: uid(), room: String(p.room), type: String(p.type || 'Something else').slice(0, 60), urgent: !!p.urgent, note: String(p.note || '').slice(0, 1000), at: Date.now(), status: 'new' });
      await write('fix', fix);
      return json({ ok: true });
    }

    if (action === 'setFixStatus') {
      const fix = await read('fix', []);
      const f = fix.find(x => x.id === p.id);
      if (!f) return json({ error: 'Request not found' }, 404);
      if (['new', 'working', 'done'].includes(p.status)) f.status = p.status;
      await write('fix', fix);
      return json({ ok: true });
    }

    if (action === 'deleteFix') {
      await write('fix', (await read('fix', [])).filter(x => x.id !== p.id));
      return json({ ok: true });
    }

    if (action === 'addPay') {
      const [pays, rooms] = await Promise.all([read('pays', []), read('rooms', [])]);
      pays.push({ id: uid(), room: String(p.room), method: String(p.method || '').slice(0, 40), note: String(p.note || '').slice(0, 500), at: Date.now(), confirmed: !!p.confirmed });
      if (p.confirmed) {
        const r = rooms.find(x => String(x.number) === String(p.room));
        if (r) { r.paidThru = addCycle(r.paidThru || r.dueDate, r.cycle); r.dueDate = addCycle(r.dueDate, r.cycle); }
      }
      await Promise.all([write('pays', pays), write('rooms', rooms)]);
      return json({ ok: true });
    }

    if (action === 'confirmPay') {
      const [pays, rooms] = await Promise.all([read('pays', []), read('rooms', [])]);
      const x = pays.find(y => y.id === p.id);
      if (!x) return json({ error: 'Payment not found' }, 404);
      x.confirmed = true;
      const r = rooms.find(y => String(y.number) === x.room);
      if (r) { r.paidThru = addCycle(r.paidThru || r.dueDate, r.cycle); r.dueDate = addCycle(r.dueDate, r.cycle); }
      await Promise.all([write('pays', pays), write('rooms', rooms)]);
      return json({ ok: true });
    }

    if (action === 'deletePay') {
      await write('pays', (await read('pays', [])).filter(x => x.id !== p.id));
      return json({ ok: true });
    }

    if (action === 'saveSettings') {
      const st = p.settings || {};
      await write('settings', {
        zelle: String(st.zelle || '').slice(0, 120), cashapp: String(st.cashapp || '').slice(0, 120),
        venmo: String(st.venmo || '').slice(0, 120), card: String(st.card || '').slice(0, 200), cash: String(st.cash || '').slice(0, 200)
      });
      return json({ ok: true });
    }

    if (action === 'importAll') {
      const d = p.data || {};
      await Promise.all([
        write('rooms', Array.isArray(d.rooms) ? d.rooms : []),
        write('fix', Array.isArray(d.fix) ? d.fix : []),
        write('pays', Array.isArray(d.pays) ? d.pays : []),
        write('settings', d.settings || DEFAULT_SETTINGS)
      ]);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ error: 'Server error: ' + String(err.message || err) }, 500);
  }
};

export const config = { path: '/api' };
