/* Loads app.js under minimal DOM stubs and exercises the pure logic.
   No seed data lives in the app any more; the tests build fixtures inline. */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const APP = path.join(__dirname, '..', 'public', 'app.js');

global.localStorage = { getItem: () => null, setItem: () => {} };
global.Store = {
  readLocal: () => null,
  writeLocal() {},
  saveDoc: () => Promise.resolve(true),
  syncFromServer: () => Promise.resolve(null),
  status: () => ({ online: false, error: null }),
  onStatusChange() {},
};
global.document = {
  addEventListener() {},
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, append() {}, addEventListener() {} }),
  documentElement: { style: { setProperty() {} }, setAttribute() {}, getAttribute: () => null },
};
global.window = { print() {}, matchMedia: () => ({ matches: false }) };

let src = fs.readFileSync(APP, 'utf8');
src = src.replace("document.addEventListener('DOMContentLoaded', init);", '');
src += `
module.exports = { money, totals, nextNumber, lineAmount, isoLocal, fmtDate,
  initialsOf, blankDoc, upsert, state, CONFIG,
  nonNeg, pct, numericText, numericNormalized, normalizeDoc, validateDraft,
  deriveLetterTitle, NUM_LIMITS };`;

const m = new Module(APP, null);
m.filename = APP;
m.paths = Module._nodeModulePaths(path.dirname(APP));
m._compile(src, APP);
const A = m.exports;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
}

/* Fixtures — the same three quotations + one invoice the app used to seed
   itself with, kept here as reference data for arithmetic tests. */
const q1 = {
  id: 1, type: 'quotation', number: 'QT-2026-011', status: 'Sent',
  issueDate: '2026-07-02', validUntil: '2026-08-01',
  client: { name: 'Really Great Company', contact: 'Avery Shaw', email: 'avery@reallygreat.com', phone: '', address: '' },
  items: [
    { id: 1, service: 'Service 1', description: '', qty: 1, price: 200 },
    { id: 2, service: 'Service 2', description: '', qty: 1, price: 100 },
    { id: 3, service: 'Design 1', description: '', qty: 1, price: 250 },
  ],
  discount: 0, taxRate: 0, notes: '',
};
const q2 = {
  id: 2, type: 'quotation', number: 'QT-2026-012', status: 'Sent',
  issueDate: '2026-07-21', validUntil: '2026-08-20',
  client: { name: 'Northwind Labs', contact: '', email: '', phone: '', address: '' },
  items: [
    { id: 1, service: 'Website revamp', description: '', qty: 1, price: 1800 },
    { id: 2, service: 'Maintenance', description: '', qty: 3, price: 150 },
  ],
  discount: 5, taxRate: 18, notes: '',
};
const q3 = {
  id: 3, type: 'quotation', number: 'QT-2026-013', status: 'Draft',
  issueDate: '2026-08-05', validUntil: '2026-09-04',
  client: { name: 'Halcyon Interiors', contact: '', email: '', phone: '', address: '' },
  items: [
    { id: 1, service: 'Mobile app prototype', description: '', qty: 1, price: 2400 },
  ],
  discount: 0, taxRate: 18, notes: '',
};
const inv = {
  id: 4, type: 'invoice', number: 'INV-2026-004', status: 'Sent',
  issueDate: '2026-07-06', validUntil: '2026-07-20',
  client: { name: 'Really Great Company', contact: '', email: '', phone: '', address: '' },
  items: [
    { id: 1, service: 'Service 1', description: '', qty: 1, price: 200 },
    { id: 2, service: 'Service 2', description: '', qty: 1, price: 100 },
    { id: 3, service: 'Design 1', description: '', qty: 1, price: 250 },
  ],
  discount: 0, taxRate: 0, notes: '',
};

A.state.quotes = [q1, q2, q3, inv];

console.log('boot state');
eq('quotes start empty when the mirror is null', typeof A.state.quotes[0], 'object');

console.log('line amounts');
eq('qty 3 x 150', A.lineAmount({ qty: 3, price: 150 }), 450);
eq('qty 0 is flat price', A.lineAmount({ qty: 0, price: 500 }), 500);
eq('string inputs coerce', A.lineAmount({ qty: '2', price: '12.5' }), 25);
eq('empty line', A.lineAmount({ qty: '', price: '' }), 0);

