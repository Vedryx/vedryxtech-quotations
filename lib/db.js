/* MongoDB access for VedryxTech Quotations.
 *
 * Connection details come from the environment so no credential is ever written
 * into source. Defaults point at a local mongod with no auth; swap MONGODB_URI
 * for the cluster string when it is issued.
 *
 * The server stays up when Mongo is unreachable — every call reports failure
 * rather than throwing, and the browser falls back to local storage. */
'use strict';

const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'vedryxtech';
const COLLECTION = process.env.MONGODB_COLLECTION || 'documents';

let client = null;
let collection = null;
let lastError = null;
let connecting = null;

/* Hide the password if a real cluster URI is in use. */
function redact(uri) {
  return String(uri).replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');
}

async function connect() {
  if (collection) return collection;
  if (connecting) return connecting;

  connecting = (async () => {
    const c = new MongoClient(URI, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
    });
    await c.connect();
    await c.db(DB_NAME).command({ ping: 1 });
    client = c;
    collection = c.db(DB_NAME).collection(COLLECTION);
    await collection.createIndex({ id: 1 }, { unique: true });
    lastError = null;
    return collection;
  })();

  try {
    return await connecting;
  } catch (err) {
    lastError = err;
    collection = null;
    if (client) { try { await client.close(); } catch { /* ignore */ } }
    client = null;
    throw err;
  } finally {
    connecting = null;
  }
}

/* Connect without throwing. Returns true when the collection is usable. */
async function ready() {
  try { await connect(); return true; } catch { return false; }
}

function status() {
  return {
    connected: !!collection,
    uri: redact(URI),
    db: DB_NAME,
    collection: COLLECTION,
    error: lastError ? lastError.message : null,
  };
}

/* Mongo's own _id is an implementation detail; the app keys on its numeric id. */
const strip = ({ _id, ...doc }) => doc;

async function listDocuments() {
  const col = await connect();
  const docs = await col.find({}, { sort: { id: 1 } }).toArray();
  return docs.map(strip);
}

async function upsertDocument(doc) {
  const col = await connect();
  await col.replaceOne({ id: doc.id }, doc, { upsert: true });
  return doc;
}

async function upsertMany(docs) {
  if (!docs.length) return 0;
  const col = await connect();
  const ops = docs.map((doc) => ({
    replaceOne: { filter: { id: doc.id }, replacement: doc, upsert: true },
  }));
  const res = await col.bulkWrite(ops, { ordered: false });
  return (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
}

async function deleteDocument(id) {
  const col = await connect();
  const res = await col.deleteOne({ id });
  return res.deletedCount > 0;
}

async function close() {
  if (client) { try { await client.close(); } catch { /* ignore */ } }
  client = null;
  collection = null;
}

module.exports = {
  ready, status, listDocuments, upsertDocument, upsertMany, deleteDocument, close,
  config: { uri: redact(URI), db: DB_NAME, collection: COLLECTION },
};
