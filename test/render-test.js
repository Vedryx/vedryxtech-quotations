/* Runs app.js's real render path against a minimal DOM shim, then drives the
   app by invoking the listeners it attached. Verifies wiring, not layout. */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const APP = path.join(__dirname, '..', 'public', 'app.js');

/* Stands in for store.js — mirrors documents in memory instead of localStorage
   and never reaches the network. */
const Store = {
  mirror: null,
  lastSaved: null,
  pending: 0,
  failNext: false,     // flip on to simulate the database being unreachable
  readLocal() { return this.mirror; },
  writeLocal(docs) { this.mirror = JSON.parse(JSON.stringify(docs)); },
  saveDoc(doc, all) {
    if (all) this.writeLocal(all);
    this.lastSaved = doc;
    if (this.failNext) { this.pending += 1; return Promise.resolve(false); }
    return Promise.resolve(true);
  },
  deleteDoc: () => Promise.resolve(true),
  syncFromServer: () => Promise.resolve(null),
  flushPending() { this.pending = 0; return Promise.resolve(true); },
  status() {
    return {
      online: this.pending === 0,
      error: this.pending ? 'stub: database unreachable' : null,
      pending: this.pending,
    };
  },
  onStatusChange() {},
};
global.Store = Store;

/* ----------------------------------------------------------- the DOM shim */

function makeEl(tag) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    localName: tag,
    className: '',
    attrs: {},
    children: [],
    listeners: {},
    style: { display: '', setProperty() {} },
    _text: '',
    _innerHTML: null,
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    append(...kids) { for (const k of kids) this.children.push(k); },
    replaceChildren(...kids) { this.children = [...kids]; },
    remove() {},
    focus() {},
  };
}

const byId = { topbar: makeEl('header'), screen: makeEl('main') };

global.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = v; },
};
global.document = {
  addEventListener() {},
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById: (id) => byId[id] ?? null,
  documentElement: { style: { setProperty() {} } },
  execCommand() { execCalls.push([...arguments]); return true; },
};
let execCalls = [];
global.window = { print() { printed++; } };
let printed = 0;

/* ------------------------------------------------------------- load app.js */

let src = fs.readFileSync(APP, 'utf8');
src = src.replace("document.addEventListener('DOMContentLoaded', init);", '');
src += '\nmodule.exports = { init, state, render, CONFIG, totals, validateDraft };';
const m = new Module(APP, null);
m.filename = APP;
m.paths = Module._nodeModulePaths(path.dirname(APP));
m._compile(src, APP);
const A = m.exports;

/* --------------------------------------------------------------- utilities */

function walk(node, out = []) {
  if (!node) return out;
  if (node.nodeType === 3) { out.push(node); return out; }
  out.push(node);
  if (node._text) out.push({ nodeType: 3, textContent: node._text });
  for (const k of node.children) walk(k, out);
  return out;
}
function textOf(node) {
  return walk(node).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
}
function all(root) { return walk(root).filter((n) => n.nodeType === 1); }
function findByText(root, txt) {
  return all(root).find((n) => n._text === txt) || null;
}
function findAll(root, cls) {
  return all(root).filter((n) => (n.className || '').split(' ').includes(cls));
}
function fire(node, type, ev = {}) {
  if (!node) throw new Error(`fire(${type}) on missing node`);
  const fns = node.listeners[type] || [];
  if (!fns.length) throw new Error(`no ${type} listener on <${node.localName} class="${node.className}">`);
  let prevented = false;
  for (const fn of fns) {
    fn({ preventDefault() { prevented = true; }, stopPropagation() {}, target: node, ...ev });
  }
  return { prevented };
}

/* Types into a field the way a browser would: the input event carries whatever
   is currently in the box, and the handler may rewrite it. */
