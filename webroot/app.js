/* VedryxTech Quotations — implementation of the "Vedryx Quotations.dc.html"
 * design file (the source file in Claude Design keeps its original name).
 *
 * The design prototype ran on the Claude Design `dc` runtime (React under the
 * hood, with <sc-if>/<sc-for>/{{ }} templating and a DCLogic class). This is the
 * same app as plain DOM: one state tree, derived values computed per render,
 * and real event listeners. Behaviour and visual design are ported 1:1 except
 * where noted in README.md.
 */
'use strict';

/* ------------------------------------------------------------------ config */
/* Was the prototype's data-props block. Currency is now per-document — the
   default here is only used when a fresh blank doc is created; the editor
   dropdown lets the user pick per quotation / invoice so a UK client gets £
   and a UAE client gets AED. */
const CONFIG = {
  accentColor: '#14171F',   // '#14171F' | '#1A4BF0' | '#0F7B5A' | '#B3521E'
  currency: 'USD',          // default currency for new docs (ISO 4217)
  defaultTax: 18,           // 0–30 (%)
};

/* Six ISO 4217 codes the picker offers. Kept in sync with server.js:CURRENCIES.
   Order matches the dropdown order. `symbol` is only for the option label —
   the actual money formatting uses Intl.NumberFormat, which chooses the
   correct symbol + decimals per code (JPY: 0dp, others: 2dp). */
const CURRENCIES = [
  { code: 'USD', symbol: '$',   label: '$ USD' },
  { code: 'INR', symbol: '₹',   label: '₹ INR' },
  { code: 'EUR', symbol: '€',   label: '€ EUR' },
  { code: 'AED', symbol: 'AED', label: 'AED' },
  { code: 'GBP', symbol: '£',   label: '£ GBP' },
  { code: 'JPY', symbol: '¥',   label: '¥ JPY' },
];
const CURRENCY_CODES = CURRENCIES.map((c) => c.code);
const DEFAULT_CURRENCY = 'USD';
function coerceCurrency(c) {
  const up = String(c || '').toUpperCase();
  return CURRENCY_CODES.includes(up) ? up : DEFAULT_CURRENCY;
}

const THEME_KEY = 'vedryx.theme';

/* ---------------------------------------------------------------- storage */

/* Synchronous first paint from the local mirror; the server is consulted just
   after boot and wins if it answers. See store.js. An empty database is fine —
   the app has no seed content of its own. */
function loadQuotes() {
  return Store.readLocal() || [];
}

/* Mirror locally right away, then push the one changed document to MongoDB.
   Resolves false when the database write did not land; the mirror still holds the
   data and store.js retries it. */
function persist(changed) {
  if (changed) return Store.saveDoc(changed, state.quotes);
  Store.writeLocal(state.quotes);
  return Promise.resolve(true);
}

/* ----------------------------------------------------------------- helpers */

const clone = (v) => JSON.parse(JSON.stringify(v));

/* Format a number as money in the given ISO currency code. Locale is pinned
   to en-US so grouping stays consistent on print / preview / email; the code
   controls symbol + decimals (JPY → "¥1,000", AED → "AED 1,000.00" etc.).
   Falls back to the active draft's currency, then USD, so old callsites still
   work while the codebase moves to explicit passing. */
function money(n, code) {
  const v = Number(n) || 0;
  const currency = coerceCurrency(code ?? state.draft?.currency);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v);
}

/* Local calendar date as YYYY-MM-DD. toISOString() would shift the day for
   anyone east or west of UTC. */
function isoLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

/* ------------------------------------------------------ numeric guardrails */

/* Bounds for every numeric field. Enforced three times over: the input strips
   what you type, blur normalises the field, and the maths clamps again so a bad
   value reaching us from storage or an older save still cannot go negative. */
const NUM_LIMITS = {
  qty:      { min: 0, max: 1e6, step: '1' },
  price:    { min: 0, max: 1e9, step: '0.01' },
  discount: { min: 0, max: 100, step: '0.01' },
  taxRate:  { min: 0, max: 100, step: '0.01' },
};

/* Anything non-finite, negative or unparseable counts as zero. */
function nonNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* A percentage, held to 0–100 so a discount can never exceed the sub-total and
   flip the document total negative. */
function pct(v, max = 100) {
  return Math.min(nonNeg(v), max);
}

/* Strip everything that isn't a plain non-negative decimal. Runs on each
   keystroke, so a minus sign or a pasted "-500" can never land in state. */
function numericText(raw, kind) {
  const lim = NUM_LIMITS[kind];
  let s = String(raw ?? '').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  if (s === '' || s === '.') return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return '';
  if (n > lim.max) return String(lim.max);
  return s;
}

/* Settle a half-typed value ("", ".", "12.") into a real number on blur. */
function numericNormalized(raw, kind) {
  const lim = NUM_LIMITS[kind];
  const s = numericText(raw, kind);
  if (s === '' || s === '.') return String(lim.min);
  const n = Math.min(Math.max(Number(s), lim.min), lim.max);
  return String(Math.round(n * 100) / 100);
}

/* Coerce a document's numerics to clean numbers before it is stored. */
function normalizeDoc(q) {
  q.discount = pct(q.discount);
  q.taxRate = pct(q.taxRate);
  q.number = String(q.number ?? '').trim();
  for (const k of ['name', 'contact', 'email', 'phone', 'address']) {
    q.client[k] = String(q.client[k] ?? '').trim();
  }
  for (const it of q.items || []) {
    it.qty = Math.min(nonNeg(it.qty), NUM_LIMITS.qty.max);
    it.price = Math.min(nonNeg(it.price), NUM_LIMITS.price.max);
    it.service = String(it.service ?? '').trim();
  }
  return q;
}

/* A line with no quantity is a flat price, not price × 0. */
function lineAmount(i) {
  const q = nonNeg(i.qty);
  const p = nonNeg(i.price);
  return q > 0 ? q * p : p;
}

function totals(q) {
  const sub = (q.items || []).reduce((a, i) => a + lineAmount(i), 0);
  const disc = sub * pct(q.discount) / 100;
  const tax = (sub - disc) * pct(q.taxRate) / 100;
  return { sub, disc, tax, total: sub - disc + tax };
}

/* ------------------------------------------------------------- validation */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* Returns a { fieldKey: message } map. Empty means the document is sendable. */
function validateDraft(d) {
  const e = {};
  const noun = isInvoice() ? 'Invoice' : 'Quotation';

  if (!String(d.client.name ?? '').trim()) e.clientName = 'Client name is required.';
  if (!String(d.number ?? '').trim()) e.number = `${noun} number is required.`;
  if (!d.issueDate) e.issueDate = 'Issue date is required.';

  const email = String(d.client.email ?? '').trim();
  if (email && !EMAIL_RE.test(email)) e.clientEmail = 'That does not look like an email address.';

  if (d.issueDate && d.validUntil && d.validUntil < d.issueDate) {
    e.validUntil = `${isInvoice() ? 'Due date' : 'Valid until'} cannot be before the issue date.`;
  }

  const priced = (d.items || []).filter((i) => String(i.service ?? '').trim() && nonNeg(i.price) > 0);
  if (!priced.length) {
    e.items = 'Add at least one service with a name and a rate above zero.';
  } else if (totals(d).total <= 0) {
    e.items = 'The document total must be more than zero.';
  }

  return e;
}

