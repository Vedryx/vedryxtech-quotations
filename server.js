/* VedryxTech Quotations — static host plus the documents API.
 *
 * Serves public/ and exposes /api/documents backed by MongoDB. If Mongo is
 * unreachable the server still starts and the API answers 503, which the browser
 * treats as "work offline against local storage". */
'use strict';

const path = require('path');
const express = require('express');
const db = require('./lib/db');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/* Letterheads carry rich-text HTML up to ~200 KB — the previous 1 MB cap was
   plenty, keep it generous. */
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------- validation */

const MAX_PCT = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const nonNeg = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const str = (v, max) => String(v ?? '').trim().slice(0, max);

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
      html: String(raw.html ?? '').slice(0, 200000),
      updatedAt: new Date().toISOString(),
    };
  }

  const client = raw.client && typeof raw.client === 'object' ? raw.client : {};

  return {
    id,
    type,
    number: str(raw.number, 40),
    status: raw.status === 'Sent' ? 'Sent' : 'Draft',
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
   identically in Gmail, Outlook and Apple Mail without a heavyweight template. */
function fmtMoney(currency, n) {
  const v = Number(n) || 0;
  return (currency || '$') + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function renderDocEmail(doc, currency = '$') {
  const t = totals(doc);
  const title = doc.type === 'invoice' ? 'Invoice' : 'Quotation';
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
  const currency = str(req.body?.currency, 4) || '$';

  const noun = doc.type === 'invoice' ? 'Invoice' : 'Quotation';
  const subject = `${noun} ${doc.number || ''} from Vedryx`.replace(/\s+/g, ' ').trim();
  const html = renderDocEmail(doc, currency);

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

module.exports = { app, sanitize, renderDocEmail, start };
