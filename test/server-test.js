/* Server-side tests: sanitize() shape coverage, multi-collection routing in
   lib/db.js (against an in-memory fake MongoClient injected via require.cache),
   and the /api/documents/:id/send endpoint driven with a mocked global.fetch
   so no real Resend request ever fires. */
'use strict';

const path = require('path');
const http = require('http');
const Module = require('module');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '\n         ' + detail : ''}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

/* --------------------------------------------------------------- fake mongo */

/* An in-memory replacement for the mongodb driver, wired via require.cache
   so lib/db.js picks it up without a network connection. */
function makeFakeMongo() {
  const state = { ops: [] };  // trace of every op, for assertions

  function makeCollection(name) {
    const store = new Map();
    return {
      _name: name,
      _store: store,
      async createIndex(spec, opts) { state.ops.push(['index', name, spec, opts]); },
      async replaceOne(filter, doc, opts) {
        state.ops.push(['replaceOne', name, doc.id]);
        store.set(doc.id, doc);
        return { modifiedCount: 1, upsertedCount: 0, matchedCount: 1 };
      },
      async bulkWrite(ops) {
        state.ops.push(['bulkWrite', name, ops.length]);
        for (const op of ops) {
          const d = op.replaceOne.replacement;
          store.set(d.id, d);
        }
        return { modifiedCount: ops.length, upsertedCount: 0, matchedCount: ops.length };
      },
      async deleteOne(filter) {
        const had = store.delete(filter.id);
        state.ops.push(['deleteOne', name, filter.id, had]);
        return { deletedCount: had ? 1 : 0 };
      },
      async findOne(filter) { return store.get(filter.id) ? { _id: 'x', ...store.get(filter.id) } : null; },
      find(_filter = {}, _opts = {}) {
        const arr = [...store.values()].map((d) => ({ _id: 'x', ...d }));
        return { async toArray() { return arr; } };
      },
    };
  }

  const collections = {};

  class FakeMongoClient {
    constructor(uri) { this._uri = uri; }
    async connect() { return this; }
    db(name) {
      return {
        async command() { return { ok: 1 }; },
        collection(colName) {
          if (!collections[colName]) collections[colName] = makeCollection(colName);
          return collections[colName];
        },
      };
    }
    async close() { /* no-op */ }
  }

  return { MongoClient: FakeMongoClient, _state: state, _collections: collections };
}

const fakeMongo = makeFakeMongo();
require.cache[require.resolve('mongodb')] = {
  exports: fakeMongo,
  loaded: true,
  id: require.resolve('mongodb'),
  filename: require.resolve('mongodb'),
  children: [],
  paths: [],
};

/* --------------------------------------------------- sanitize + db routing */

/* Load lib/db.js AFTER cache pollution so it uses the fake driver. Load
   server.js after that so it consumes the same fake db instance. */
const db = require(path.resolve(__dirname, '..', 'lib', 'db.js'));
const { app, sanitize, renderDocEmail } = require(path.resolve(__dirname, '..', 'server.js'));

