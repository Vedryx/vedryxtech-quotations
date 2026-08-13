/* Exercises webroot/store.js against a fake API and a fake localStorage.
   The point of interest is that a sync must never drop a document the server has
   not seen — that was a real data-loss path. */
const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', 'webroot', 'store.js');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '\n         ' + detail : ''}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- environment */

const backing = {};   // fake localStorage
global.localStorage = {
  getItem: (k) => (k in backing ? backing[k] : null),
  setItem: (k, v) => { backing[k] = String(v); },
  removeItem: (k) => { delete backing[k]; },
};
global.window = { addEventListener() {} };
global.document = { addEventListener() {}, hidden: false };

/* Fake server: a map of id -> doc, plus a switch to simulate an outage. */
const server = {
  docs: new Map(),
  down: false,
  calls: [],
  reset(docs = []) {
    this.docs = new Map(docs.map((d) => [d.id, d]));
    this.down = false;
    this.calls = [];
  },
};

global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.calls.push({ method, url, body });

  if (server.down) throw new TypeError('Failed to fetch');

  const reply = (status, payload) => ({ ok: status < 400, status, json: async () => payload });

  if (method === 'GET' && url === '/api/documents') {
    return reply(200, { documents: [...server.docs.values()].sort((a, b) => a.id - b.id) });
  }
  if (method === 'PUT' && url === '/api/documents') {
    for (const d of body.documents) server.docs.set(d.id, d);
    return reply(200, { written: body.documents.length });
  }
  if (method === 'PUT' && url.startsWith('/api/documents/')) {
    server.docs.set(body.id, body);
    return reply(200, { document: body });
  }
  if (method === 'DELETE' && url.startsWith('/api/documents/')) {
    server.docs.delete(Number(url.split('/').pop()));
    return reply(204, null);
  }
  return reply(404, { error: 'not found' });
};

/* Load store.js the way a browser would. */
new Function(fs.readFileSync(STORE, 'utf8')).call(global);
const S = global.window.Store;

const KEY = 'vedryxtech.quotations.v1';
const LEGACY = 'vedryx.quotations.v1';

const doc = (id, name) => ({ id, client: { name }, items: [], status: 'Draft' });
const names = (docs) => docs.map((d) => `${d.id}:${d.client.name}`);
const bulkPuts = () => server.calls.filter((c) => c.method === 'PUT' && c.url === '/api/documents');
const clearLocal = () => Object.keys(backing).forEach((k) => delete backing[k]);

/* -------------------------------------------------------------------- tests */

async function main() {
  console.log('local mirror');
  clearLocal();
  ok('empty mirror reads as null', S.readLocal() === null);
  S.writeLocal([doc(1, 'A')]);
  eq('round-trips', names(S.readLocal()), ['1:A']);

  console.log('\nlegacy key migration');
  clearLocal();
  backing[LEGACY] = JSON.stringify([doc(7, 'Legacy')]);
  eq('reads the pre-rename key', names(S.readLocal()), ['7:Legacy']);
  ok('copied to the new key', !!backing[KEY]);
  ok('old key removed', !(LEGACY in backing));

  console.log('\nsync: a document the server has never seen is pushed, not dropped');
  clearLocal();
  server.reset([doc(1, 'Server one'), doc(2, 'Server two')]);
  let merged = await S.syncFromServer([doc(2, 'Local two'), doc(3, 'Local only')]);
  eq('merged list keeps the local-only document', names(merged),
    ['1:Server one', '2:Server two', '3:Local only']);
  ok('server state wins on a conflict', merged.find((d) => d.id === 2).client.name === 'Server two');
  ok('the local-only document was pushed up', server.docs.has(3));
  eq('and only that one was pushed', bulkPuts().map((c) => c.body.documents.map((d) => d.id)), [[3]]);
  eq('mirror updated to the merged list', names(S.readLocal()),
    ['1:Server one', '2:Server two', '3:Local only']);
  ok('reported online', S.status().online === true);

  console.log('\nsync: an empty database adopts the browser copy');
  clearLocal();
  server.reset([]);
  merged = await S.syncFromServer([doc(1, 'A'), doc(2, 'B')]);
  eq('both returned', names(merged), ['1:A', '2:B']);
  eq('both seeded into the database', [...server.docs.keys()].sort(), [1, 2]);

  console.log('\nsync: nothing local, server authoritative');
  clearLocal();
  server.reset([doc(4, 'Only server')]);
  merged = await S.syncFromServer([]);
  eq('returns the server list', names(merged), ['4:Only server']);
  eq('no bulk push was needed', bulkPuts().length, 0);

  console.log('\nsync: an unreachable server changes nothing');
  clearLocal();
  S.writeLocal([doc(1, 'Kept')]);
  server.reset([doc(9, 'Unseen')]);
  server.down = true;
  ok('returns null so the caller keeps its list', await S.syncFromServer([doc(1, 'Kept')]) === null);
  eq('mirror untouched', names(S.readLocal()), ['1:Kept']);
  ok('reported offline', S.status().online === false);
  ok('error recorded', typeof S.status().error === 'string');

  console.log('\na failed write is queued and retried');
  clearLocal();
  server.reset([]);
  server.down = true;
  ok('save reports failure', await S.saveDoc(doc(5, 'Queued'), [doc(5, 'Queued')]) === false);
  ok('mirror still holds it', S.readLocal().some((d) => d.id === 5));
  ok('counted as pending', S.status().pending === 1, JSON.stringify(S.status()));
  ok('never reached the database', !server.docs.has(5));

  server.down = false;
  ok('next successful save reports true',
    await S.saveDoc(doc(6, 'Fresh'), [doc(5, 'Queued'), doc(6, 'Fresh')]) === true);
  ok('the queued document was flushed too', server.docs.has(5), [...server.docs.keys()].join(','));
  ok('backlog cleared', S.status().pending === 0, JSON.stringify(S.status()));

  console.log('\nflushPending on its own');
  server.reset([]);
  server.down = true;
  await S.saveDoc(doc(11, 'Held'), [doc(11, 'Held')]);
  ok('queued', S.status().pending === 1);
  ok('flush fails while down', await S.flushPending() === false);
  ok('still queued', S.status().pending === 1);
  server.down = false;
  ok('flush succeeds once back', await S.flushPending() === true);
  ok('reached the database', server.docs.has(11));
  ok('backlog cleared', S.status().pending === 0);

  console.log('\na queued document survives the next sync');
  clearLocal();
  server.reset([doc(20, 'On server')]);
  server.down = true;
  await S.saveDoc(doc(21, 'Sent while down'), [doc(20, 'On server'), doc(21, 'Sent while down')]);
  ok('queued', S.status().pending === 1);
  server.down = false;
  merged = await S.syncFromServer(S.readLocal());
  ok('still present after the sync', merged.some((d) => d.id === 21), names(merged).join(','));
  ok('and now in the database', server.docs.has(21));
  ok('backlog cleared', S.status().pending === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
