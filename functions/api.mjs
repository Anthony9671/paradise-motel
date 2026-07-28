import crypto from 'node:crypto';

/* =========================================================
   Paradise Motel API
   No npm packages. Talks to Netlify Blobs over plain HTTP
   using the credentials Netlify puts in the environment.
   This means it works on a drag-and-drop deploy, where no
   build runs and no dependencies get installed.
   ========================================================= */

const STORE = 'paradise-motel';
const SECRET = process.env.SESSION_SECRET || 'paradise-default-secret-change-me';
const STAFF_PASS = process.env.STAFF_PASSWORD || '2018';
const TTL = 12 * 60 * 60 * 1000;

/* ---------- credentials ---------- */
function ctx() {
  const raw = process.env.NETLIFY_BLOBS_CONTEXT;
  if (raw) {
    try {
      const c = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      if (c && c.token) return c;
    } catch {}
  }
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return { siteID, token, apiURL: 'https://api.netlify.com' };
  return null;
}

/* Netlify has used a few URL shapes across versions. Try each. */
function candidateURLs(c, key) {
  const site = c.siteID || process.env.SITE_ID || '';
  const out = [];
  if (c.edgeURL) {
    out.push(`${c.edgeURL}/${site}/${STORE}/${encodeURIComponent(key)}`);
    out.push(`${c.edgeURL}/${site}/site:${STORE}/${encodeURIComponent(key)}`);
  }
  if (c.apiURL) {
    out.push(`${c.apiURL}/api/v1/blobs/${site}/${STORE}/${encodeURIComponent(key)}`);
  }
  if (!c.edgeURL && !c.apiURL) {
    out.push(`https://api.netlify.com/api/v1/blobs/${site}/${STORE}/${encodeURIComponent(key)}`);
  }
  return out;
}

async function blobGet(key) {
  const c = ctx();
  if (!c) throw new Error('NO_STORAGE_CREDENTIALS');
  let lastStatus = 0;
  for (const url of candidateURLs(c, key)) {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${c.token}` } });
      if (res.status === 404) return null;                 // key absent — normal
      if (res.ok) {
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return null; }
      }
      lastStatus = res.status;
    } catch (e) { lastStatus = -1; }
  }
  throw new Error('STORAGE_READ_FAILED_' + lastStatus);
}

async function blobSet(key, value) {
  const c = ctx();
  if (!c) throw new Error('NO_STORAGE_CREDENTIALS');
  let lastStatus = 0;
  for (const url of candidateURLs(c, key)) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(value)
      });
      if (res.ok) return true;
      lastStatus = res.status;
    } catch (e) { lastStatus = -1; }
  }
  throw new Error('STORAGE_WRITE_FAILED_' + lastStatus);
}

const DEFAULT_SETTINGS = {
  zelle: '', cashapp: '', venmo: '',
  card: 'Pay at the front desk', cash: 'Front desk'
};

const read = async (k, fb) => (await blobGet(k)) ?? fb;
const write = (k, v) => blobSet(k, v);

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
    // Jan 31 + 1 month lands on Feb 28, not overflowing into March.
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
    /* ---- health check: open /api with {"action":"health"} to diagnose ---- */
    if (action === 'health') {
      const c = ctx();
      let storage = 'not tested';
      if (c) {
        try { await blobGet('__health'); storage = 'working'; }
        catch (e) { storage = 'FAILED: ' + e.message; }
      }
      return json({
        functionRunning: true,
        credentialsFound: !!c,
        credentialSource: c ? (c.edgeURL ? 'edge' : 'api') : 'none',
        storage,
        staffPasswordFromEnv: !!process.env.STAFF_PASSWORD,
        sessionSecretFromEnv: !!process.env.SESSION_SECRET
      });
    }

    /* ---- auth ---- */
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

    /* ---- guest ---- */
    if (action === 'guestData') {
      if (!guestRoom) return json({ error: 'Sign in again' }, 401);
      const [rooms, fix, settings] = await Promise.all([
        read('rooms', []), read('fix', []), read('settings', DEFAULT_SETTINGS)
      ]);
      const r = rooms.find(x => String(x.number) === guestRoom);
      if (!r) return json({ error: 'Room not found' }, 404);
      return json({
        room: publicRoom(r),
        requests: fix.filter(f => f.room === guestRoom)
          .map(f => ({ type: f.type, status: f.status, at: f.at }))
          .sort((a, b) => b.at - a.at),
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

    /* ---- staff ---- */
    if (!isStaff) return json({ error: 'Sign in again' }, 401);

    if (action === 'load') {
      const [rooms, fix, pays, settings] = await Promise.all([
        read('rooms', []), read('fix', []), read('pays', []), read('settings', DEFAULT_SETTINGS)
      ]);
      return json({
        rooms: rooms.map(r => ({ ...publicRoom(r), hasPin: !!r.pin })),
        fix, pays, settings: { ...DEFAULT_SETTINGS, ...settings }
      });
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
        guest: occ ? String(d.guest || '') : '',
        phone: occ ? String(d.phone || '') : '',
        email: occ ? String(d.email || '') : '',
        rate: occ ? String(d.rate || '') : '',
        cycle: occ ? (d.cycle || 'weekly') : 'weekly',
        dueDate: occ ? (d.dueDate || '') : '',
        paidThru: occ ? (d.paidThru || '') : '',
        checkout: occ ? (d.checkout || '') : '',
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
        if (r) {
          r.paidThru = addCycle(r.paidThru || r.dueDate, r.cycle);
          r.dueDate = addCycle(r.dueDate, r.cycle);
        }
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
      if (r) {
        r.paidThru = addCycle(r.paidThru || r.dueDate, r.cycle);
        r.dueDate = addCycle(r.dueDate, r.cycle);
      }
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
        zelle: String(st.zelle || '').slice(0, 120),
        cashapp: String(st.cashapp || '').slice(0, 120),
        venmo: String(st.venmo || '').slice(0, 120),
        card: String(st.card || '').slice(0, 200),
        cash: String(st.cash || '').slice(0, 200)
      });
      return json({ ok: true });
    }

    /* Replaces the whole dataset. Used to push a device's local
       records up once the server comes online. */
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
    const m = String(err.message || err);
    if (m === 'NO_STORAGE_CREDENTIALS') {
      return json({ error: 'Storage credentials missing on this site' }, 500);
    }
    return json({ error: 'Server error: ' + m }, 500);
  }
};

export const config = { path: '/api' };