function nextNumber(type) {
  const t = type || state.docType;
  const prefix = t === 'invoice' ? 'INV' : 'QT';
  const year = new Date().getFullYear();
  let max = 0;
  for (const q of state.quotes) {
    if ((q.type || 'quotation') !== t) continue;
    const m = /(\d+)\s*$/.exec(q.number || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${year}-${String(max + 1).padStart(3, '0')}`;
}

function initialsOf(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function blankDoc() {
  const today = new Date();
  const later = new Date(today.getTime() + 30 * 864e5);
  return {
    id: null, type: state.docType === 'invoice' ? 'invoice' : 'quotation',
    number: nextNumber(), status: 'Draft',
    currency: coerceCurrency(CONFIG.currency),
    issueDate: isoLocal(today), validUntil: isoLocal(later),
    client: { name: '', contact: '', email: '', phone: '', address: '' },
    items: [{ id: Date.now(), service: '', description: '', qty: 1, price: 0 }],
    discount: 0, taxRate: Number(CONFIG.defaultTax),
    notes: '20% advance to begin, balance on delivery.\nQuotation valid for 30 days.',
  };
}

/* ------------------------------------------------------------ DOM helper */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  const p = props || {};
  // type must land before value so date/number inputs accept it
  if (p.type) el.setAttribute('type', p.type);
  for (const [k, v] of Object.entries(p)) {
    if (k === 'type' || v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/* -------------------------------------------------------------------- state */

const state = {
  screen: 'home',        // home | list | edit | preview | letter
  docType: 'quotation',  // quotation | invoice | letter
  filter: 'All',         // All | Draft | Sent (quotations/invoices only)
  saved: false,
  editingId: null,       // id of the quotation/invoice being edited
  locked: false,
  numberTouched: false,
  quotes: loadQuotes(),
  draft: null,
  editingLetterId: null, // id of the letter being edited (null = new)
  letterTitle: '',
  letterHTML: null,
  letterSaved: false,
  errors: {},        // fieldKey -> message, from validateDraft
  validated: false,  // messages stay hidden until a send is attempted
  autoSaved: false,  // set when Preview committed a previously unsaved document
  theme: 'light',    // 'light' | 'dark' — persisted to localStorage
  sending: false,    // true while /send is in flight
  sendResult: null,  // { ok, message } surfaced next to the send button
  /* Composer: null when closed. When open, holds the editable TO / SUBJECT /
     MESSAGE the founder can personalise before "Send to client" actually fires.
     Opening is gated on validateDraft(); actual sending happens from the
     confirmSendFromComposer path so the composer is guaranteed to be the only
     path to /api/documents/:id/send from the UI. */
  composer: null,
  composerEmailError: null,  // inline "not an email" message inside the modal
};

function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  render();
}

/* Mutate the draft in place; totals refresh without rebuilding the form so the
   caret and focus survive typing. */
function setDraft(fn, { rerender = false } = {}) {
  if (!state.draft) state.draft = blankDoc();
  fn(state.draft);
  state.saved = false;
  if (rerender) render();
  else refreshDerived();
}

/* ------------------------------------------------------------------- routing */

const isInvoice = () => state.docType === 'invoice';
const isLetter  = () => state.docType === 'letter';
const listTitle = () => (isLetter() ? 'Letterhead' : isInvoice() ? 'Invoices' : 'Quotations');

const goHome = () => setState({ screen: 'home', locked: false });
const goList = () => setState({ screen: 'list', locked: false });

function openType(type) {
  setState({ docType: type, screen: 'list', filter: 'All', locked: false });
}

function newQuote() {
  state.draft = null;
  setState({
    draft: blankDoc(), editingId: null, screen: 'edit', saved: false,
    numberTouched: false, locked: false, errors: {}, validated: false,
    sendResult: null, sending: false,
  });
}

function newLetter() {
  setState({
    screen: 'letter', docType: 'letter',
    editingLetterId: null, letterTitle: '', letterHTML: null, letterSaved: false,
  });
}

/* Router used by the topbar "New" button and empty-state CTAs. */
function newDoc() {
  if (isLetter()) return newLetter();
  return newQuote();
}

function openDoc(q) {
  if (q.type === 'letter') return openLetter(q);
  const lock = !isInvoice() && q.status === 'Sent';
  setState({
    draft: clone(q), editingId: q.id, saved: false,
    numberTouched: true, locked: lock,
    screen: lock ? 'preview' : 'edit',
    errors: {}, validated: false,
    sendResult: null, sending: false,
  });
}

function openLetter(q) {
  setState({
    screen: 'letter', docType: 'letter',
    editingLetterId: q.id, letterTitle: q.title || '', letterHTML: q.html || '',
    letterSaved: false,
  });
}

function upsert(q) {
  const list = state.quotes.slice();
  const i = list.findIndex((x) => x.id === q.id && x.id != null);
  if (i >= 0) list[i] = q;
  else { q.id = Date.now(); list.push(q); }
  return list;
}

/* The single write path. Every route that commits a document — Save, Preview and
   Send to client — goes through here, so none of them can navigate away without
   the document being stored.
 *
 * The list and the screen update immediately; the database write is confirmed
 * afterwards so the UI never blocks on the network. If it fails, store.js queues
 * a retry and the offline indicator appears. */
function commit(q, patch) {
  state.quotes = upsert(q);                 // assigns q.id when the doc is new
  setState({ draft: q, editingId: q.id, ...patch });
  return persist(q).then((ok) => {
    if (!ok) {
      // Surface the failure without disturbing a form the user may be typing in.
      if (state.screen === 'list') render();
      else renderTopbar();
    }
    return ok;
  });
}

/* Saving a draft stays permissive — a half-filled draft is a legitimate thing to
   keep. Numbers are still normalised so nothing negative reaches storage. */
function saveQuote() {
  const q = normalizeDoc(clone(state.draft || blankDoc()));
  q.status = q.status === 'Sent' ? 'Sent' : 'Draft';
  commit(q, { saved: true, autoSaved: false });
}

/* Worth persisting? A document nobody has typed anything into is not. */
function isSubstantive(d) {
  if (String(d.client.name ?? '').trim()) return true;
  return (d.items || []).some((i) => String(i.service ?? '').trim() || nonNeg(i.price) > 0);
}

/* Previewing an unsaved document commits it as a draft first, so opening the
   preview can never be a way to lose work. Blank documents are left alone. */
function goPreview() {
  const d = state.draft || blankDoc();
  if (!isSubstantive(d)) {
    setState({ screen: 'preview', autoSaved: false });
    return;
  }
  const wasUnsaved = d.id == null;
  const q = normalizeDoc(clone(d));
  q.status = q.status === 'Sent' ? 'Sent' : 'Draft';
  commit(q, { screen: 'preview', saved: false, autoSaved: wasUnsaved });
}

/* Kicks off the send flow. Validates the document first (same rules as
   before), then opens the composer modal — the founder can personalise TO /
   SUBJECT / MESSAGE and only then does the real /send fire. Nothing is
   committed or emailed by clicking "Send to client" alone. */
function sendQuote() {
  const d = state.draft || blankDoc();
  const errors = validateDraft(d);
  if (Object.keys(errors).length) {
    setState({ errors, validated: true, screen: 'edit', locked: false });
    focusFirstError();
    return;
  }
  openComposer();
}

/* Suggested default body per doc type. Founder can rewrite anything before
   sending; kept short so it reads like a personal note, not a template. */
function defaultComposerBody(d) {
  const type = d.type === 'invoice' ? 'invoice' : 'quotation';
  const greeting = d.client?.name ? `Hi ${d.client.name},` : 'Hi,';
  return `${greeting}\n\nPlease find the attached ${type} for your review. Let me know if you have any questions.\n\nRegards,\nVedryx`;
}

function defaultComposerSubject(d) {
  const noun = d.type === 'invoice' ? 'Invoice' : 'Quotation';
  return `${noun} ${d.number || ''} from Vedryx`.replace(/\s+/g, ' ').trim();
}

function openComposer() {
  const d = state.draft;
  state.composer = {
    to: String(d.client?.email || '').trim(),
    subject: defaultComposerSubject(d),
    body: defaultComposerBody(d),
  };
  state.composerEmailError = null;
  state.sendResult = null;
  render();
}

function closeComposer() {
  state.composer = null;
  state.composerEmailError = null;
  render();
}

/* Called by the composer's Send button. Everything the server needs (to /
   subject / body) is captured here; the document itself is committed as Sent
   at the same moment so that the doc the server looks up matches what the
   user saw when they hit Send. */
function confirmSendFromComposer() {
  const c = state.composer;
  if (!c) return;
  const to = String(c.to || '').trim();
  if (!EMAIL_RE.test(to)) {
    state.composerEmailError = 'That does not look like an email address.';
    render();
    return;
  }
  state.composerEmailError = null;

  const d = state.draft || blankDoc();
  const q = normalizeDoc(clone(d));
  q.status = 'Sent';
  if (!state.numberTouched) q.number = q.number || nextNumber();

  state.sending = true;
  state.sendResult = null;
  state.composer = null;
  render();

  commit(q, {
    screen: 'list', filter: 'Sent', locked: false,
    errors: {}, validated: false, autoSaved: false,
  }).then((ok) => {
    if (!ok) {
      state.sending = false;
      state.sendResult = { ok: false, message: `Saved locally, but the database is offline — email skipped.` };
      render();
      return;
    }
    return sendDocEmail(q.id, {
      to,
      subject: String(c.subject || '').trim(),
      body: String(c.body || ''),
    }).then((res) => {
      state.sending = false;
      state.sendResult = res;
      render();
    });
  });
}

/* POST /api/documents/:id/send with the composer values. Returns
   { ok, message } — never throws. */
function sendDocEmail(id, payload) {
  return fetch(`/api/documents/${id}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }).then((r) => r.json().then((body) => ({ status: r.status, body })))
    .then(({ status, body }) => {
      if (status >= 200 && status < 300 && body && body.sent) {
        return { ok: true, message: `Sent to ${body.to}${body.cc ? ` (cc ${body.cc})` : ''}.` };
      }
      const detail = body && (body.error || body.detail) || `HTTP ${status}`;
      return { ok: false, message: `Could not send email: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` };
    })
    .catch((err) => ({ ok: false, message: `Could not reach the email service: ${err.message}` }));
}

