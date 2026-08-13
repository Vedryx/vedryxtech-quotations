/* MongoDB access for VedryxTech Quotations.
 *
 * Connection details come from the environment so no credential is ever written
 * into source. Defaults point at a local mongod with no auth; swap MONGODB_URI
 * for the cluster string when it is issued.
 *
 * Each document type lives in its own collection — quotations, invoices and
 * letterheads have different shapes and lifecycles, and keeping them apart
 * makes ad-hoc queries and Atlas dashboards obvious. The type-to-collection
 * map is the single source of truth.
 *
 * The server stays up when Mongo is unreachable — every call reports failure
 * rather than throwing, and the browser falls back to local storage. */
'use strict';

const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'vedryxtech';

/* Type-to-collection map. The keys are the sanitized `doc.type` values used
   everywhere else; add a new type only after wiring it through sanitize(). */
const COLLECTIONS = {
  quotation: 'quotations',
  invoice:   'invoices',
  letter:    'letterheads',
};

let client = null;
let cols = null;                // { quotation, invoice, letter } handles once connected
let lastError = null;
let connecting = null;

/* Hide the password if a real cluster URI is in use. */
function redact(uri) {
  return String(uri).replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');
}

async function connect() {
  if (cols) return cols;
  if (connecting) return connecting;

  connecting = (async () => {
    const c = new MongoClient(URI, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
    });
    await c.connect();
    await c.db(DB_NAME).command({ ping: 1 });
    client = c;
    const db = c.db(DB_NAME);
    const handles = {};
    for (const [type, name] of Object.entries(COLLECTIONS)) {
      handles[type] = db.collection(name);
      await handles[type].createIndex({ id: 1 }, { unique: true });
    }
    cols = handles;
    lastError = null;
    return cols;
  })();

  try {
    return await connecting;
  } catch (err) {
    lastError = err;
    cols = null;
    if (client) { try { await client.close(); } catch { /* ignore */ } }
    client = null;
    throw err;
  } finally {
    connecting = null;
  }
}

/* Connect without throwing. Returns true when the collections are usable. */
async function ready() {
  try { await connect(); return true; } catch { return false; }
}

function status() {
  return {
    connected: !!cols,
    uri: redact(URI),
    db: DB_NAME,
    collections: { ...COLLECTIONS },
    error: lastError ? lastError.message : null,
  };
}

/* Route to the collection for a given doc type. Unknown types fall back to
   quotation so an older document without a `type` field still lands somewhere
   readable rather than throwing. */
function colFor(type) {
  if (!cols) throw new Error('db not connected');
  return cols[type] || cols.quotation;
}

/* Mongo's own _id is an implementation detail; the app keys on its numeric id. */
const strip = ({ _id, ...doc }) => doc;

async function listDocuments() {
  await connect();
  const buckets = await Promise.all(
    Object.values(cols).map((col) => col.find({}, { sort: { id: 1 } }).toArray()),
  );
  return buckets.flat().map(strip).sort((a, b) => Number(a.id) - Number(b.id));
}

async function getDocument(id) {
  await connect();
  for (const col of Object.values(cols)) {
    const found = await col.findOne({ id });
    if (found) return strip(found);
  }
  return null;
}

async function upsertDocument(doc) {
  await connect();
  const col = colFor(doc.type);
  await col.replaceOne({ id: doc.id }, doc, { upsert: true });
  return doc;
}

async function upsertMany(docs) {
  if (!docs.length) return 0;
  await connect();

  /* Group by type so each collection gets one bulkWrite. */
  const groups = new Map();
  for (const doc of docs) {
    const type = doc.type in COLLECTIONS ? doc.type : 'quotation';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(doc);
  }

  let written = 0;
  for (const [type, group] of groups) {
    const ops = group.map((doc) => ({
      replaceOne: { filter: { id: doc.id }, replacement: doc, upsert: true },
    }));
    const res = await colFor(type).bulkWrite(ops, { ordered: false });
    written += (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
  }
  return written;
}

async function deleteDocument(id) {
  await connect();
  /* The id is globally unique across types (see app.js — Date.now()), but the
     document could sit in any of the three collections, so try all. */
  const results = await Promise.all(
    Object.values(cols).map((col) => col.deleteOne({ id })),
  );
  return results.some((r) => r.deletedCount > 0);
}

async function close() {
  if (client) { try { await client.close(); } catch { /* ignore */ } }
  client = null;
  cols = null;
}

module.exports = {
  ready, status,
  listDocuments, getDocument, upsertDocument, upsertMany, deleteDocument, close,
  config: { uri: redact(URI), db: DB_NAME, collections: { ...COLLECTIONS } },
};