console.log('totals');
eq('QT-011 no discount/tax', A.totals(q1), { sub: 550, disc: 0, tax: 0, total: 550 });
eq('QT-012 5% off then 18% tax', A.totals(q2), { sub: 2250, disc: 112.5, tax: 384.75, total: 2522.25 });
eq('QT-013 18% tax', A.totals(q3), { sub: 2400, disc: 0, tax: 432, total: 2832 });

console.log('outstanding (Sent quotations only)');
const outstanding = A.state.quotes
  .filter((q) => (q.type || 'quotation') === 'quotation' && q.status === 'Sent')
  .reduce((a, q) => a + A.totals(q).total, 0);
eq('sum of QT-011 + QT-012', outstanding, 3072.25);

console.log('money');
eq('thousands + 2dp', A.money(2522.25), '$2,522.25');
eq('zero', A.money(0), '$0.00');
eq('rounds to 2dp', A.money(1.005), '$1.01');
eq('non-numeric', A.money('abc'), '$0.00');

console.log('numbering');
eq('next quotation', A.nextNumber('quotation'), 'QT-' + new Date().getFullYear() + '-014');
eq('next invoice', A.nextNumber('invoice'), 'INV-' + new Date().getFullYear() + '-005');

console.log('dates');
eq('fmtDate', A.fmtDate('2026-07-02'), '02 July 2026');
eq('fmtDate empty', A.fmtDate(''), '—');
eq('isoLocal is calendar-local', A.isoLocal(new Date(2026, 0, 5)), '2026-01-05');
eq('isoLocal late evening does not roll', A.isoLocal(new Date(2026, 0, 5, 23, 59)), '2026-01-05');

console.log('misc');
eq('initials', A.initialsOf('Really Great Company'), 'RG');
eq('initials single word', A.initialsOf('Northwind'), 'N');
eq('initials empty', A.initialsOf(''), '?');

console.log('upsert');
const before = A.state.quotes.length;
const fresh = A.blankDoc();
let list = A.upsert(fresh);
eq('new doc is appended', list.length, before + 1);
eq('new doc got an id', typeof list[list.length - 1].id, 'number');
A.state.quotes = list;
const edited = JSON.parse(JSON.stringify(list[list.length - 1]));
edited.client.name = 'Edited Co';
list = A.upsert(edited);
eq('existing doc is replaced, not appended', list.length, before + 1);
eq('edit landed', list[list.length - 1].client.name, 'Edited Co');

console.log('blank doc');
eq('inherits defaultTax', A.blankDoc().taxRate, A.CONFIG.defaultTax);
eq('starts as Draft', A.blankDoc().status, 'Draft');
eq('one empty line', A.blankDoc().items.length, 1);
eq('respects the docType (quotation)', (() => { A.state.docType = 'quotation'; return A.blankDoc().type; })(), 'quotation');
eq('respects the docType (invoice)', (() => { A.state.docType = 'invoice'; return A.blankDoc().type; })(), 'invoice');
A.state.docType = 'quotation';

console.log('negative rejection — nonNeg / pct');
eq('negative becomes zero', A.nonNeg(-500), 0);
eq('negative string becomes zero', A.nonNeg('-500'), 0);
eq('NaN becomes zero', A.nonNeg('abc'), 0);
eq('Infinity becomes zero', A.nonNeg(Infinity), 0);
eq('positive passes through', A.nonNeg('12.5'), 12.5);
eq('percent capped at 100', A.pct(150), 100);
eq('negative percent becomes zero', A.pct(-20), 0);

console.log('input sanitising — numericText');
eq('minus sign stripped', A.numericText('-500', 'price'), '500');
eq('letters stripped', A.numericText('12abc3', 'price'), '123');
eq('exponent stripped', A.numericText('1e9', 'price'), '19');
eq('second decimal point stripped', A.numericText('1.2.3', 'price'), '1.23');
eq('partial entry survives', A.numericText('12.', 'price'), '12.');
eq('lone dot survives', A.numericText('.', 'price'), '.');
eq('discount over 100 clamped live', A.numericText('150', 'discount'), '100');
eq('tax over 100 clamped live', A.numericText('900', 'taxRate'), '100');
eq('price ceiling respected', A.numericText('9999999999', 'price'), String(A.NUM_LIMITS.price.max));