function focusFirstError() {
  for (const key of ERROR_ORDER) {
    const ref = derived.errorNodes[key];
    if (state.errors[key] && ref && ref.input) { ref.input.focus(); return; }
  }
}

function duplicateQuote() {
  const q = clone(state.draft || blankDoc());
  q.id = null; q.status = 'Draft'; q.number = nextNumber();
  setState({
    draft: q, editingId: null, locked: false, numberTouched: false,
    screen: 'edit', saved: false, errors: {}, validated: false,
    sendResult: null, sending: false,
  });
}

function invoiceFrom(src) {
  const q = clone(src);
  const today = new Date();
  q.id = null;
  q.type = 'invoice';
  q.status = 'Draft';
  q.issueDate = isoLocal(today);
  q.validUntil = isoLocal(new Date(today.getTime() + 14 * 864e5));
  q.notes = `Raised against ${src.number || 'quotation'}.` + (src.notes ? `\n${src.notes}` : '');
  // docType must flip before nextNumber() reads it
  state.docType = 'invoice';
  q.number = nextNumber('invoice');
  setState({
    draft: q, editingId: null, numberTouched: false, locked: false, saved: false,
    screen: 'edit', filter: 'All', errors: {}, validated: false,
    sendResult: null, sending: false,
  });
}

/* ------------------------------------------------------------------ theme */

function applyTheme(mode) {
  const t = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  return t;
}

function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  state.theme = applyTheme(next);
  try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* private mode */ }
  render();
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  const prefersDark = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  state.theme = applyTheme(stored || (prefersDark ? 'dark' : 'light'));
}

/* Full sign-out: clears the httpOnly session cookie server-side, then wipes ALL
   client-side state — localStorage (theme + the document mirror), sessionStorage,
   and every JS-readable cookie — so nothing (including cached docs) survives into
   the next session. Then reloads; the gate serves the login screen. No-op-safe
   when the app runs without a password. */
async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  try { localStorage.clear(); } catch { /* private mode */ }
  try { sessionStorage.clear(); } catch { /* private mode */ }
  try {
    // The vq_session cookie is httpOnly (cleared above by /api/logout); this
    // expires any remaining JS-visible cookies for this origin.
    for (const c of document.cookie.split(';')) {
      const name = c.split('=')[0].trim();
      if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }
  } catch { /* ignore */ }
  window.location.reload();
}

/* --------------------------------------------------------------- top bar */

function renderTopbar() {
  const showChrome = ['list', 'edit', 'preview'].includes(state.screen);
  const store = Store.status();
  const themeBtn = h('button', {
    class: 'btn-icon theme-toggle',
    title: state.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
    'aria-label': state.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
    onclick: toggleTheme,
    text: state.theme === 'dark' ? '☀' : '☾',
  });
  const inner = h('div', { class: 'topbar-inner' },
    h('img', { class: 'topbar-logo topbar-logo-light', src: 'assets/logo.svg', alt: 'VedryxTech', onclick: goHome }),
    h('img', { class: 'topbar-logo topbar-logo-dark', src: 'assets/logo-dark.svg', alt: 'VedryxTech', onclick: goHome }),
    h('div', { class: 'spacer' }),
    store.error && !store.online && h('span', {
      class: 'offline-pill',
      title: `MongoDB unreachable: ${store.error}\nSaved in this browser; queued to sync.`,
      text: store.pending
        ? `Offline — ${store.pending} not in database`
        : 'Offline — saved locally',
    }),
    themeBtn,
    h('button', {
      class: 'btn-icon',
      title: 'Sign out',
      'aria-label': 'Sign out',
      onclick: logout,
      text: '⎋',
    }),
    showChrome && h('button', { class: 'btn-ghost', onclick: goList, text: listTitle() }),
    showChrome && h('button', { class: 'btn-dark', onclick: newDoc, text: 'New' }),
    state.screen === 'letter' && h('button', { class: 'btn-outline', onclick: goHome, text: 'All tools' }),
  );
  const bar = document.getElementById('topbar');
  bar.replaceChildren(inner);
}

