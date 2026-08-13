/* Server-side PDF generation for quotations and invoices.
 *
 * pdf-lib chosen over pdfkit because pdf-lib embeds its standard-font metrics
 * as JS strings inside the package itself — there are no .afm files to ship to
 * Vercel and no `includeFiles` glob required. StandardFonts.Helvetica and
 * HelveticaBold are enough for a clean brand-consistent doc; we deliberately
 * avoid any external .ttf so this module bundles cleanly into any Node
 * serverless runtime.
 *
 * The layout mirrors the branded HTML email (server.js:renderDocEmail) —
 * VEDRYXTECH stripe, big title, BILLED TO / DATE columns, line-item table,
 * totals block, notes, footer — but pixel parity is not the goal. Correct
 * numbers, brand feel, and currency formatting per doc are. */
'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

/* Brand logo (webroot/assets/logo.png) drawn top-left of the PDF. Read once at
   module load; the file ships in the Vercel function bundle via the existing
   `includeFiles: "webroot/**"` glob in vercel.json. Null-safe — if the asset is
   ever missing we fall back to the VEDRYXTECH wordmark rather than crash. */
let LOGO_BYTES = null;
try {
  LOGO_BYTES = fs.readFileSync(path.join(__dirname, '..', 'webroot', 'assets', 'logo.png'));
} catch { LOGO_BYTES = null; }

/* Layout constants — one source of truth for margins, colours, sizing. */
const PAGE_W = 595.28;                // A4 portrait in points
const PAGE_H = 841.89;
const MARGIN_X = 40;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

/* Brand colours match --ink / --text-3 / --text-5 in webroot/styles.css so
   the PDF sits inside the same visual system as the app + email. */
const INK       = rgb(20 / 255,  23 / 255,  31 / 255);   // #14171F
const TEXT_2    = rgb(64 / 255,  69 / 255,  78 / 255);   // #40454E
const TEXT_3    = rgb(91 / 255,  98 / 255, 112 / 255);   // #5B6270
const TEXT_5    = rgb(138 / 255, 144 / 255, 153 / 255);  // #8A9099
const LINE_3    = rgb(237 / 255, 240 / 255, 244 / 255);  // #EDF0F4
const WHITE     = rgb(1, 1, 1);

const MAX_PCT = 100;
const CURRENCIES = ['USD', 'INR', 'EUR', 'AED', 'GBP', 'JPY'];
const DEFAULT_CURRENCY = 'USD';
const coerceCurrency = (c) => (CURRENCIES.includes(String(c || '').toUpperCase())
  ? String(c).toUpperCase()
  : DEFAULT_CURRENCY);
const nonNeg = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* Same currency behaviour as server.js:fmtMoney — but pdf-lib's WinAnsi
   encoding cannot encode ₹ (U+20B9), so we substitute the ISO code for INR
   only. Every other currency's symbol is within WinAnsi ($, €, £, ¥, or the
   AED code that Intl already prefixes as text). */
function fmtMoneyForPdf(code, n) {
  const v = Number(n) || 0;
  const currency = coerceCurrency(code);
  const raw = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v);
  if (currency === 'INR') return raw.replace('₹', 'INR ');
  return raw;
}

function totals(doc) {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const sub = items.reduce((a, it) => {
    const q = nonNeg(it.qty);
    const p = nonNeg(it.price);
    return a + (q > 0 ? q * p : p);
  }, 0);
  const disc = sub * Math.min(nonNeg(doc.discount), MAX_PCT) / 100;
  const tax = (sub - disc) * Math.min(nonNeg(doc.taxRate), MAX_PCT) / 100;
  return { sub, disc, tax, total: sub - disc + tax };
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

/* Standard fonts (Helvetica family) don't include every glyph — e.g. ₹ crashes
   text encoding. This scrubs the un-encodable characters and keeps the rest
   intact rather than crashing mid-draw. Rare in practice; this is defence. */
function safeText(s) {
  return String(s ?? '')
    .replace(/₹/g, 'INR ')      // Indian rupee → text
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, ''); // drop non-WinAnsi glyphs
}

