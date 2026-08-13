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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------- validation */

const MAX_PCT = 100;
const nonNeg = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* The browser validates too, but never trust the client: a document arriving
   here is re-clamped so nothing negative can reach the database. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;

  const client = raw.client && typeof raw.client === 'object' ? raw.client : {};
  const str = (v, max) => String(v ?? '').trim().slice(0, max);

  return {
    id,
    type: raw.type === 'invoice' ? 'invoice' : 'quotation',
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

/* ----------------------------------------------------------------- startup */

async function start() {
  const connected = await db.ready();
  const s = db.status();

  app.listen(PORT, () => {
    console.log(`VedryxTech Quotations  →  http://localhost:${PORT}`);
    if (connected) {
      console.log(`MongoDB connected      →  ${s.uri} (db "${s.db}", collection "${s.collection}")`);
    } else {
      console.warn(`MongoDB unavailable    →  ${s.uri}`);
      console.warn(`  ${s.error}`);
      console.warn('  The app will run against browser local storage until Mongo is reachable.');
    }
  });
}

if (require.main === module) start();

module.exports = { app, sanitize, start };