/* ------------------------------------------------------------------- home */

function renderHome() {
  const count = (t) => state.quotes.filter((q) => (q.type || 'quotation') === t).length;
  const letters = count('letter');

  const card = (badge, name, desc, foot, onclick) => h('button', { class: 'tool-card', onclick },
    h('div', { class: 'tool-badge', text: badge }),
    h('div', { class: 'spacer' }),
    h('div', { class: 'tool-name', text: name }),
    h('div', { class: 'tool-desc', text: desc }),
    h('div', { class: 'tool-count', text: foot }),
  );

  return h('div', { class: 'home' },
    h('h1', { text: 'What are you making?' }),
    h('p', { class: 'home-sub', text: 'Pick a document type to start.' }),
    h('div', { class: 'home-grid' },
      card('Q', 'Quotation', 'Price a scope of work for a client. Locks once sent.',
        `${count('quotation')} saved`, () => openType('quotation')),
      card('I', 'Invoice', 'Bill a client. Raise one from a sent quotation in a click, and edit it any time.',
        `${count('invoice')} saved`, () => openType('invoice')),
      card('L', 'Letterhead', 'Write on branded paper. Full text formatting, nothing else to fill in.',
        letters ? `${letters} saved` : 'Blank sheet', () => openType('letter')),
    ),
  );
}

/* ------------------------------------------------------------------- list */

function renderList() {
  if (isLetter()) return renderLetterList();

  const ofType = state.quotes.filter((q) => (q.type || 'quotation') === state.docType);
  const visible = ofType.filter((q) => state.filter === 'All' || q.status === state.filter).slice().reverse();
  const outstanding = ofType.filter((q) => q.status === 'Sent').reduce((a, q) => a + totals(q).total, 0);

  const filters = h('div', { class: 'filters' },
    ['All', 'Draft', 'Sent'].map((f) => h('button', {
      class: 'chip-filter' + (state.filter === f ? ' is-active' : ''),
      onclick: () => setState({ filter: f }),
      text: f,
    })),
  );

  const rows = h('div', { class: 'rows' }, visible.map((q) => {
    const name = q.client.name || 'Untitled client';
    const canInvoice = !isInvoice() && q.status === 'Sent';
    return h('div', {
      class: 'row', role: 'button', tabindex: '0',
      onclick: () => openDoc(q),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDoc(q); }
      },
    },
      h('div', { class: 'row-avatar', text: initialsOf(name) }),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-client', text: name }),
        h('div', { class: 'row-meta', text: `${q.number} · ${fmtDate(q.issueDate)}` }),
      ),
      h('div', { class: 'row-right' },
        /* Each row is formatted in its own document's currency, so a mixed
           list (£, ₹, $) shows the right symbol per row. */
        h('div', { class: 'row-amount', text: money(totals(q).total, q.currency) }),
        h('div', { class: 'chip ' + (q.status === 'Sent' ? 'chip-sent' : 'chip-draft'), text: q.status }),
      ),
      canInvoice && h('button', {
        class: 'btn-invoice',
        text: 'Invoice',
        onclick: (e) => { e.stopPropagation(); invoiceFrom(q); },
      }),
    );
  }));

  const empty = visible.length === 0 && h('div', { class: 'empty' },
    h('div', { class: 'empty-title', text: `No ${listTitle().toLowerCase()} here yet` }),
    h('div', { class: 'empty-sub', text: 'Create one and it will show up in this list.' }),
    h('button', { class: 'btn-dark', onclick: newQuote, text: `New ${isInvoice() ? 'invoice' : 'quotation'}` }),
  );

  const store = Store.status();
  const syncNote = store.pending > 0 && h('div', {
    class: 'sync-note no-print',
    text: store.pending === 1
      ? 'One document is saved on this device only — it will sync to MongoDB automatically when the connection returns.'
      : `${store.pending} documents are saved on this device only — they will sync to MongoDB automatically when the connection returns.`,
  });

  return h('div', { class: 'list' },
    syncNote,
    h('div', { class: 'list-head' },
      h('div', null,
        h('h1', { text: listTitle() }),
        h('p', { class: 'list-sub', text: `${ofType.length} total · ${visible.length} shown` }),
      ),
      h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label', text: 'Outstanding' }),
          /* Mixed-currency sum is ambiguous — we render the raw numeric total
             in USD as a rough scoreboard. Not an FX-converted figure; each
             individual document still shows its own currency in the rows
             above. Revisit if a real multi-currency dashboard is needed. */
          h('div', { class: 'stat-value', text: money(outstanding, 'USD') }),
        ),
      ),
    ),
    filters,
    rows,
    empty,
  );
}

/* Simpler list for letters: no amounts, no filter chips, no lifecycle. */
function renderLetterList() {
  const letters = state.quotes
    .filter((q) => q.type === 'letter')
    .slice()
    .sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''))
    .reverse();

  const rows = h('div', { class: 'rows' }, letters.map((q) => h('div', {
    class: 'row', role: 'button', tabindex: '0',
    onclick: () => openLetter(q),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLetter(q); }
    },
  },
    h('div', { class: 'row-avatar', text: initialsOf(q.title || 'Letter') }),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-client', text: q.title || 'Untitled letter' }),
      h('div', { class: 'row-meta', text: q.updatedAt ? `Updated ${fmtDate(q.updatedAt.slice(0, 10))}` : 'New' }),
    ),
  )));

  const empty = letters.length === 0 && h('div', { class: 'empty' },
    h('div', { class: 'empty-title', text: 'No letterheads here yet' }),
    h('div', { class: 'empty-sub', text: 'Write one and it will show up in this list.' }),
    h('button', { class: 'btn-dark', onclick: newLetter, text: 'New letterhead' }),
  );

  return h('div', { class: 'list' },
    h('div', { class: 'list-head' },
      h('div', null,
        h('h1', { text: 'Letterhead' }),
        h('p', { class: 'list-sub', text: `${letters.length} total` }),
      ),
    ),
    rows,
    empty,
  );
}

/* ------------------------------------------------------------------- edit */

/* Nodes whose text is recomputed on every keystroke. */
const derived = {
  lineAmounts: [], subTotal: null, discountRow: null, discountLabel: null,
  discountText: null, taxLabel: null, taxText: null, total: null,
  errorNodes: {}, itemsError: null, banner: null,
};

/* Focus order when a send is blocked — matches the visual order of the form. */
const ERROR_ORDER = ['clientName', 'clientEmail', 'number', 'issueDate', 'validUntil', 'items'];

function setInvalid(input, bad) {
  if (!input) return;
  const base = (input.className || '').replace(/\s*is-invalid\b/g, '');
  input.className = bad ? `${base} is-invalid` : base;
}

