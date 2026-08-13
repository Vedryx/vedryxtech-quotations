# VedryxTech Quotations

Quotations, invoices and letterhead for VedryxTech. Implementation of the design
file `Vedryx Quotations.dc.html` from the Claude Design project
[Vedryx Quotations App](https://claude.ai/design/p/0fb9b6ec-11db-4d0d-ad19-7e2cfa2e3844).

> The design project and its source file keep their original `Vedryx` names —
> those are citations of something that exists elsewhere, so renaming them here
> would misstate where this came from. Everything in this repo is `VedryxTech`.

## Running it

```sh
npm install
npm start
```

Then open <http://localhost:3000>.

A server is required because MongoDB cannot be reached from a browser. Opening
`public/index.html` straight from disk still works, but with no database — it
falls back to browser storage and shows an "Offline — saved locally" pill.

```sh
npm test        # 74 logic checks + 149 UI checks
```

## MongoDB

Connection details come from the environment, so no credential is ever committed:

```sh
cp .env.example .env
```

| Variable | Default | Notes |
| --- | --- | --- |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | Local mongod, no auth |
| `MONGODB_DB` | `vedryxtech` | |
| `MONGODB_COLLECTION` | `documents` | |
| `PORT` | `3000` | |

When the cluster credentials are issued, put the `mongodb+srv://…` string in
`.env` (gitignored) and restart. Nothing else changes. Passwords are redacted in
logs and in `/api/status`.

Documents are keyed on the app's own numeric `id` with a unique index; Mongo's
`_id` is stripped on the way out and never reaches the browser.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Connection state, redacted URI |
| `GET` | `/api/documents` | All documents, sorted by id |
| `PUT` | `/api/documents/:id` | Upsert one document |
| `PUT` | `/api/documents` | Bulk upsert — seeds an empty database |
| `DELETE` | `/api/documents/:id` | Remove one |

The server re-validates every incoming document (`sanitize` in `server.js`) rather
than trusting the browser, so negative quantities, rates, discounts and tax rates
are clamped again at the boundary and strings are length-capped.

### Offline behaviour

Browser storage is a mirror, not the record. Writes go local first so the UI never
waits on the network, then to Mongo best-effort. If the database is unreachable the
app keeps working and the topbar shows the offline pill. On the next successful
connect the server's list wins — except when the database is empty and the browser
has documents, in which case the browser's copy seeds it.

Because there is no delete-all in the UI, emptying the collection by hand and
reloading a browser that still holds a mirror will re-seed it. Clear
`vedryxtech.quotations.v1` in local storage as well if you want a truly clean slate.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | Express host for `public/` plus the documents API |
| `lib/db.js` | MongoDB connection, queries, credential redaction |
| `public/index.html` | Shell — fonts, stylesheet, mount points |
| `public/styles.css` | All design tokens and component rules |
| `public/app.js` | State, screen renderers, document maths, validation |
| `public/store.js` | API access with the local-storage mirror |
| `public/assets/logo.png` | VedryxTech mark, 548×89, from the design project |
| `test/smoke.js` | Pure-logic checks (totals, numbering, dates, validation) |
| `test/render-test.js` | Drives every screen and flow against a DOM shim |

## Configuration

The prototype's `data-props` block became `CONFIG` at the top of `public/app.js`:

```js
const CONFIG = {
  accentColor: '#14171F',   // '#14171F' | '#1A4BF0' | '#0F7B5A' | '#B3521E'
  currency: '$',            // '$' | '₹' | '€' | '£'
  defaultTax: 18,           // 0–30 (%)
};
```

`accentColor` is published as the `--accent` CSS variable.

## Saving

There are three ways a document gets committed, and none of them can lose work:

- **Save** — explicit, permissive. A half-filled draft is a legitimate thing to
  keep, so this only normalises numbers and stores.
- **Preview** — auto-saves first. Opening the preview on a never-saved document
  commits it as a draft and tells you so ("Auto-saved as a draft (QT-…)"), so
  previewing can never be a route to losing changes. A document nobody has typed
  anything into is skipped, so blank drafts don't accumulate. Previewing again
  updates the same record rather than duplicating it.
- **Send to client** — validates, then commits whether or not it was ever saved by
  hand, and locks the quotation.

## Validation

### Nothing numeric can go negative

Every numeric field is guarded at four layers, so a negative value cannot get in
by typing, pasting, dragging, arriving from an older save, or being posted
directly to the API:

1. **Keystroke.** `-`, `+`, `e` and `E` are swallowed by the field. Each `input`
   event re-strips the value to a plain non-negative decimal, which also catches
   paste and drag-drop — `-500` lands as `500`, `9a9` as `99`, `1.2.3` as `1.23`.
2. **Blur.** A half-typed value settles into a real number: `""` and `"."` become
   `0`, `"12."` becomes `12`, and anything over the field's ceiling clamps down.
3. **Maths.** `lineAmount` and `totals` clamp again via `nonNeg` / `pct`, so a
   document carrying bad data still cannot produce a negative figure.
4. **Server.** `sanitize` in `server.js` re-clamps everything before it reaches
   MongoDB, because the browser is not a trust boundary.

| Field | Range |
| --- | --- |
| Qty | 0 – 1,000,000 |
| Rate | 0 – 1,000,000,000 |
| Discount % | 0 – 100 |
| Tax / GST % | 0 – 100 |

Capping discount at 100 is what makes the document total mathematically unable to
go below zero.

### Document-level rules

`validateDraft` checks the whole document:

- Client name is required
- Document number is required
- Issue date is required
- Email, if given, must look like an email
- "Valid until" / "Due date" cannot precede the issue date
- At least one line needs both a name and a rate above zero
- The total must exceed zero

Save and Preview are permissive; **Send is strict**. On failure Send returns you to
the editor, focuses the first bad field, shows a message under each one and a
summary banner in the totals rail, and commits nothing. Messages appear only after
a send has been attempted, then clear themselves live as you fix each field.

Text fields carry `maxlength` caps (120 for names, 400 for addresses and
descriptions, 2000 for notes) so a single paste cannot wreck the document layout.

## How it works

Five screens off one state tree — `home`, `list`, `edit`, `preview`, `letter`.
`render()` rebuilds the active screen; `setState()` patches state and re-renders.

The `dc` runtime is gone. Its `<sc-if>` / `<sc-for>` / `{{ }}` templating,
`style-hover` / `style-focus` attributes and `DCLogic` class became, respectively,
conditionals and `.map()` in `app.js`, real `:hover` / `:focus` rules in
`styles.css`, and plain functions. `support.js` is not needed and was not copied.

Document maths lives in three small functions — `lineAmount`, `totals`,
`nextNumber` — kept identical to the prototype: a line with no quantity is a flat
price rather than `price × 0`, discount comes off the sub-total, and tax applies
to the discounted figure.

## Deviations from the prototype

Behaviour and visuals are ported 1:1 apart from the following. Each is a
deliberate call, not an oversight.

**Added**

1. **MongoDB persistence with a local mirror.** The prototype held everything in
   memory, so a reload discarded every save. See [MongoDB](#mongodb).
2. **Auto-save on Preview.** See [Saving](#saving). The prototype's Preview button
   only switched screens.
3. **Validation.** The design had none. Its number inputs carried `min="0"`, but
   that attribute only bites on form submission, and this app never submits a form,
   so negative rates, discounts above 100% and empty documents all went through
   unchallenged.
4. **Keyboard access on list rows.** They are clickable `div`s, so Enter and
   Space now activate them.
5. **Print rules.** Added `@page { margin: 12mm }` and `break-inside: avoid` on
   line items so the PDF paginates sanely. The prototype had only the three
   `@media print` rules, which are preserved.
6. **Tests.** `test/` did not exist in the design.

**Fixed**

7. **Typing no longer rebuilds the form.** The prototype re-rendered on every
   keystroke. Because the Qty input is conditional on `qty > 0`, clearing it
   destroyed the field mid-edit. Here, keystrokes update state and refresh only
   the derived figures — line amounts, sub-total, discount, tax, total — while
   structural changes (add/remove line, "Add quantity") re-render.
8. **"Today" is a local date.** The prototype derived today from
   `toISOString().slice(0, 10)`, which is UTC and lands on the wrong calendar day
   for anyone far enough from it — including IST after 05:30. Replaced with a
   local-calendar helper, so a new document's issue date matches the user's date.
9. **Zero-rate lines behave consistently in the preview.** The prototype filtered
   on `i.service || i.price`. Rate values arrive from inputs as strings, so an
   untouched `0` was falsy but a typed `"0"` was truthy — the same line appeared
   or vanished depending on whether it had been edited. Now
   `i.service || nonNeg(i.price) > 0`.
10. **User text cannot inject markup.** All client names, descriptions and notes
    are written with `textContent`, so a value containing `<` or `>` renders
    literally.
11. **Dropped the unused `seq: 14` state field.** Numbering derives from the
    highest existing document number for that type, which is what the prototype
    actually did.

**Kept deliberately, though arguably wrong**

12. **`accentColor` still only tints the list filter chips.** That is the one
    place the prototype used it; the document sheet is hardcoded to the ink
    colour. To extend it, swap `var(--ink)` for `var(--accent)` in the `.doc-*`
    rules.
13. **The save confirmation always reads "Saved to your quotations list."**, even
    for an invoice. That string is hardcoded in the design.
14. **`document.execCommand` drives the letterhead toolbar.** It is deprecated but
    remains the only broadly supported way to run rich-text commands over a
    `contenteditable` region. Replacing it means writing a formatting model, which
    is a larger change than a port should make.

Also worth knowing: the letterhead's seeded date is computed at render time — the
prototype hardcoded `13 August 2026`. Letterhead text is not persisted; it resets
when you leave the screen.

Manrope loads from Google Fonts. Offline, the page falls back to the
`system-ui` stack and will look slightly heavier.