/* Wrap `text` so no line exceeds `maxWidth` points at the given font+size.
   Simple word-splitter — good enough for the descriptions we render (short
   commercial prose, not paragraphs). Preserves explicit \n line breaks. */
function wrapLines(text, font, size, maxWidth) {
  const src = safeText(text);
  const out = [];
  for (const raw of src.split('\n')) {
    if (!raw) { out.push(''); continue; }
    const words = raw.split(/\s+/);
    let line = '';
    for (const w of words) {
      const attempt = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(attempt, size) > maxWidth && line) {
        out.push(line);
        line = w;
      } else {
        line = attempt;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/* Draw a single line at (x, y). y is the text baseline (pdf-lib convention).
   Callers manage the cursor themselves — we deliberately do NOT return an
   advanced y, because the earlier "shortcut" of ignoring the return value +
   guessing a small decrement is exactly what caused labels to draw on top of
   their values. Explicit gaps everywhere. */
function drawText(page, text, x, y, font, size, color) {
  page.drawText(safeText(text), { x, y, size, font, color });
}

/* Renders the given (server-sanitized) doc as a Buffer holding a PDF. */
async function renderDocPdf(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('renderDocPdf: invalid doc');
  const type = doc.type === 'invoice' ? 'invoice' : 'quotation';
  const title = type === 'invoice' ? 'INVOICE' : 'QUOTATION';
  const dateLabel = type === 'invoice' ? 'DUE DATE' : 'VALID UNTIL';
  const currency = coerceCurrency(doc.currency);
  const t = totals(doc);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} ${doc.number || ''}`.trim());
  pdf.setAuthor('VedryxTech');
  pdf.setCreator('vedryxtech-quotations');
  pdf.setProducer('vedryxtech-quotations');

  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y;

  /* Vertical spacing constants — pt gaps between text baselines. The label
     gaps are LARGER than the label font size so no label sits on top of the
     value it introduces. Every draw call is followed by an explicit y -= gap. */
  const GAP_AFTER_SMALLCAPS = 16;   // after 9pt uppercase label → next value
  const GAP_AFTER_NAME      = 18;   // after 13pt client name  → next info line
  const GAP_INFO_LINE       = 14;   // between consecutive 11pt info lines
  const GAP_AFTER_VALUE     = 22;   // after a value block  → next label

  const RIGHT = MARGIN_X + CONTENT_W;
  /* Right-aligned text helper — the date column + amounts sit flush to the
     right margin, matching the on-screen doc + HTML email. */
  const drawRight = (text, rightEdge, yy, font, size, color) => {
    const w = font.widthOfTextAtSize(safeText(text), size);
    drawText(page, text, rightEdge - w, yy, font, size, color);
  };

  /* Header stripe (matches the 6px black rule at the top of the email shell) */
  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: INK });

  /* Top-right diagonal shade — the skewed stripe motif from the on-screen
     doc-sheet (.doc-stripes). pdf-lib has no skew, so we rotate thin bars; low
     opacity keeps them decorative and behind the header content. */
  const N_STRIPES = 7, STRIPE_W = 6, STRIPE_GAP = 19, STRIPE_H = 86;
  for (let i = 0; i < N_STRIPES; i++) {
    page.drawRectangle({
      x: PAGE_W - 26 - i * STRIPE_GAP,
      y: PAGE_H - 18 - STRIPE_H,
      width: STRIPE_W,
      height: STRIPE_H,
      color: INK,
      opacity: 0.12,
      rotate: degrees(-24),
    });
  }

  /* Brand logo top-left (falls back to the wordmark if the asset is missing). */
  if (LOGO_BYTES) {
    try {
      const logo = await pdf.embedPng(LOGO_BYTES);
      const logoW = 124;
      const logoH = logoW * (logo.height / logo.width);
      page.drawImage(logo, { x: MARGIN_X, y: PAGE_H - 42 - logoH, width: logoW, height: logoH });
    } catch {
      drawText(page, 'VEDRYXTECH', MARGIN_X, PAGE_H - 46, bold, 10, TEXT_5);
    }
  } else {
    drawText(page, 'VEDRYXTECH', MARGIN_X, PAGE_H - 46, bold, 10, TEXT_5);
  }

  /* Title + number, below the logo. */
  drawText(page, title,        MARGIN_X, PAGE_H - 100, bold, 32, INK);
  drawText(page, String(doc.number || ''), MARGIN_X, PAGE_H - 126, bold, 10, TEXT_5);

  /* Meta row: BILLED TO on the left, DATE / DUE right-aligned on the right.
     Both columns start at the same top baseline; the lower of the two becomes
     the cursor for the next section. */
  const metaTop = PAGE_H - 162;

  /* BILLED TO — small-caps label sits ABOVE the name, which sits above the
     wrapped contact block. Each hop uses an explicit gap. */
  let ly = metaTop;
  drawText(page, 'BILLED TO', MARGIN_X, ly, bold, 9, TEXT_5);
  ly -= GAP_AFTER_SMALLCAPS;
  drawText(page, doc.client?.name || 'Client', MARGIN_X, ly, bold, 13, INK);
  ly -= GAP_AFTER_NAME;
  const infoLines = [doc.client?.contact, doc.client?.email, doc.client?.phone, doc.client?.address]
    .filter(Boolean).join('\n');
  const wrappedInfo = wrapLines(infoLines, helv, 11, CONTENT_W / 2 - 10);
  for (const line of wrappedInfo) {
    drawText(page, line, MARGIN_X, ly, helv, 11, TEXT_3);
    ly -= GAP_INFO_LINE;
  }

  /* DATE + VALID UNTIL/DUE DATE — right-aligned to the right margin. */
  let ry = metaTop;
  drawRight('DATE', RIGHT, ry, bold, 9, TEXT_5);
  ry -= GAP_AFTER_SMALLCAPS;
  drawRight(fmtDate(doc.issueDate), RIGHT, ry, bold, 11, INK);
  ry -= GAP_AFTER_VALUE;
  drawRight(dateLabel, RIGHT, ry, bold, 9, TEXT_5);
  ry -= GAP_AFTER_SMALLCAPS;
  drawRight(fmtDate(doc.validUntil), RIGHT, ry, bold, 11, INK);
  ry -= GAP_AFTER_VALUE;

  /* Next section starts below whichever column ran deeper, plus breathing room. */
  y = Math.min(ly, ry) - 8;

  /* Items table header: DESCRIPTION / AMOUNT labels above the black separator,
     first item baseline sits 20pt below the separator so the item text top
     doesn't touch the rule. */
  drawText(page, 'DESCRIPTION', MARGIN_X, y, bold, 9, INK);
  const amountLabel = 'AMOUNT';
  const amountLabelW = bold.widthOfTextAtSize(amountLabel, 9);
  drawText(page, amountLabel, MARGIN_X + CONTENT_W - amountLabelW, y, bold, 9, INK);
  y -= 8;
  page.drawLine({
    start: { x: MARGIN_X, y }, end: { x: MARGIN_X + CONTENT_W, y },
    thickness: 1.4, color: INK,
  });
  y -= 20;

  /* Line items */
  const items = (doc.items || []).filter((i) => (i.service || '').trim() || nonNeg(i.price) > 0);
  const descColW = CONTENT_W - 140;    // amount column reserves 140pt

  for (const it of items) {
    if (y < 200) {
      /* Overflow: start a fresh page. Deliberately simple — most quotations
         are single-page; if a doc spills, we just continue below the top
         margin. Header repeat is not required for internal review. */
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - 60;
    }
    const q = nonNeg(it.qty);
    const p = nonNeg(it.price);
    const amt = q > 0 ? q * p : p;
    const service = it.service || 'Untitled service';
    const description = it.description || '';
    const qtyLine = q > 1 ? `${q} x ${fmtMoneyForPdf(currency, p)}` : '';

    const amountText = fmtMoneyForPdf(currency, amt);
    const amountW = bold.widthOfTextAtSize(amountText, 12);

    page.drawText(safeText(service), { x: MARGIN_X, y, size: 12, font: bold, color: INK });
    page.drawText(amountText, {
      x: MARGIN_X + CONTENT_W - amountW, y, size: 12, font: bold, color: INK,
    });
    y -= 15;

    if (description) {
      for (const line of wrapLines(description, helv, 10, descColW)) {
        page.drawText(safeText(line), { x: MARGIN_X, y, size: 10, font: helv, color: TEXT_3 });
        y -= 13;
      }
    }
    if (qtyLine) {
      page.drawText(safeText(qtyLine), { x: MARGIN_X, y, size: 10, font: helv, color: TEXT_5 });
      y -= 13;
    }
    y -= 6;
    page.drawLine({
      start: { x: MARGIN_X, y }, end: { x: MARGIN_X + CONTENT_W, y },
      thickness: 0.5, color: LINE_3,
    });
    y -= 8;
  }

  /* Totals block, right-aligned */
  y -= 4;
  const totalsX = MARGIN_X + CONTENT_W - 240;
  const totalsW = 240;

  const rows = [
    ['Sub-Total', fmtMoneyForPdf(currency, t.sub)],
  ];
  const discPct = Math.min(nonNeg(doc.discount), MAX_PCT);
  if (t.disc > 0) {
    rows.push([`Discount (${discPct}%)`, '-' + fmtMoneyForPdf(currency, t.disc)]);
  }
  rows.push([`Tax (${Math.min(nonNeg(doc.taxRate), MAX_PCT)}%)`, fmtMoneyForPdf(currency, t.tax)]);

  for (const [label, value] of rows) {
    page.drawText(safeText(label), { x: totalsX, y, size: 11, font: helv, color: TEXT_3 });
    const w = helv.widthOfTextAtSize(value, 11);
    page.drawText(safeText(value), {
      x: totalsX + totalsW - w, y, size: 11, font: helv, color: INK,
    });
    y -= 17;
  }

  /* Grand total bar */
  y -= 4;
  const grandH = 34;
  page.drawRectangle({ x: totalsX, y: y - grandH, width: totalsW, height: grandH, color: INK });
  const totalLabel = 'TOTAL';
  const totalValue = fmtMoneyForPdf(currency, t.total);
  const totalValueW = bold.widthOfTextAtSize(totalValue, 16);
  page.drawText(totalLabel, {
    x: totalsX + 12, y: y - grandH / 2 - 5, size: 10, font: bold, color: WHITE,
  });
  page.drawText(totalValue, {
    x: totalsX + totalsW - 12 - totalValueW, y: y - grandH / 2 - 6, size: 16, font: bold, color: WHITE,
  });
  y -= grandH + 24;

  /* Notes — small-caps label above the body, with an explicit gap so the
     first notes line does not sit on top of the label. */
  if (doc.notes) {
    drawText(page, 'NOTES & TERMS', MARGIN_X, y, bold, 9, TEXT_5);
    y -= GAP_AFTER_SMALLCAPS;
    for (const line of wrapLines(doc.notes, helv, 10, CONTENT_W)) {
      if (y < 60) break;
      drawText(page, line, MARGIN_X, y, helv, 10, TEXT_2);
      y -= 14;
    }
  }

  /* Footer */
  const footY = 40;
  page.drawLine({
    start: { x: MARGIN_X, y: footY + 18 }, end: { x: MARGIN_X + CONTENT_W, y: footY + 18 },
    thickness: 0.5, color: LINE_3,
  });
  page.drawText('hello@vedryxtech.com', {
    x: MARGIN_X, y: footY, size: 9, font: helv, color: TEXT_3,
  });
  const brand = 'VEDRYXTECH';
  const brandW = bold.widthOfTextAtSize(brand, 10);
  page.drawText(brand, {
    x: MARGIN_X + CONTENT_W - brandW, y: footY, size: 10, font: bold, color: INK,
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

module.exports = { renderDocPdf, totals, fmtMoneyForPdf };