function refreshDerived() {
  const d = state.draft;
  if (!d || state.screen !== 'edit') return;
  const t = totals(d);
  const cur = coerceCurrency(d.currency);

  d.items.forEach((it, i) => {
    const node = derived.lineAmounts[i];
    if (node) node.textContent = money(lineAmount(it), cur);
  });

  if (derived.subTotal) derived.subTotal.textContent = money(t.sub, cur);
  if (derived.discountRow) {
    const show = pct(d.discount) > 0;
    derived.discountRow.style.display = show ? '' : 'none';
    if (show) {
      derived.discountLabel.textContent = `Discount (${pct(d.discount)}%)`;
      derived.discountText.textContent = '−' + money(t.disc, cur);
    }
  }
  if (derived.taxLabel) derived.taxLabel.textContent = `Tax (${pct(d.taxRate)}%)`;
  if (derived.taxText) derived.taxText.textContent = money(t.tax, cur);
  if (derived.total) derived.total.textContent = money(t.total, cur);

  refreshErrors();

  // "Saved" note is stale the moment anything changes
  const note = document.getElementById('saved-note');
  if (note) note.remove();
}

/* Once a send has been attempted, messages clear themselves as fields are fixed. */
function refreshErrors() {
  if (!state.validated || !state.draft) return;
  state.errors = validateDraft(state.draft);

  for (const [key, ref] of Object.entries(derived.errorNodes)) {
    const msg = state.errors[key] || '';
    ref.node.textContent = msg;
    ref.node.style.display = msg ? '' : 'none';
    setInvalid(ref.input, !!msg);
  }

  if (derived.itemsError) {
    const msg = state.errors.items || '';
    derived.itemsError.textContent = msg;
    derived.itemsError.style.display = msg ? '' : 'none';
  }

  if (derived.banner) {
    const msgs = Object.values(state.errors);
    derived.banner.replaceChildren();
    derived.banner.style.display = msgs.length ? '' : 'none';
    if (msgs.length) {
      derived.banner.append(
        h('div', { text: `Cannot send yet — ${msgs.length} ${msgs.length === 1 ? 'problem' : 'problems'} to fix:` }),
        h('ul', null, msgs.map((m) => h('li', { text: m }))),
      );
    }
  }
}

function field(labelText, inputEl, opts = {}) {
  const { extraClass, errKey } = opts;
  const kids = [h('span', { class: 'lbl-text', text: labelText }), inputEl];

  if (errKey) {
    const msg = state.validated ? (state.errors[errKey] || '') : '';
    const node = h('div', { class: 'field-error', text: msg, style: msg ? '' : 'display:none' });
    setInvalid(inputEl, !!msg);
    derived.errorNodes[errKey] = { node, input: inputEl };
    kids.push(node);
  }

  return h('label', { class: 'lbl' + (extraClass ? ' ' + extraClass : '') }, ...kids);
}

/* A number field that cannot hold a negative value: the minus, plus and
   exponent keys are swallowed, each keystroke is re-stripped (which also covers
   paste and drag-drop), and blur settles a partial entry into a real number. */
function numericInput(kind, value, apply, cls = 'inp') {
  const lim = NUM_LIMITS[kind];
  return h('input', {
    class: cls, type: 'number', value,
    min: String(lim.min), max: String(lim.max), step: lim.step, inputmode: 'decimal',
    onkeydown: (e) => { if (['-', '+', 'e', 'E'].includes(e.key)) e.preventDefault(); },
    oninput: (e) => {
      const fixed = numericText(e.target.value, kind);
      if (fixed !== e.target.value) e.target.value = fixed;
      apply(fixed);
    },
    onblur: (e) => {
      const norm = numericNormalized(e.target.value, kind);
      if (norm !== e.target.value) e.target.value = norm;
      apply(norm);
    },
  });
}