console.log('blur normalising — numericNormalized');
eq('blank becomes 0', A.numericNormalized('', 'price'), '0');
eq('lone dot becomes 0', A.numericNormalized('.', 'price'), '0');
eq('trailing dot settles', A.numericNormalized('12.', 'price'), '12');
eq('rounds to 2dp', A.numericNormalized('1.239', 'price'), '1.24');
eq('negative settles to 0', A.numericNormalized('-9', 'price'), '9');
eq('discount clamps', A.numericNormalized('101', 'discount'), '100');

console.log('maths cannot go negative even with bad stored data');
const poisoned = {
  items: [{ service: 'X', qty: -3, price: -100 }, { service: 'Y', qty: 2, price: 50 }],
  discount: 999, taxRate: -5,
};
const pt = A.totals(poisoned);
eq('negative line contributes 0', pt.sub, 100);
eq('discount capped at sub-total', pt.disc, 100);
eq('negative tax becomes 0', pt.tax, 0);
eq('total never negative', pt.total, 0);
eq('negative line amount is 0', A.lineAmount({ qty: -3, price: -100 }), 0);

console.log('normalizeDoc cleans a document before storage');
const dirty = A.normalizeDoc({
  number: '  QT-1  ', discount: -5, taxRate: 500,
  client: { name: '  Acme  ', contact: '', email: ' a@b.co ', phone: '', address: '' },
  items: [{ service: '  Bad  ', qty: '-2', price: '-99' }],
});
eq('number trimmed', dirty.number, 'QT-1');
eq('client name trimmed', dirty.client.name, 'Acme');
eq('negative discount zeroed', dirty.discount, 0);
eq('tax capped', dirty.taxRate, 100);
eq('negative qty zeroed', dirty.items[0].qty, 0);
eq('negative price zeroed', dirty.items[0].price, 0);
eq('service trimmed', dirty.items[0].service, 'Bad');
eq('stored values are numbers', typeof dirty.items[0].price, 'number');

console.log('validateDraft');
const valid = {
  number: 'QT-1', issueDate: '2026-08-01', validUntil: '2026-09-01',
  client: { name: 'Acme', contact: '', email: 'a@b.co', phone: '', address: '' },
  items: [{ service: 'Work', qty: 1, price: 100 }], discount: 0, taxRate: 0,
};
eq('a complete document is clean', A.validateDraft(valid), {});
eq('missing client name', Object.keys(A.validateDraft({ ...valid, client: { ...valid.client, name: '  ' } })), ['clientName']);
eq('missing number', Object.keys(A.validateDraft({ ...valid, number: '' })), ['number']);
eq('missing issue date', Object.keys(A.validateDraft({ ...valid, issueDate: '' })), ['issueDate']);
eq('bad email', Object.keys(A.validateDraft({ ...valid, client: { ...valid.client, email: 'nope' } })), ['clientEmail']);
eq('blank email is allowed', A.validateDraft({ ...valid, client: { ...valid.client, email: '' } }), {});
eq('valid-until before issue date', Object.keys(A.validateDraft({ ...valid, validUntil: '2026-07-01' })), ['validUntil']);
eq('same day is allowed', A.validateDraft({ ...valid, validUntil: '2026-08-01' }), {});
eq('no priced line', Object.keys(A.validateDraft({ ...valid, items: [{ service: 'Work', qty: 1, price: 0 }] })), ['items']);
eq('unnamed line does not count', Object.keys(A.validateDraft({ ...valid, items: [{ service: '', qty: 1, price: 100 }] })), ['items']);
eq('100% discount leaves nothing to bill', Object.keys(A.validateDraft({ ...valid, discount: 100 })), ['items']);

console.log('letter title derivation');
eq('empty falls back', A.deriveLetterTitle(''), 'Untitled letter');
eq('strips tags', A.deriveLetterTitle('<p>Hello <b>world</b></p>'), 'Hello world');
eq('collapses whitespace', A.deriveLetterTitle('<p>  a\n\nb  </p>'), 'a b');
eq('truncates to 80 chars', A.deriveLetterTitle('<p>' + 'x'.repeat(100) + '</p>').length, 80);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
