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
const { app, sanitize, renderDocEmail, fmtMoney, CURRENCIES, DEFAULT_CURRENCY } =
  require(path.resolve(__dirname, '..', 'server.js'));

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

  console.log('\nsanitize — currency (allowlist + default)');
  ok('exposes the six-currency allowlist',
    JSON.stringify(CURRENCIES.slice().sort()) === JSON.stringify(['AED', 'EUR', 'GBP', 'INR', 'JPY', 'USD']),
    JSON.stringify(CURRENCIES));
  ok('default currency is USD', DEFAULT_CURRENCY === 'USD');
  ok('quotation default currency is USD when missing',
    sanitize({ id: 110, type: 'quotation' }).currency === 'USD');
  ok('invoice default currency is USD when missing',
    sanitize({ id: 111, type: 'invoice' }).currency === 'USD');
  ok('quotation accepts INR',
    sanitize({ id: 112, type: 'quotation', currency: 'INR' }).currency === 'INR');
  ok('quotation accepts JPY',
    sanitize({ id: 113, type: 'quotation', currency: 'JPY' }).currency === 'JPY');
  ok('quotation accepts AED',
    sanitize({ id: 114, type: 'quotation', currency: 'AED' }).currency === 'AED');
  ok('lowercase code is normalised to upper',
    sanitize({ id: 115, type: 'quotation', currency: 'gbp' }).currency === 'GBP');
  ok('unknown code coerces to USD default',
    sanitize({ id: 116, type: 'quotation', currency: 'ZZZ' }).currency === 'USD');
  ok('non-string code coerces to USD',
    sanitize({ id: 117, type: 'quotation', currency: 42 }).currency === 'USD');
  ok('letters have no currency field',
    sanitize({ id: 118, type: 'letter', title: 'L', html: '' }).currency === undefined);

  console.log('\nfmtMoney — Intl per currency');
  ok('USD is $', fmtMoney('USD', 1000) === '$1,000.00', fmtMoney('USD', 1000));
  ok('INR is ₹', fmtMoney('INR', 1000) === '₹1,000.00', fmtMoney('INR', 1000));
  ok('EUR is €', fmtMoney('EUR', 1000) === '€1,000.00', fmtMoney('EUR', 1000));
  ok('GBP is £', fmtMoney('GBP', 1000) === '£1,000.00', fmtMoney('GBP', 1000));
  /* Intl inserts U+00A0 (nbsp) between the code and the number, not a regular
     space — this is deliberate so line-wrapping doesn't split "AED" from its
     amount in rendered output. */
  ok('AED prefixes code with nbsp', fmtMoney('AED', 1000) === 'AED 1,000.00', JSON.stringify(fmtMoney('AED', 1000)));
  ok('JPY has zero decimals', fmtMoney('JPY', 1000) === '¥1,000', fmtMoney('JPY', 1000));
  ok('missing code falls back to USD', fmtMoney(undefined, 5) === '$5.00', fmtMoney(undefined, 5));
  ok('non-numeric amount becomes zero', fmtMoney('EUR', 'abc') === '€0.00', fmtMoney('EUR', 'abc'));

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

  console.log('\nrenderDocEmail — currency is read from the doc');
  const baseDoc = {
    id: 1, type: 'quotation', number: 'QT-CUR',
    client: { name: 'Currency Co' },
    items: [{ service: 'Line', qty: 1, price: 1000 }],
    discount: 0, taxRate: 0, notes: '',
  };
  const usdHtml = renderDocEmail({ ...baseDoc, currency: 'USD' });
  ok('USD email shows $', usdHtml.includes('$1,000.00'), usdHtml.match(/\$[\d,]+\.\d\d/g)?.join(','));
  const inrHtml = renderDocEmail({ ...baseDoc, currency: 'INR' });
  ok('INR email shows ₹', inrHtml.includes('₹1,000.00'), inrHtml.match(/₹[\d,]+\.\d\d/g)?.join(','));
  ok('INR email does not leak the previous $ symbol', !inrHtml.includes('$1,000.00'));
  const jpyHtml = renderDocEmail({ ...baseDoc, currency: 'JPY' });
  ok('JPY email shows ¥ with no decimals', jpyHtml.includes('¥1,000'), jpyHtml.match(/¥[\d,]+/g)?.join(','));
  ok('JPY email does not show fractional yen', !jpyHtml.includes('¥1,000.00'));
  const aedHtml = renderDocEmail({ ...baseDoc, currency: 'AED' });
  /* Intl uses U+00A0 (nbsp) between the AED code and the amount — build the
     expected string with the escape so the source is unambiguous. */
  ok('AED email uses the AED prefix', aedHtml.includes('AED\u00a01,000.00'),
    aedHtml.match(/AED[^<]{0,20}/g)?.join('|'));
  const gbpHtml = renderDocEmail({ ...baseDoc, currency: 'GBP' });
  ok('GBP email shows £', gbpHtml.includes('£1,000.00'));
  const noCurHtml = renderDocEmail(baseDoc);   // no currency at all
  ok('missing currency falls back to USD', noCurHtml.includes('$1,000.00'));

  console.log('\n/send uses doc.currency, not request body');
  /* Seed a JPY invoice (bypassing the client sanitize by writing what we want). */
  await db.upsertDocument(sanitize({
    id: 910, type: 'invoice', number: 'INV-JPY', currency: 'JPY',
    issueDate: '2026-08-13', validUntil: '2026-08-27',
    client: { name: 'Tokyo Co', email: 'billing@tokyo.jp' },
    items: [{ service: 'Retainer', qty: 1, price: 250000 }],
    discount: 0, taxRate: 0, notes: '',
  }));
  const jpySend = await fetch(`${baseUrl}/api/documents/910/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    /* Body tries to force USD — server MUST ignore it and read from the doc. */
    body: JSON.stringify({ currency: '$' }),
  });
  const jpyBody = await jpySend.json();
  ok('JPY send returns 200', jpySend.status === 200, JSON.stringify(jpyBody));
  const jpyPayload = JSON.parse(resendCalls[resendCalls.length - 1].opts.body);
  ok('JPY email HTML uses ¥', jpyPayload.html.includes('¥250,000'), jpyPayload.html.match(/¥[\d,]+/g)?.join(','));
  ok('JPY email HTML has NO $ prefix', !jpyPayload.html.includes('$250,000'));
  ok('JPY email HTML has NO fractional yen', !jpyPayload.html.includes('¥250,000.00'));

  await db.upsertDocument(sanitize({
    id: 911, type: 'quotation', number: 'QT-INR', currency: 'INR',
    issueDate: '2026-08-13', validUntil: '2026-09-12',
    client: { name: 'Mumbai Co', email: 'ap@mumbai.in' },
    items: [{ service: 'Build', qty: 1, price: 500000 }],
    discount: 0, taxRate: 18, notes: '',
  }));
  const inrSend = await fetch(`${baseUrl}/api/documents/911/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  ok('INR send returns 200', inrSend.status === 200);
  const inrPayload = JSON.parse(resendCalls[resendCalls.length - 1].opts.body);
  ok('INR email HTML uses ₹', inrPayload.html.includes('₹500,000.00'), inrPayload.html.match(/₹[\d,]+\.\d\d/g)?.join(','));

  console.log('\nsanitize + upsert round-trip preserves per-doc currency');
  await db.upsertDocument(sanitize({
    id: 920, type: 'quotation', number: 'QT-RT-INR', currency: 'INR',
    client: { name: 'RT Co' }, items: [{ service: 'x', qty: 1, price: 100 }],
    issueDate: '2026-08-13', validUntil: '2026-09-12', discount: 0, taxRate: 0,
  }));
  const rtInr = await db.getDocument(920);
  ok('INR round-trips through sanitize + db', rtInr && rtInr.currency === 'INR', JSON.stringify(rtInr && rtInr.currency));

  await db.upsertDocument(sanitize({
    id: 921, type: 'invoice', number: 'INV-RT-JPY', currency: 'JPY',
    client: { name: 'RT Co' }, items: [{ service: 'x', qty: 1, price: 100 }],
    issueDate: '2026-08-13', validUntil: '2026-09-12', discount: 0, taxRate: 0,
  }));
  const rtJpy = await db.getDocument(921);
  ok('JPY round-trips through sanitize + db', rtJpy && rtJpy.currency === 'JPY');

  /* -------- teardown ------------------------------------------------ */
  global.fetch = origFetch;
  await new Promise((r) => server.close(r));
  await db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