function renderEdit() {
  if (!state.draft) state.draft = blankDoc();
  const d = state.draft;
  const t = totals(d);
  derived.lineAmounts = [];
  derived.errorNodes = {};
  derived.itemsError = null;
  derived.banner = null;

  const onClient = (key) => (e) => { const v = e.target.value; setDraft((x) => { x.client[key] = v; }); };
  const onField = (key) => (e) => { const v = e.target.value; setDraft((x) => { x[key] = v; }); };

  /* ---- client */
  const clientCard = h('div', { class: 'card' },
    h('div', { class: 'card-title', text: 'Client' }),
    h('div', { class: 'field-grid' },
      field('Client name',
        h('input', { class: 'inp', value: d.client.name, placeholder: 'Really Great Company', maxlength: '120', oninput: onClient('name') }),
        { errKey: 'clientName' }),
      field('Contact person',
        h('input', { class: 'inp', value: d.client.contact, placeholder: 'Avery Shaw', maxlength: '120', oninput: onClient('contact') })),
      field('Email',
        h('input', { class: 'inp', type: 'email', value: d.client.email, placeholder: 'avery@company.com', maxlength: '160', autocomplete: 'off', oninput: onClient('email') }),
        { errKey: 'clientEmail' }),
      field('Phone',
        h('input', { class: 'inp', type: 'tel', value: d.client.phone, placeholder: '+91 98765 43210', maxlength: '32', oninput: onClient('phone') })),
    ),
    field('Billing address',
      h('textarea', { class: 'inp', rows: '2', placeholder: '123 Anywhere St, Any City', maxlength: '400', oninput: onClient('address') }, d.client.address),
      { extraClass: 'stacked' }),
  );

  /* ---- document details */
  const currentCurrency = coerceCurrency(d.currency);
  const currencySelect = h('select', {
    class: 'inp', 'aria-label': 'Currency',
    /* Per-document currency: changing it re-formats live totals + the emailed
       copy. Re-render (not just refreshDerived) so the new symbol / decimals
       propagate through every money() callsite on the form. */
    onchange: (e) => { const v = e.target.value; setDraft((x) => { x.currency = coerceCurrency(v); }, { rerender: true }); },
  }, CURRENCIES.map((c) => h('option', { value: c.code, text: c.label })));
  /* Set .value after options are appended so the browser (and the DOM shim
     used by render-test.js) both pick the right one. */
  currencySelect.value = currentCurrency;

  const detailsCard = h('div', { class: 'card' },
    h('div', { class: 'card-title', text: isInvoice() ? 'Invoice details' : 'Quotation details' }),
    h('div', { class: 'field-grid' },
      field(isInvoice() ? 'Invoice no.' : 'Quotation no.',
        h('input', {
          class: 'inp', value: d.number, maxlength: '40',
          oninput: (e) => { const v = e.target.value; state.numberTouched = true; setDraft((x) => { x.number = v; }); },
        }),
        { errKey: 'number' }),
      field('Issue date',
        h('input', { class: 'inp', type: 'date', value: d.issueDate, oninput: onField('issueDate') }),
        { errKey: 'issueDate' }),
      field(isInvoice() ? 'Due date' : 'Valid until',
        h('input', { class: 'inp', type: 'date', value: d.validUntil, min: d.issueDate || null, oninput: onField('validUntil') }),
        { errKey: 'validUntil' }),
      field('Currency', currencySelect),
    ),
  );

  /* ---- line items */
  const cur = coerceCurrency(d.currency);
  const itemNodes = d.items.map((it, i) => {
    const amount = h('div', { class: 'item-amount-value', text: money(lineAmount(it), cur) });
    derived.lineAmounts[i] = amount;
    const hasQty = nonNeg(it.qty) > 0;

    return h('div', { class: 'item' },
      h('div', { class: 'item-top' },
        h('input', {
          class: 'item-service', value: it.service, placeholder: 'Service name', maxlength: '120',
          oninput: (e) => { const v = e.target.value; setDraft((x) => { x.items[i].service = v; }); },
        }),
        h('button', {
          class: 'item-remove', title: 'Remove line', text: '×',
          onclick: () => setDraft((x) => { if (x.items.length > 1) x.items.splice(i, 1); }, { rerender: true }),
        }),
      ),
      h('textarea', {
        class: 'item-desc', rows: '2', placeholder: 'Short description of what is included', maxlength: '400',
        oninput: (e) => { const v = e.target.value; setDraft((x) => { x.items[i].description = v; }); },
      }, it.description),
      h('div', { class: 'item-nums' },
        hasQty && h('label', { class: 'lbl' },
          h('span', { class: 'lbl-text sm', text: 'Qty' }),
          numericInput('qty', it.qty, (v) => setDraft((x) => { x.items[i].qty = v; }), 'inp sm'),
        ),
        h('label', { class: 'lbl' },
          h('span', { class: 'lbl-text sm', text: 'Rate' }),
          numericInput('price', it.price, (v) => setDraft((x) => { x.items[i].price = v; }), 'inp sm'),
        ),
        h('div', { class: 'item-amount' },
          h('div', { class: 'item-amount-label', text: 'Amount' }),
          amount,
        ),
      ),
      !hasQty && h('button', {
        class: 'btn-link', text: 'Add quantity',
        onclick: () => setDraft((x) => { x.items[i].qty = 1; }, { rerender: true }),
      }),
    );
  });

  const itemsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title', text: 'Services' }),
      h('button', {
        class: 'btn-soft', text: '+ Add line',
        onclick: () => setDraft((x) => {
          x.items.push({ id: Date.now(), service: '', description: '', qty: 1, price: 0 });
        }, { rerender: true }),
      }),
    ),
    h('div', { class: 'items' }, itemNodes),
    derived.itemsError = h('div', {
      class: 'field-error',
      text: state.validated ? (state.errors.items || '') : '',
      style: state.validated && state.errors.items ? '' : 'display:none',
    }),
  );

  /* ---- other info */
  const otherCard = h('div', { class: 'card' },
    h('div', { class: 'card-title', text: 'Other info' }),
    h('div', { class: 'field-grid narrow' },
      field('Discount (%)', numericInput('discount', d.discount, (v) => setDraft((x) => { x.discount = v; }))),
      field('Tax / GST (%)', numericInput('taxRate', d.taxRate, (v) => setDraft((x) => { x.taxRate = v; }))),
    ),
    field('Notes & terms',
      h('textarea', { class: 'inp notes', rows: '3', placeholder: 'Payment terms, delivery timeline, assumptions…', maxlength: '2000', oninput: onField('notes') }, d.notes),
      { extraClass: 'stacked' }),
  );

  /* ---- totals rail */
  derived.subTotal = h('span', { text: money(t.sub, cur) });
  derived.discountLabel = h('span', { text: `Discount (${pct(d.discount)}%)` });
  derived.discountText = h('span', { text: '−' + money(t.disc, cur) });
  derived.taxLabel = h('span', { text: `Tax (${pct(d.taxRate)}%)` });
  derived.taxText = h('span', { text: money(t.tax, cur) });
  derived.total = h('span', { class: 'total-grand-value', text: money(t.total, cur) });

  derived.discountRow = h('div', {
    class: 'total-row',
    style: pct(d.discount) > 0 ? '' : 'display:none',
  }, derived.discountLabel, derived.discountText);

  const problems = state.validated ? Object.values(state.errors) : [];
  derived.banner = h('div', {
    class: 'error-note',
    style: problems.length ? '' : 'display:none',
    role: 'alert',
  }, problems.length ? [
    h('div', { text: `Cannot send yet — ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} to fix:` }),
    h('ul', null, problems.map((m) => h('li', { text: m }))),
  ] : []);

  const rail = h('div', { class: 'rail' },
    h('div', { class: 'card' },
      h('div', { class: 'total-row' }, h('span', { text: 'Sub-total' }), derived.subTotal),
      derived.discountRow,
      h('div', { class: 'total-row ruled' }, derived.taxLabel, derived.taxText),
      h('div', { class: 'total-grand' },
        h('span', { class: 'total-grand-label', text: 'Total' }),
        derived.total,
      ),
    ),
    derived.banner,
    h('div', { class: 'rail-actions' },
      h('button', { class: 'btn-outline', text: 'Preview', onclick: goPreview }),
      h('button', { class: 'btn-dark', text: `Save ${isInvoice() ? 'invoice' : 'quotation'}`, onclick: saveQuote }),
    ),
    state.saved && h('div', { class: 'saved-note', id: 'saved-note', text: 'Saved to your quotations list.' }),
  );

  return h('div', { class: 'edit' },
    h('div', { class: 'edit-col' },
      h('div', { class: 'edit-title-row' },
        h('button', { class: 'btn-back', onclick: goList, text: '←', title: 'Back to list' }),
        h('h1', { text: `${state.editingId ? 'Edit ' : 'New '}${isInvoice() ? 'invoice' : 'quotation'}` }),
      ),
      clientCard, detailsCard, itemsCard, otherCard,
    ),
    rail,
  );
}

/* ---------------------------------------------------------------- preview */