async function main() {
  /* -------- sanitize() ----------------------------------------------- */

  console.log('sanitize — quotation shape');
  const q = sanitize({
    id: 100, type: 'quotation', number: 'QT-1', status: 'Sent',
    issueDate: '2026-08-01', validUntil: '2026-09-01',
    client: { name: 'Acme', email: 'a@b.co' },
    items: [{ service: 'X', qty: 2, price: 100 }],
    discount: -5, taxRate: 500, notes: '​'.padEnd(3000, 'x'),
  });
  ok('quotation type preserved', q.type === 'quotation');
  ok('negative discount zeroed', q.discount === 0);
  ok('tax capped at 100', q.taxRate === 100);
  ok('notes clipped', q.notes.length <= 2000);
  ok('items normalized', q.items[0].qty === 2 && q.items[0].price === 100);

  console.log('\nsanitize — invoice shape');
  const inv = sanitize({ id: 101, type: 'invoice', number: 'INV-1' });
  ok('invoice type preserved', inv.type === 'invoice');
  ok('invoice defaults', inv.status === 'Draft');

  console.log('\nsanitize — letter shape');
  const L = sanitize({ id: 102, type: 'letter', title: '  My letter  ', html: '<p>Hi</p>' });
  ok('letter type preserved', L.type === 'letter');
  ok('title trimmed', L.title === 'My letter');
  ok('html preserved', L.html === '<p>Hi</p>');
  ok('has no client / items', L.client === undefined && L.items === undefined);
  ok('carries updatedAt', typeof L.updatedAt === 'string' && L.updatedAt.length >= 20);

  const Lempty = sanitize({ id: 103, type: 'letter', title: '', html: '' });
  ok('empty title falls back', Lempty.title === 'Untitled letter');

  const Lbig = sanitize({ id: 104, type: 'letter', title: 'x'.repeat(500), html: 'y'.repeat(300000) });
  ok('title clipped to 160', Lbig.title.length === 160);
  ok('html clipped to 200_000', Lbig.html.length === 200000);

  ok('invalid input rejected', sanitize(null) === null);
  ok('non-numeric id rejected', sanitize({ id: 'abc', type: 'quotation' }) === null);

  /* -------- multi-collection routing --------------------------------- */

  console.log('\nlib/db.js — routes each type to its own collection');
  await db.ready();
  await db.upsertDocument(sanitize({ id: 201, type: 'quotation', number: 'QT-9' }));
  await db.upsertDocument(sanitize({ id: 202, type: 'invoice',   number: 'INV-9' }));
  await db.upsertDocument(sanitize({ id: 203, type: 'letter', title: 'One', html: 'a' }));

  ok('quotation lives in quotations',   fakeMongo._collections.quotations._store.has(201));
  ok('invoice lives in invoices',       fakeMongo._collections.invoices._store.has(202));
  ok('letter lives in letterheads',     fakeMongo._collections.letterheads._store.has(203));
  ok('no cross-contamination',
    !fakeMongo._collections.invoices._store.has(201)
    && !fakeMongo._collections.quotations._store.has(202)
    && !fakeMongo._collections.quotations._store.has(203),
  );

  const listed = await db.listDocuments();
  eq('list is the union of all three', listed.map((d) => d.id).sort(), [201, 202, 203]);

  const got = await db.getDocument(202);
  ok('getDocument finds across collections', got && got.id === 202 && got.type === 'invoice');

  await db.upsertMany([
    sanitize({ id: 204, type: 'quotation', number: 'QT-10' }),
    sanitize({ id: 205, type: 'invoice',   number: 'INV-10' }),
    sanitize({ id: 206, type: 'letter', title: 'Two', html: 'b' }),
  ]);
  ok('upsertMany grouped by type',
    fakeMongo._collections.quotations._store.has(204)
    && fakeMongo._collections.invoices._store.has(205)
    && fakeMongo._collections.letterheads._store.has(206),
  );

  await db.deleteDocument(203);
  ok('deleteDocument searches all three', !fakeMongo._collections.letterheads._store.has(203));

  const s = db.status();
  eq('status reports all three collection names',
    Object.values(s.collections).sort(),
    ['invoices', 'letterheads', 'quotations']);

  /* -------- /api/documents/:id/send with mocked Resend -------------- */

  console.log('\n/api/documents/:id/send');

  /* Boot the express app on an ephemeral port for real HTTP round-trips. */
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  process.env.RESEND_API_KEY = 'test-key';
  process.env.SALES_FROM = 'sales@example.com';
  process.env.SALES_CC = 'cc@example.com';

  const resendCalls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.startsWith('https://api.resend.com')) {
      resendCalls.push({ url, opts });
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ id: 'em_stub' }),
      };
    }
    return origFetch(url, opts);
  };

  /* Seed a real (fake-Mongo-backed) quotation to look up. */
  const quoteId = 900;
  await db.upsertDocument(sanitize({
    id: quoteId, type: 'quotation', number: 'QT-Send',
    issueDate: '2026-08-13', validUntil: '2026-09-12',
    client: { name: 'Send Co', email: 'billing@sendco.io' },
    items: [{ service: 'Retainer', qty: 2, price: 500 }],
    discount: 10, taxRate: 18, notes: 'Payable NET 15.',
  }));

  const sendRes = await fetch(`${baseUrl}/api/documents/${quoteId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const sendBody = await sendRes.json();
  ok('/send returns 200', sendRes.status === 200, `status ${sendRes.status} body ${JSON.stringify(sendBody)}`);
  ok('response carries sent:true', sendBody.sent === true, JSON.stringify(sendBody));
  ok('exactly one Resend call fired', resendCalls.length === 1);

  const req = resendCalls[0].opts;
  const payload = JSON.parse(req.body);
  ok('POST to Resend', req.method === 'POST');
  ok('Bearer auth header set', /^Bearer /.test(req.headers.Authorization));
  eq('recipient from client.email', payload.to, ['billing@sendco.io']);
  eq('cc set from env', payload.cc, ['cc@example.com']);
  ok('from from env', payload.from === 'sales@example.com', payload.from);
  ok('subject includes doc number', /QT-Send/.test(payload.subject), payload.subject);
  ok('html body includes client name', /Send Co/.test(payload.html));
  ok('html body includes totals', /TOTAL/.test(payload.html));

  console.log('\n/send override recipient');
  const sendRes2 = await fetch(`${baseUrl}/api/documents/${quoteId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'accounting@sendco.io' }),
  });
  const sendBody2 = await sendRes2.json();
  ok('override 200', sendRes2.status === 200, JSON.stringify(sendBody2));
  eq('recipient overridden', JSON.parse(resendCalls[1].opts.body).to, ['accounting@sendco.io']);

  console.log('\n/send rejects bad recipient');
  await db.upsertDocument(sanitize({
    id: 901, type: 'quotation', number: 'QT-NoEmail',
    client: { name: 'No Email Co' },
    items: [{ service: 'Retainer', qty: 1, price: 100 }],
  }));
  const badRes = await fetch(`${baseUrl}/api/documents/901/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const badBody = await badRes.json();
  ok('400 when there is no valid email', badRes.status === 400, `status ${badRes.status}`);
  ok('error tag surfaces', badBody.error === 'no valid recipient', JSON.stringify(badBody));

  console.log('\n/send returns 404 for missing docs');
  const missRes = await fetch(`${baseUrl}/api/documents/999999/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  ok('404', missRes.status === 404, `status ${missRes.status}`);

  console.log('\n/send refuses letter type');
  await db.upsertDocument(sanitize({ id: 902, type: 'letter', title: 'Nope', html: 'x' }));
  const letterRes = await fetch(`${baseUrl}/api/documents/902/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  ok('400 for letter', letterRes.status === 400, `status ${letterRes.status}`);

  console.log('\nrenderDocEmail escapes HTML in client-controlled strings');
  const html = renderDocEmail({
    id: 1, type: 'quotation', number: 'QT-X',
    client: { name: '<script>x</script>' },
    items: [{ service: '<img>', qty: 1, price: 10 }],
    discount: 0, taxRate: 0, notes: 'Just <b>notes</b>',
  });
  ok('script tag escaped', !html.includes('<script>x</script>'), html.slice(0, 300));
  ok('& escaped correctly', html.includes('&lt;script&gt;'));

  /* -------- teardown ------------------------------------------------ */
  global.fetch = origFetch;
  await new Promise((r) => server.close(r));
  await db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