function type(node, value) {
  node.value = value;
  fire(node, 'input', { target: node });
  return node.value;
}
const screenEl = () => byId.screen.children[0];
const topbarText = () => textOf(byId.topbar);
const screenText = () => textOf(screenEl());

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '\n         ' + detail : ''}`); }
}
function has(label, txt) {
  const t = screenText();
  ok(label, t.includes(txt), `"${txt}" not found in: ${t.slice(0, 240)}…`);
}

/* -------------------------------------------------------------------- tests */

console.log('boot / home screen');
A.init();
ok('render produced a tree', !!screenEl());
has('heading', 'What are you making?');
has('quotation card', 'Quotation');
has('invoice card', 'Invoice');
has('letterhead card', 'Letterhead');
has('quotation count', '3 saved');
has('letterhead subtitle', 'Blank sheet');
ok('no chrome buttons on home', !topbarText().includes('New'), topbarText());

console.log('\nhome -> quotations list');
fire(findByText(screenEl(), 'Quotation').children ? findAll(screenEl(), 'tool-card')[0] : null, 'click');
ok('screen is list', A.state.screen === 'list', A.state.screen);
has('list title', 'Quotations');
has('count label', '3 total · 3 shown');
has('outstanding', '$3,072.25');
ok('three rows', findAll(screenEl(), 'row').length === 3, String(findAll(screenEl(), 'row').length));
ok('topbar shows chrome', topbarText().includes('New') && topbarText().includes('Quotations'), topbarText());
has('row amount for QT-012', '$2,522.25');
has('draft chip', 'Draft');

console.log('\nfilter to Sent');
fire(findAll(screenEl(), 'chip-filter').find((n) => n._text === 'Sent'), 'click');
ok('two sent rows', findAll(screenEl(), 'row').length === 2, String(findAll(screenEl(), 'row').length));
has('count label updated', '3 total · 2 shown');
ok('Sent chip is active', findAll(screenEl(), 'chip-filter').find((n) => n._text === 'Sent').className.includes('is-active'));

console.log('\nfilter to Draft, then open the draft (should go to edit, unlocked)');
fire(findAll(screenEl(), 'chip-filter').find((n) => n._text === 'Draft'), 'click');
ok('one draft row', findAll(screenEl(), 'row').length === 1);
fire(findAll(screenEl(), 'row')[0], 'click');
ok('screen is edit', A.state.screen === 'edit', A.state.screen);
ok('not locked', A.state.locked === false);
has('edit title', 'Edit quotation');
has('quotation no. label', 'Quotation no.');
has('valid until label', 'Valid until');
has('total in rail', '$2,832.00');

console.log('\nlive totals: change the tax rate without a re-render');
const taxInput = all(screenEl()).find((n) => n.attrs.type === 'number' && n.value === 18);
ok('found tax input', !!taxInput);
type(taxInput, '10');
has('tax label recomputed', 'Tax (10%)');
has('total recomputed', '$2,640.00');
ok('draft mutated', String(A.state.draft.taxRate) === '10');

console.log('\nadd a line, then remove it');
fire(findByText(screenEl(), '+ Add line'), 'click');
ok('two items', A.state.draft.items.length === 2);
ok('two remove buttons', findAll(screenEl(), 'item-remove').length === 2);
fire(findAll(screenEl(), 'item-remove')[1], 'click');
ok('back to one item', A.state.draft.items.length === 1);
fire(findAll(screenEl(), 'item-remove')[0], 'click');
ok('last line cannot be removed', A.state.draft.items.length === 1);

console.log('\nsave, then confirm persistence');
fire(findByText(screenEl(), 'Save quotation'), 'click');
has('saved note', 'Saved to your quotations list.');
ok('written to the local mirror', Array.isArray(Store.mirror));
ok('pushed to the database layer', Store.lastSaved && Store.lastSaved.number === 'QT-2026-013', JSON.stringify(Store.lastSaved && Store.lastSaved.number));
const storedDoc = Store.mirror.find((q) => q.number === 'QT-2026-013');
ok('stored tax survived', storedDoc.taxRate === 10, JSON.stringify(storedDoc.taxRate));
ok('stored as a number, not the raw input string', typeof storedDoc.taxRate === 'number');

console.log('\npreview of an unlocked draft');
fire(findByText(screenEl(), 'Preview'), 'click');
ok('screen is preview', A.state.screen === 'preview', A.state.screen);
has('doc title', 'QUOTATION');
has('billed to', 'BILLED TO');
has('client name', 'Halcyon Interiors');
has('valid until (doc)', 'VALID UNTIL');
has('send button', 'Send to client');
ok('no duplicate button while unlocked', !screenText().includes('Duplicate as draft'));
has('notes header', 'NOTES & TERMS');
has('footer brand', 'VEDRYXTECH');

console.log('\ndownload PDF calls print');
const before = printed;
fire(findByText(screenEl(), 'Download PDF'), 'click');
ok('window.print called', printed === before + 1);

console.log('\nsend to client -> locks and returns to the Sent list');
fire(findByText(screenEl(), 'Send to client'), 'click');
ok('screen is list', A.state.screen === 'list', A.state.screen);
ok('filter is Sent', A.state.filter === 'Sent', A.state.filter);
ok('three sent rows now', findAll(screenEl(), 'row').length === 3, String(findAll(screenEl(), 'row').length));

console.log('\nopening a Sent quotation locks it into preview');
fire(findAll(screenEl(), 'row')[0], 'click');
ok('screen is preview', A.state.screen === 'preview', A.state.screen);
ok('locked', A.state.locked === true);
has('locked banner', '— locked. Duplicate it as a draft to make changes.');
has('duplicate button', 'Duplicate as draft');
has('create invoice button', 'Create invoice');
ok('no send button while locked', !screenText().includes('Send to client'));

console.log('\ncreate invoice from the locked quotation');
fire(findByText(screenEl(), 'Create invoice'), 'click');
ok('screen is edit', A.state.screen === 'edit', A.state.screen);
ok('docType is invoice', A.state.docType === 'invoice', A.state.docType);
ok('numbered INV-…-005', A.state.draft.number === 'INV-' + new Date().getFullYear() + '-005', A.state.draft.number);
ok('status Draft', A.state.draft.status === 'Draft');
ok('notes reference the source', A.state.draft.notes.startsWith('Raised against QT-'), A.state.draft.notes.split('\n')[0]);
has('invoice labels', 'Invoice details');
has('due date label', 'Due date');
has('save invoice', 'Save invoice');

console.log('\nduplicate as draft from a locked doc');
A.state.screen = 'preview'; A.state.locked = true; A.render();
fire(findByText(screenEl(), 'Duplicate as draft'), 'click');
ok('screen is edit', A.state.screen === 'edit');
ok('id cleared', A.state.draft.id === null);
ok('title says New', screenText().includes('New invoice'), screenText().slice(0, 120));

console.log('\n"Add quantity" appears when qty is cleared');
fire(findAll(screenEl(), 'inp')[0], 'input', { target: { value: 'X' } }); // keep form alive
A.state.draft.items[0].qty = 0;
A.render();
has('add quantity link', 'Add quantity');
fire(findByText(screenEl(), 'Add quantity'), 'click');
ok('qty restored to 1', A.state.draft.items[0].qty === 1);
ok('add-quantity link gone', !screenText().includes('Add quantity'));

console.log('\nletterhead');
A.state.screen = 'home'; A.render();
fire(findAll(screenEl(), 'tool-card')[2], 'click');
ok('screen is letter', A.state.screen === 'letter', A.state.screen);
has('heading', 'Letterhead');
const body = findAll(screenEl(), 'letter-body')[0];
ok('editable body exists', !!body && body.attrs.contenteditable === 'true');
ok('seeded with a salutation', body.innerHTML.includes('To whom it may concern'), String(body.innerHTML).slice(0, 80));
ok('seeded with this year', body.innerHTML.includes(String(new Date().getFullYear())));
ok('nine format buttons', findAll(screenEl(), 'fmt-btn').length === 9, String(findAll(screenEl(), 'fmt-btn').length));
ok('five colour swatches', findAll(screenEl(), 'swatch').length === 5);
execCalls = [];
fire(findAll(screenEl(), 'fmt-btn')[0], 'click');
ok('bold ran execCommand', execCalls.length === 1 && execCalls[0][0] === 'bold', JSON.stringify(execCalls));
fire(findAll(screenEl(), 'swatch')[2], 'click');
ok('swatch set foreColor', execCalls[1][0] === 'foreColor' && execCalls[1][2] === '#1A4BF0', JSON.stringify(execCalls[1]));
ok('topbar shows All tools', topbarText().includes('All tools'), topbarText());

console.log('\nempty state');
A.state.quotes = []; A.state.docType = 'quotation'; A.state.screen = 'list'; A.state.filter = 'All';
A.render();
has('empty title', 'No quotations here yet');
has('empty cta', 'New quotation');
fire(findByText(screenEl(), 'New quotation'), 'click');
ok('screen is edit', A.state.screen === 'edit');
ok('numbered from scratch', A.state.draft.number === 'QT-' + new Date().getFullYear() + '-001', A.state.draft.number);
has('new title', 'New quotation');

/* ------------------------------------------------- validation, at the UI level */

const findNum = (max) => all(screenEl()).find((n) => n.attrs.type === 'number' && n.attrs.max === max);
const RATE_MAX = '1000000000';

console.log('\nnegative values cannot be entered into Rate');
let rate = findNum(RATE_MAX);
ok('found rate input', !!rate);
ok('minus key is swallowed', fire(rate, 'keydown', { key: '-' }).prevented === true);
ok('plus key is swallowed', fire(rate, 'keydown', { key: '+' }).prevented === true);
ok('exponent key is swallowed', fire(rate, 'keydown', { key: 'e' }).prevented === true);
ok('digits pass through', fire(rate, 'keydown', { key: '5' }).prevented === false);
ok('pasted "-500" becomes "500"', type(rate, '-500') === '500', type(rate, '-500'));
ok('state never holds a negative price', Number(A.state.draft.items[0].price) >= 0, String(A.state.draft.items[0].price));
ok('letters are stripped', type(rate, '9a9') === '99');
ok('a second decimal point is stripped', type(rate, '1.2.3') === '1.23');

console.log('\nblur settles a half-typed Rate');
type(rate, '');
fire(rate, 'blur', { target: rate });
ok('blank became 0', rate.value === '0', rate.value);
type(rate, '12.');
fire(rate, 'blur', { target: rate });
ok('trailing dot settled', rate.value === '12', rate.value);

console.log('\nQty and percentage fields are bounded too');
const qty = findNum('1000000');
ok('pasted negative qty becomes positive', type(qty, '-4') === '4');
const discount = all(screenEl()).find((n) => n.attrs.max === '100' && n.value === 0);
ok('found discount input', !!discount);
ok('discount over 100 clamps live', type(discount, '150') === '100');
ok('total is not negative at 100% discount', A.totals(A.state.draft).total >= 0, String(A.totals(A.state.draft).total));
type(discount, '0');

console.log('\nsending an incomplete document is blocked');
A.state.screen = 'preview'; A.render();
const quotesBefore = A.state.quotes.length;
fire(findByText(screenEl(), 'Send to client'), 'click');
ok('bounced back to edit', A.state.screen === 'edit', A.state.screen);
ok('validation is now showing', A.state.validated === true);
ok('client name flagged', !!A.state.errors.clientName);
has('summary banner', 'Cannot send yet');
has('client name message', 'Client name is required.');
has('services message', 'Add at least one service');
ok('nothing was saved', A.state.quotes.length === quotesBefore);

console.log('\nmessages clear as the fields are fixed');
const nameInput = findAll(screenEl(), 'inp')[0];
type(nameInput, 'Acme Ltd');
ok('client name error cleared', !A.state.errors.clientName, JSON.stringify(A.state.errors));
ok('its message is hidden', !screenText().includes('Client name is required.'));
has('services message still shown', 'Add at least one service');
type(findAll(screenEl(), 'item-service')[0], 'Consulting');
type(findNum(RATE_MAX), '1200');
ok('all errors cleared', Object.keys(A.state.errors).length === 0, JSON.stringify(A.state.errors));
ok('banner hidden', !screenText().includes('Cannot send yet'));

console.log('\na bad email blocks the send');
const emailInput = findAll(screenEl(), 'inp')[2];
type(emailInput, 'not-an-email');
ok('email flagged live', !!A.state.errors.clientEmail, JSON.stringify(A.state.errors));
has('email message', 'does not look like an email');
type(emailInput, 'billing@acme.co');
ok('email accepted', !A.state.errors.clientEmail);

console.log('\nnow the send goes through');
A.state.screen = 'preview'; A.render();
fire(findByText(screenEl(), 'Send to client'), 'click');
ok('landed on the Sent list', A.state.screen === 'list', A.state.screen);
ok('one document saved', A.state.quotes.length === quotesBefore + 1);
ok('status is Sent', A.state.quotes[0].status === 'Sent');
ok('rate stored as a number', typeof A.state.quotes[0].items[0].price === 'number');
ok('client name was trimmed', A.state.quotes[0].client.name === 'Acme Ltd');
ok('total is positive', A.totals(A.state.quotes[0]).total > 0);
ok('validation flag reset', A.state.validated === false);

console.log('\nsaving an incomplete draft is still allowed');
fire(findByText(byId.topbar, 'New'), 'click');
ok('on a blank editor', A.state.screen === 'edit' && !A.state.draft.client.name);
fire(findByText(screenEl(), 'Save quotation'), 'click');
has('save confirmed', 'Saved to your quotations list.');
ok('draft was stored despite being incomplete', A.state.quotes.length === quotesBefore + 2);
ok('no validation was forced', A.state.validated === false);

/* ------------------------------------------------ auto-save before preview/send */

function startFreshDoc(name, service, rateValue) {
  fire(findByText(byId.topbar, 'New'), 'click');
  if (name) type(findAll(screenEl(), 'inp')[0], name);
  if (service) type(findAll(screenEl(), 'item-service')[0], service);
  if (rateValue) type(findNum(RATE_MAX), rateValue);
}

console.log('\npreviewing a never-saved document auto-saves it as a draft');
startFreshDoc('Zephyr Works', 'Systems audit', '900');
const beforePreview = A.state.quotes.length;
ok('document is unsaved', A.state.draft.id === null);
fire(findByText(screenEl(), 'Preview'), 'click');
ok('on the preview screen', A.state.screen === 'preview', A.state.screen);
ok('exactly one document was added', A.state.quotes.length === beforePreview + 1);
ok('the draft now has an id', A.state.draft.id !== null);
has('auto-save notice', 'Auto-saved as a draft');
const zephyr = A.state.quotes.find((q) => q.client.name === 'Zephyr Works');
ok('saved with Draft status', zephyr && zephyr.status === 'Draft');
ok('mirrored locally', Store.mirror.some((q) => q.client.name === 'Zephyr Works'));
ok('pushed to the database layer', Store.lastSaved.client.name === 'Zephyr Works');

console.log('\npreviewing again does not duplicate it');
fire(findByText(screenEl(), '←'), 'click');
ok('back on edit', A.state.screen === 'edit', A.state.screen);
fire(findByText(screenEl(), 'Preview'), 'click');
ok('still one Zephyr document', A.state.quotes.filter((q) => q.client.name === 'Zephyr Works').length === 1);
ok('no auto-save notice the second time', !screenText().includes('Auto-saved as a draft'));

console.log('\npreviewing a blank document saves nothing');
startFreshDoc(null, null, null);
const beforeBlank = A.state.quotes.length;
fire(findByText(screenEl(), 'Preview'), 'click');
ok('on the preview screen', A.state.screen === 'preview');
ok('nothing was saved', A.state.quotes.length === beforeBlank, String(A.state.quotes.length));
ok('no auto-save notice', !screenText().includes('Auto-saved'));

console.log('\nsending a never-saved document commits it');
startFreshDoc('Orbit Media', 'Monthly retainer', '2500');
const beforeSend = A.state.quotes.length;
ok('document is unsaved', A.state.draft.id === null);
A.state.screen = 'preview'; A.render();   // reach Send without going through Preview
fire(findByText(screenEl(), 'Send to client'), 'click');
ok('landed on the Sent list', A.state.screen === 'list', A.state.screen);
ok('exactly one document was added', A.state.quotes.length === beforeSend + 1);
const orbit = A.state.quotes.find((q) => q.client.name === 'Orbit Media');
ok('saved with Sent status', orbit && orbit.status === 'Sent');
ok('mirrored locally', Store.mirror.some((q) => q.client.name === 'Orbit Media'));
ok('pushed to the database layer', Store.lastSaved.client.name === 'Orbit Media');
ok('it appears in the list', screenText().includes('Orbit Media'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