function renderPreview() {
  if (!state.draft) state.draft = blankDoc();
  const d = state.draft;
  const t = totals(d);
  const hasDiscount = pct(d.discount) > 0;
  const cur = coerceCurrency(d.currency);

  const docItems = d.items
    .filter((i) => i.service || nonNeg(i.price) > 0)
    .map((it) => ({
      service: it.service || 'Untitled service',
      description: it.description || '',
      qtyLine: nonNeg(it.qty) > 1 ? `${nonNeg(it.qty)} × ${money(it.price, cur)}` : '',
      amountText: money(lineAmount(it), cur),
    }));

  const clientBlock = [d.client.contact, d.client.email, d.client.phone, d.client.address]
    .filter(Boolean).join('\n');

  const canEmail = EMAIL_RE.test(String(d.client.email || '').trim());

  const sendButton = !state.locked && h('button', {
    class: 'btn-dark',
    text: state.sending ? 'Sending…' : 'Send to client',
    disabled: state.sending || !canEmail,
    title: canEmail ? 'Send this document by email' : 'Add a valid client email address to enable sending.',
    onclick: sendQuote,
  });

  const bar = h('div', { class: 'preview-bar no-print' },
    h('button', {
      class: 'btn-back', text: '←', title: 'Back',
      onclick: () => setState((s) => ({ screen: s.locked ? 'list' : 'edit', locked: false })),
    }),
    h('h1', { text: state.locked ? 'Sent quotation' : 'Preview' }),
    h('button', { class: 'btn-outline', text: 'Download PDF', onclick: () => window.print() }),
    sendButton,
    state.locked && h('button', { class: 'btn-outline', text: 'Duplicate as draft', onclick: duplicateQuote }),
    state.locked && h('button', { class: 'btn-dark', text: 'Create invoice', onclick: () => invoiceFrom(d) }),
  );

  const sheet = h('div', { class: 'doc-sheet' },
    h('div', { class: 'doc-head' },
      h('div', { class: 'doc-stripes' }),
      h('div', { class: 'doc-tab' }),
      h('div', { class: 'doc-head-row' },
        h('img', { class: 'doc-logo', src: 'assets/logo.svg', alt: 'VedryxTech' }),
        h('div', { style: 'text-align:right' }, h('div', { class: 'doc-number', text: d.number })),
      ),
      h('h2', { class: 'doc-title', text: isInvoice() ? 'INVOICE' : 'QUOTATION' }),
      h('div', { class: 'doc-rule' }),
    ),
    h('div', { class: 'doc-meta' },
      h('div', null,
        h('div', { class: 'doc-label', text: 'BILLED TO' }),
        h('div', { class: 'doc-client-name', text: d.client.name || 'Client name' }),
        h('div', { class: 'doc-client-block', text: clientBlock || 'Add client details in the form' }),
      ),
      h('div', null,
        h('div', { class: 'doc-label', text: 'DATE' }),
        h('div', { class: 'doc-date', text: fmtDate(d.issueDate) }),
        h('div', { class: 'doc-label spaced', text: isInvoice() ? 'DUE DATE' : 'VALID UNTIL' }),
        h('div', { class: 'doc-date', text: fmtDate(d.validUntil) }),
      ),
    ),
    h('div', { class: 'doc-items' },
      h('div', { class: 'doc-items-head' },
        h('span', { text: 'DESCRIPTION' }),
        h('span', { text: 'AMOUNT' }),
      ),
      docItems.map((di) => h('div', { class: 'doc-item' },
        h('div', { style: 'min-width:0' },
          h('div', { class: 'doc-item-service', text: di.service }),
          di.description && h('div', { class: 'doc-item-desc', text: di.description }),
          di.qtyLine && h('div', { class: 'doc-item-qty', text: di.qtyLine }),
        ),
        h('div', { class: 'doc-item-amount', text: di.amountText }),
      )),
    ),
    h('div', { class: 'doc-totals' },
      h('div', { class: 'doc-totals-inner' },
        h('div', { class: 'doc-total-row' }, h('span', { text: 'Sub-Total' }), h('span', { text: money(t.sub, cur) })),
        hasDiscount && h('div', { class: 'doc-total-row' },
          h('span', { text: `Discount (${pct(d.discount)}%)` }),
          h('span', { text: '−' + money(t.disc, cur) }),
        ),
        h('div', { class: 'doc-total-row' },
          h('span', { text: `Tax (${pct(d.taxRate)}%)` }),
          h('span', { text: money(t.tax, cur) }),
        ),
        h('div', { class: 'doc-grand' },
          h('span', { class: 'doc-grand-label', text: 'TOTAL' }),
          h('span', { class: 'doc-grand-value', text: money(t.total, cur) }),
        ),
      ),
    ),
    h('div', { class: 'doc-notes' },
      h('div', { class: 'doc-label', text: 'NOTES & TERMS' }),
      h('div', { class: 'doc-notes-body', text: d.notes || '—' }),
    ),
    h('div', { class: 'doc-foot' },
      h('div', { class: 'doc-foot-stripes' }),
      h('div', { class: 'doc-foot-mail', text: 'hello@vedryxtech.com' }),
      h('div', { class: 'doc-foot-brand', text: 'VEDRYXTECH' }),
    ),
  );

  const sendNote = state.sendResult && h('div', {
    class: (state.sendResult.ok ? 'saved-note' : 'error-note') + ' no-print',
    style: 'margin-bottom:16px',
    text: state.sendResult.message,
  });

  const emailHint = !state.locked && !canEmail && h('div', {
    class: 'sync-note no-print',
    style: 'margin-bottom:16px',
    text: 'Add a valid client email address to enable "Send to client".',
  });

  return h('div', { class: 'preview' },
    bar,
    state.autoSaved && !state.locked && h('div', {
      class: 'saved-note no-print',
      style: 'margin-bottom:16px',
      text: `Auto-saved as a draft (${d.number}) so nothing is lost.`,
    }),
    sendNote,
    emailHint,
    state.locked && h('div', {
      class: 'locked-note no-print',
      text: `Sent on ${fmtDate(d.issueDate)} — locked. Duplicate it as a draft to make changes.`,
    }),
    sheet,
    state.composer && renderComposer(),
  );
}

/* Compose screen: a modal overlay that opens over Preview when the founder
   hits "Send to client". TO / SUBJECT / MESSAGE are all editable. Send here
   is what actually triggers /api/documents/:id/send — clicking outside or
   Cancel closes without doing anything. Sending state and result show up on
   the preview page after the modal closes. */
function renderComposer() {
  const c = state.composer;
  const noun = isInvoice() ? 'invoice' : 'quotation';

  const toInput = h('input', {
    class: 'inp' + (state.composerEmailError ? ' is-invalid' : ''),
    type: 'email', value: c.to, maxlength: '160', autocomplete: 'off',
    placeholder: 'client@company.com',
    oninput: (e) => { c.to = e.target.value; if (state.composerEmailError) { state.composerEmailError = null; render(); } },
  });

  const subjectInput = h('input', {
    class: 'inp', value: c.subject, maxlength: '200',
    oninput: (e) => { c.subject = e.target.value; },
  });

  const bodyInput = h('textarea', {
    class: 'inp compose-body', rows: '8', maxlength: '20000',
    placeholder: `Write a note to your client — this becomes the email body. The full ${noun} is attached as a PDF.`,
    oninput: (e) => { c.body = e.target.value; },
  }, c.body);

  const stopClick = (e) => { e.stopPropagation && e.stopPropagation(); };

  return h('div', {
    class: 'modal-scrim no-print',
    role: 'dialog', 'aria-modal': 'true', 'aria-label': `Send ${noun}`,
    onclick: closeComposer,
  },
    h('div', { class: 'modal', onclick: stopClick },
      h('div', { class: 'modal-head' },
        h('h2', { class: 'modal-title', text: `Send ${noun}` }),
        h('button', { class: 'btn-icon', title: 'Close', 'aria-label': 'Close', text: '×', onclick: closeComposer }),
      ),
      h('div', { class: 'modal-body' },
        h('label', { class: 'lbl stacked' },
          h('span', { class: 'lbl-text', text: 'To' }),
          toInput,
          state.composerEmailError && h('div', { class: 'field-error', text: state.composerEmailError }),
        ),
        h('label', { class: 'lbl stacked' },
          h('span', { class: 'lbl-text', text: 'Subject' }),
          subjectInput,
        ),
        h('label', { class: 'lbl stacked' },
          h('span', { class: 'lbl-text', text: 'Message' }),
          bodyInput,
        ),
        h('div', { class: 'compose-note', text: `The ${noun} will be attached as a PDF — your message above becomes the email body.` }),
      ),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn-outline', text: 'Cancel', onclick: closeComposer }),
        h('button', {
          class: 'btn-dark', text: state.sending ? 'Sending…' : 'Send',
          disabled: state.sending, onclick: confirmSendFromComposer,
        }),
      ),
    ),
  );
}

