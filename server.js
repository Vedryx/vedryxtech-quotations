/* VedryxTech Quotations — static host plus the documents API.
 *
 * Serves webroot/ and exposes /api/documents backed by MongoDB. If Mongo is
 * unreachable the server still starts and the API answers 503, which the browser
 * treats as "work offline against local storage". */
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./lib/db');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/* -------------------------------------------------------------------- auth
 * Cookie-session login with a real login SCREEN (not a browser Basic-Auth
 * prompt). One shared credential (APP_USER/APP_PASSWORD) — internal tool, no
 * per-user accounts. On success we set a signed HMAC session cookie; every
 * route except the login endpoints is gated. Unauthenticated GETs that want
 * HTML get the login page; API calls get 401. Enabled whenever APP_PASSWORD is
 * set; if unset the app runs open and warns loudly at startup. */
const APP_USER = process.env.APP_USER || 'vedryx';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || (APP_PASSWORD ? `vq:${APP_PASSWORD}` : '');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SESSION_COOKIE = 'vq_session';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function signSession(expMs) {
  const payload = Buffer.from(JSON.stringify({ u: APP_USER, exp: expMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch { return false; }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/* Self-contained, theme-aware login screen — served for unauthenticated HTML
   requests. Inline everything so it never depends on a gated static asset. */
function loginPage() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + '<title>Sign in — VedryxTech</title><style>'
    + ':root{--bg:#F4F5F7;--card:#fff;--ink:#14171F;--muted:#8A9099;--line:#E8EBEF;--accent:#14171F;--field:#fff}'
    + '@media(prefers-color-scheme:dark){:root{--bg:#0d0f14;--card:#151922;--ink:#eef1f5;--muted:#8A9099;--line:#252b36;--accent:#eef1f5;--field:#0f1218}}'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + "font-family:Manrope,system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink);padding:20px}"
    + '.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:32px 28px;box-shadow:0 8px 30px rgba(0,0,0,.08)}'
    + '.brand{font-weight:800;font-size:13px;letter-spacing:.18em;color:var(--muted);margin-bottom:6px}'
    + '.brand b{color:var(--ink)}h1{margin:0 0 22px;font-size:22px;font-weight:800;letter-spacing:-.01em}'
    + 'label{display:block;font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--muted);margin:0 0 6px}'
    + 'input{width:100%;padding:11px 12px;font-size:14px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--ink);margin-bottom:16px}'
    + 'input:focus{outline:none;border-color:var(--accent)}'
    + 'button{width:100%;padding:12px;font-size:14px;font-weight:800;letter-spacing:.02em;border:0;border-radius:8px;background:var(--accent);color:var(--bg);cursor:pointer}'
    + 'button:disabled{opacity:.6;cursor:default}.err{min-height:18px;font-size:13px;color:#D64545;margin:2px 0 12px}'
    + '</style></head><body><form class="card" id="f">'
    + '<div class="brand">VEDRYX<b>TECH</b></div><h1>Sign in</h1>'
    + '<label for="u">Username</label><input id="u" name="u" autocomplete="username" autofocus>'
    + '<label for="p">Password</label><input id="p" name="p" type="password" autocomplete="current-password">'
    + '<div class="err" id="e"></div><button id="b" type="submit">Sign in</button></form><script>'
    + "var f=document.getElementById('f'),e=document.getElementById('e'),b=document.getElementById('b');"
    + "f.addEventListener('submit',function(ev){ev.preventDefault();e.textContent='';b.disabled=true;"
    + "fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},"
    + "body:JSON.stringify({user:document.getElementById('u').value,password:document.getElementById('p').value})})"
    + ".then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})"
    + ".then(function(x){if(x.ok){location.href='/'}else{e.textContent=(x.j&&x.j.error)||'Sign in failed.';b.disabled=false}})"
    + ".catch(function(){e.textContent='Network error.';b.disabled=false});});"
    + '</script></body></html>';
}

/* Body parser first so the login route can read req.body. */
app.use(express.json({ limit: '2mb' }));

/* Login / logout are always reachable (they are how you pass the gate). */
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true }); // open mode
  const user = String(req.body?.user ?? '');
  const pass = String(req.body?.password ?? '');
  if (safeEqual(user, APP_USER) && safeEqual(pass, APP_PASSWORD)) {
    res.cookie(SESSION_COOKIE, signSession(Date.now() + SESSION_TTL_MS), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Wrong username or password.' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* Gate everything else. */
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next(); // unprotected — start() warns
  if (verifySession(readCookie(req, SESSION_COOKIE))) return next();
  const wantsHtml = String(req.headers.accept || '').includes('text/html');
  if (req.method === 'GET' && wantsHtml) return res.status(200).type('html').send(loginPage());
  return res.status(401).json({ error: 'authentication required' });
});

app.use(express.static(path.join(__dirname, 'webroot')));

/* ------------------------------------------------------------- validation */

const MAX_PCT = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* Currencies the picker offers. ISO 4217 codes end-to-end (server, client,
   storage) so Intl.NumberFormat decides symbol + decimals per locale. Older
   documents without a currency field default to USD on read. */
const CURRENCIES = ['USD', 'INR', 'EUR', 'AED', 'GBP', 'JPY'];
const DEFAULT_CURRENCY = 'USD';
const coerceCurrency = (c) => (CURRENCIES.includes(String(c || '').toUpperCase())
  ? String(c).toUpperCase()
  : DEFAULT_CURRENCY);

const nonNeg = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/* Letterhead bodies are internally-authored rich text (contenteditable), so we
   keep formatting tags but strip anything executable. The whole-app auth gate is
   the primary defence against a hostile letter; this is defence-in-depth so a
   stored `<script>` / `onerror=` can never fire when the body is rendered via
   innerHTML on the letter screen. Not a general-purpose sanitizer — scoped to
   this one trusted-author field. */
function sanitizeLetterHtml(raw) {
  return String(raw ?? '')
    .slice(0, 200000)
    // drop dangerous elements and their contents
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    // drop the same as self-closing / unclosed tags
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, '')
    // strip inline event handlers: on*="..." / on*='...' / on*=bare
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    // neutralise javascript: in href/src
    .replace(/((?:href|src)\s*=\s*["']?)\s*javascript:[^"'>\s]*/gi, '$1#');
}

/* The browser validates too, but never trust the client: a document arriving
   here is re-clamped so nothing negative can reach the database. Each type
   has its own shape; unknown types are rejected. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;

  const type = raw.type === 'invoice' ? 'invoice'
             : raw.type === 'letter'  ? 'letter'
             : 'quotation';

  if (type === 'letter') {
    return {
      id,
      type,
      title: str(raw.title, 160) || 'Untitled letter',
      html: sanitizeLetterHtml(raw.html),
      updatedAt: new Date().toISOString(),
    };
  }

  const client = raw.client && typeof raw.client === 'object' ? raw.client : {};

  return {
    id,
    type,
    number: str(raw.number, 40),
    status: raw.status === 'Sent' ? 'Sent' : 'Draft',
    currency: coerceCurrency(raw.currency),
    issueDate: str(raw.issueDate, 10),
    validUntil: str(raw.validUntil, 10),
    client: {
      name: str(client.name, 120),
      contact: str(client.contact, 120),
      email: str(client.email, 160),
      phone: str(client.phone, 32),
      address: str(client.address, 400),
    },
    items: (Array.isArray(raw.items) ? raw.items : []).slice(0, 200).map((it, i) => ({
      id: Number.isFinite(Number(it?.id)) ? Number(it.id) : i + 1,
      service: str(it?.service, 120),
      description: str(it?.description, 400),
      qty: Math.min(nonNeg(it?.qty), 1e6),
      price: Math.min(nonNeg(it?.price), 1e9),
    })),
    discount: Math.min(nonNeg(raw.discount), MAX_PCT),
    taxRate: Math.min(nonNeg(raw.taxRate), MAX_PCT),
    notes: str(raw.notes, 2000),
    updatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------- API routes */

const offline = (res, err) =>
  res.status(503).json({ error: 'database unavailable', detail: err?.message ?? db.status().error });

app.get('/api/status', async (_req, res) => {
  await db.ready();
  res.json(db.status());
});

app.get('/api/documents', async (_req, res) => {
  try {
    res.json({ documents: await db.listDocuments() });
  } catch (err) {
    offline(res, err);
  }
});

app.put('/api/documents/:id', async (req, res) => {
  const doc = sanitize({ ...req.body, id: Number(req.params.id) });
  if (!doc) return res.status(400).json({ error: 'invalid document' });
  try {
    await db.upsertDocument(doc);
    res.json({ document: doc });
  } catch (err) {
    offline(res, err);
  }
});

/* Bulk push — used once on first connect to seed an empty database. */
app.put('/api/documents', async (req, res) => {
  const incoming = Array.isArray(req.body?.documents) ? req.body.documents : null;
  if (!incoming) return res.status(400).json({ error: 'expected { documents: [...] }' });
  const docs = incoming.map(sanitize).filter(Boolean);
  try {
    const written = await db.upsertMany(docs);
    res.json({ written, documents: docs });
  } catch (err) {
    offline(res, err);
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    const gone = await db.deleteDocument(Number(req.params.id));
    res.status(gone ? 204 : 404).end();
  } catch (err) {
    offline(res, err);
  }
});

/* ---------------------------------------------------------------- email */

/* Money format used by the plain-HTML email — kept minimal so it renders
   identically in Gmail, Outlook and Apple Mail without a heavyweight template.
   Symbol placement and decimal count come from Intl.NumberFormat so each
   currency looks right on its own (JPY has 0 decimals, AED prefixes "AED ",
   GBP prefixes £, etc). Locale is pinned to en-US so grouping is consistent
   across mail clients regardless of the recipient's system locale. */
function fmtMoney(code, n) {
  const v = Number(n) || 0;
  const currency = coerceCurrency(code);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v);
}

function totals(doc) {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const sub = items.reduce((a, it) => {
    const q = nonNeg(it.qty);
    const p = nonNeg(it.price);
    return a + (q > 0 ? q * p : p);
  }, 0);
  const disc = sub * Math.min(nonNeg(doc.discount), MAX_PCT) / 100;
  const tax = (sub - disc) * Math.min(nonNeg(doc.taxRate), MAX_PCT) / 100;
  return { sub, disc, tax, total: sub - disc + tax };
}

/* Escape untrusted strings before pasting them into an HTML template. */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function renderDocEmail(doc) {
  const t = totals(doc);
  const title = doc.type === 'invoice' ? 'Invoice' : 'Quotation';
  /* Doc is the source of truth for currency. sanitize() defaults to USD when
     absent so older docs (pre-currency-selector) still render cleanly. */
  const currency = coerceCurrency(doc?.currency);
  const rows = (doc.items || [])
    .filter((i) => (i.service || '').trim() || nonNeg(i.price) > 0)
    .map((it) => {
      const q = nonNeg(it.qty);
      const p = nonNeg(it.price);
      const amt = q > 0 ? q * p : p;
      const qtyLine = q > 1 ? `<div style="color:#7A818C;font-size:12px;margin-top:2px">${q} × ${fmtMoney(currency, p)}</div>` : '';
      const desc = it.description ? `<div style="color:#5B6270;font-size:12px;margin-top:2px">${esc(it.description)}</div>` : '';
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #EDF0F4;font-size:14px;color:#14171F">
            <div style="font-weight:700">${esc(it.service || 'Untitled service')}</div>
            ${desc}${qtyLine}
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #EDF0F4;font-size:14px;color:#14171F;text-align:right;white-space:nowrap;font-weight:700">
            ${fmtMoney(currency, amt)}
          </td>
        </tr>`;
    }).join('');

  const discRow = t.disc > 0 ? `
    <tr><td style="padding:4px 0;font-size:13px;color:#5B6270">Discount (${Math.min(nonNeg(doc.discount), MAX_PCT)}%)</td>
        <td style="padding:4px 0;font-size:13px;color:#14171F;text-align:right">−${fmtMoney(currency, t.disc)}</td></tr>` : '';

  const notes = doc.notes ? `
    <p style="margin:24px 0 0;font-size:11px;letter-spacing:.14em;color:#8A9099;font-weight:800">NOTES &amp; TERMS</p>
    <p style="margin:6px 0 0;font-size:13px;line-height:1.6;color:#5B6270;white-space:pre-line">${esc(doc.notes)}</p>` : '';

  return `<!doctype html>
<html><body style="margin:0;background:#F4F5F7;font-family:Manrope,system-ui,-apple-system,'Segoe UI',sans-serif;color:#14171F">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F7;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#fff;border:1px solid #E8EBEF;border-radius:8px;overflow:hidden">
        <tr><td style="height:6px;background:#14171F"></td></tr>
        <tr><td style="padding:28px 28px 8px">
          <div style="font-weight:800;font-size:13px;letter-spacing:.16em;color:#8A9099">VEDRYXTECH</div>
          <h1 style="margin:14px 0 4px;font-weight:800;font-size:30px;letter-spacing:-.02em">${title.toUpperCase()}</h1>
          <div style="font-weight:800;font-size:12px;letter-spacing:.16em;color:#8A9099">${esc(doc.number || '')}</div>
        </td></tr>
        <tr><td style="padding:14px 28px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:top;font-size:13px;color:#5B6270;padding-right:12px">
                <div style="font-weight:800;font-size:10.5px;letter-spacing:.14em;color:#8A9099">BILLED TO</div>
                <div style="font-weight:800;font-size:15px;color:#14171F;margin-top:6px">${esc(doc.client?.name || 'Client')}</div>
                <div style="margin-top:3px;line-height:1.6;white-space:pre-line">${esc([doc.client?.contact, doc.client?.email, doc.client?.phone, doc.client?.address].filter(Boolean).join('\n'))}</div>
              </td>
              <td style="vertical-align:top;text-align:right;font-size:13px;color:#5B6270">
                <div style="font-weight:800;font-size:10.5px;letter-spacing:.14em;color:#8A9099">DATE</div>
                <div style="font-weight:700;font-size:13px;color:#14171F;margin-top:6px">${esc(doc.issueDate || '')}</div>
                <div style="font-weight:800;font-size:10.5px;letter-spacing:.14em;color:#8A9099;margin-top:12px">${doc.type === 'invoice' ? 'DUE DATE' : 'VALID UNTIL'}</div>
                <div style="font-weight:700;font-size:13px;color:#14171F;margin-top:6px">${esc(doc.validUntil || '')}</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 28px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:2px solid #14171F">
            <tr>
              <td style="padding-bottom:8px;font-weight:800;font-size:11px;letter-spacing:.14em;color:#14171F">DESCRIPTION</td>
              <td style="padding-bottom:8px;font-weight:800;font-size:11px;letter-spacing:.14em;color:#14171F;text-align:right">AMOUNT</td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>
        <tr><td style="padding:14px 28px 0" align="right">
          <table role="presentation" width="280" cellpadding="0" cellspacing="0" style="max-width:280px">
            <tr><td style="padding:4px 0;font-size:13px;color:#5B6270">Sub-Total</td>
                <td style="padding:4px 0;font-size:13px;color:#14171F;text-align:right">${fmtMoney(currency, t.sub)}</td></tr>
            ${discRow}
            <tr><td style="padding:4px 0;font-size:13px;color:#5B6270">Tax (${Math.min(nonNeg(doc.taxRate), MAX_PCT)}%)</td>
                <td style="padding:4px 0;font-size:13px;color:#14171F;text-align:right">${fmtMoney(currency, t.tax)}</td></tr>
            <tr><td colspan="2" style="padding-top:10px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14171F">
                <tr>
                  <td style="padding:12px 14px;font-weight:800;font-size:12px;letter-spacing:.14em;color:#fff">TOTAL</td>
                  <td style="padding:12px 14px;font-weight:800;font-size:20px;letter-spacing:-.02em;color:#fff;text-align:right">${fmtMoney(currency, t.total)}</td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 28px 28px">${notes}</td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #EDF0F4;font-size:12px;color:#5B6270">
          Reply to this email if you have any questions. — VedryxTech
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/* Send the document as an email via Resend. Frontend calls this after a
   successful lock+commit. */
app.post('/api/documents/:id/send', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey === 'API_KEY_HERE') {
    return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  }

  let doc;
  try {
    doc = await db.getDocument(id);
  } catch (err) {
    return offline(res, err);
  }
  if (!doc) return res.status(404).json({ error: 'document not found' });
  if (doc.type === 'letter') return res.status(400).json({ error: 'letters cannot be emailed from this endpoint' });

  const override = str(req.body?.to, 160);
  const recipient = override || doc.client?.email || '';
  if (!EMAIL_RE.test(recipient)) {
    return res.status(400).json({ error: 'no valid recipient', detail: recipient || null });
  }

  const from = process.env.SALES_FROM || 'sales@team.vedryxtech.com';
  const cc = process.env.SALES_CC || 'we@vedryxtech.com';

  const noun = doc.type === 'invoice' ? 'Invoice' : 'Quotation';
  const subject = `${noun} ${doc.number || ''} from Vedryx`.replace(/\s+/g, ' ').trim();
  /* The doc carries its own currency (see sanitize()); the request body no
     longer overrides it — the sent email must match what was saved. */
  const html = renderDocEmail(doc);

  const payload = {
    from,
    to: [recipient],
    cc: cc ? [cc] : undefined,
    subject,
    html,
  };

  let resendRes;
  try {
    resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return res.status(502).json({ error: 'resend request failed', detail: err.message });
  }

  const bodyText = await resendRes.text();
  let body; try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText }; }

  if (!resendRes.ok) {
    return res.status(502).json({ error: 'resend rejected the request', status: resendRes.status, detail: body });
  }

  return res.json({ sent: true, to: recipient, cc: cc || null, id: body.id || null });
});

/* ----------------------------------------------------------------- startup */

async function start() {
  const connected = await db.ready();
  const s = db.status();

  app.listen(PORT, () => {
    console.log(`VedryxTech Quotations  →  http://localhost:${PORT}`);
    if (APP_PASSWORD) {
      console.log(`Access                 →  login screen ON (user "${APP_USER}")`);
    } else {
      console.warn('Access                 →  UNPROTECTED — set APP_PASSWORD to gate the app (open relay + XSS risk if public)');
    }
    if (connected) {
      const cols = Object.values(s.collections).join(', ');
      console.log(`MongoDB connected      →  ${s.uri} (db "${s.db}", collections: ${cols})`);
    } else {
      console.warn(`MongoDB unavailable    →  ${s.uri}`);
      console.warn(`  ${s.error}`);
      console.warn('  The app will run against browser local storage until Mongo is reachable.');
    }
  });
}

if (require.main === module) start();

module.exports = { app, sanitize, renderDocEmail, fmtMoney, CURRENCIES, DEFAULT_CURRENCY, start };