/* ------------------------------------------------------------- letterhead */

const FORMAT_BUTTONS = [
  { label: 'B', title: 'Bold', cmd: 'bold', cls: 'b' },
  { label: 'I', title: 'Italic', cmd: 'italic', cls: 'i' },
  { label: 'U', title: 'Underline', cmd: 'underline', cls: 'u' },
  { label: '•', title: 'Bullet list', cmd: 'insertUnorderedList', cls: 'bullet' },
  { label: '1.', title: 'Numbered list', cmd: 'insertOrderedList', cls: 'plain' },
  { label: '⟵', title: 'Align left', cmd: 'justifyLeft', cls: 'plain' },
  { label: '⟷', title: 'Centre', cmd: 'justifyCenter', cls: 'plain' },
  { label: '⟶', title: 'Align right', cmd: 'justifyRight', cls: 'plain' },
  { label: '⌫', title: 'Clear formatting', cmd: 'removeFormat', cls: 'plain' },
];

const SWATCHES = ['#14171F', '#5B6270', '#1A4BF0', '#B3321E', '#0F7B5A'];

let letterEl = null;

/* document.execCommand is deprecated but is still the only broadly supported
   way to run rich-text commands on a contenteditable region. */
function exec(cmd, val) {
  if (letterEl) letterEl.focus();
  document.execCommand(cmd, false, val === undefined ? null : val);
}

function defaultLetterHTML() {
  const today = fmtDate(isoLocal(new Date()));
  return `<p style="margin:0 0 14px">${today}</p>`
    + '<p style="margin:0 0 14px">To whom it may concern,</p>'
    + '<p style="margin:0 0 14px">Start typing here. Select any text and use the toolbar above to '
    + 'change its font, size, colour or weight.</p>'
    + '<p style="margin:0">Regards,<br>VedryxTech</p>';
}

/* Derive a fallback title from the first ~80 characters of readable text in
   the letter body. Used only when the user did not type a title of their own. */
function deriveLetterTitle(html) {
  const stripped = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped) return 'Untitled letter';
  return stripped.slice(0, 80);
}

function saveLetter() {
  const html = state.letterHTML ?? defaultLetterHTML();
  const title = String(state.letterTitle || '').trim() || deriveLetterTitle(html);
  const doc = {
    id: state.editingLetterId,
    type: 'letter',
    title: title.slice(0, 160),
    html: String(html).slice(0, 200000),
    updatedAt: new Date().toISOString(),
  };
  commit(doc, { editingLetterId: doc.id, letterTitle: doc.title, letterSaved: true });
}

function renderLetter() {
  const body = h('div', {
    class: 'letter-body',
    contenteditable: 'true',
    spellcheck: 'true',
    oninput: (e) => { state.letterHTML = e.target.innerHTML; state.letterSaved = false; },
  });
  body.innerHTML = state.letterHTML ?? defaultLetterHTML();
  letterEl = body;

  const titleInput = h('input', {
    class: 'inp letter-title',
    value: state.letterTitle || '',
    placeholder: 'Title (optional — used to find this letter later)',
    maxlength: '160',
    oninput: (e) => { state.letterTitle = e.target.value; state.letterSaved = false; },
  });

  const fontSelect = h('select', {
    class: 'letter-select', title: 'Font',
    onchange: (e) => exec('fontName', e.target.value),
  }, ['Manrope', 'Georgia', 'Helvetica', 'Times New Roman', 'Courier New']
    .map((f) => h('option', { value: f, text: f })));

  const sizeSelect = h('select', {
    class: 'letter-select', title: 'Size',
    onchange: (e) => exec('fontSize', e.target.value),
  }, [['3', '14 pt'], ['1', '10 pt'], ['2', '12 pt'], ['4', '18 pt'], ['5', '24 pt'], ['6', '32 pt']]
    .map(([v, l]) => h('option', { value: v, text: l })));

  const tools = h('div', { class: 'letter-tools no-print' },
    fontSelect,
    sizeSelect,
    h('div', { class: 'tool-sep' }),
    FORMAT_BUTTONS.map((b) => h('button', {
      class: 'fmt-btn ' + b.cls, title: b.title, text: b.label,
      onclick: () => exec(b.cmd),
    })),
    h('div', { class: 'tool-sep' }),
    h('div', { class: 'swatches' }, SWATCHES.map((c) => h('button', {
      class: 'swatch', title: c, style: `background:${c}`,
      onclick: () => exec('foreColor', c),
    }))),
  );

  return h('div', { class: 'letter' },
    h('div', { class: 'letter-bar no-print' },
      h('button', { class: 'btn-back', onclick: goHome, text: '←', title: 'All tools' }),
      h('h1', { text: state.editingLetterId ? 'Edit letterhead' : 'Letterhead' }),
      h('button', { class: 'btn-outline', text: 'Download PDF', onclick: () => window.print() }),
      h('button', { class: 'btn-dark', text: 'Save', onclick: saveLetter }),
    ),
    h('div', { class: 'letter-title-row no-print' }, titleInput),
    state.letterSaved && h('div', {
      class: 'saved-note no-print',
      style: 'margin-bottom:12px',
      text: 'Saved to your letterheads list.',
    }),
    tools,
    h('div', { class: 'doc-sheet letter-sheet' },
      h('div', { class: 'letter-head' },
        h('div', { class: 'doc-stripes' }),
        h('div', { class: 'doc-tab' }),
        h('img', { class: 'letter-logo', src: 'assets/logo.svg', alt: 'VedryxTech' }),
      ),
      body,
      h('div', { class: 'doc-foot letter-foot' },
        h('div', { class: 'doc-foot-stripes' }),
        h('div', { class: 'doc-foot-mail', text: 'hello@vedryxtech.com' }),
        h('div', { class: 'doc-foot-brand', text: 'VEDRYXTECH' }),
      ),
    ),
  );
}

/* ----------------------------------------------------------------- render */

const SCREENS = {
  home: renderHome,
  list: renderList,
  edit: renderEdit,
  preview: renderPreview,
  letter: renderLetter,
};

function render() {
  if (state.screen !== 'letter') letterEl = null;
  renderTopbar();
  const view = (SCREENS[state.screen] || renderHome)();
  document.getElementById('screen').replaceChildren(view);
}

function init() {
  document.documentElement.style.setProperty('--accent', CONFIG.accentColor);
  initTheme();
  render();

  // The local mirror has already painted; ask the database for the real list.
  Store.onStatusChange(renderTopbar);
  Store.syncFromServer(state.quotes).then((documents) => {
    if (documents) state.quotes = documents;
    render();
  });
}

document.addEventListener('DOMContentLoaded', init);
