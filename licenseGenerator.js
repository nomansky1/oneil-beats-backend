// ─── License PDF Generator ────────────────────────────────────────────────────
// Generates a PDF license agreement after purchase, matching BeatStars style.
// License terms (streams / sales / broadcasts / etc.) are sourced from the
// canonical licenseTerms.js so the PDF, the app, and the IAP screenshots all
// agree. Do NOT hard-code license values here — edit licenseTerms.js instead.
//
// Layout uses ABSOLUTE Y coordinates (not doc.y drift) so the header, beat
// box, terms table, signatures, and footer never collide regardless of how
// long the title or buyer name is. Designed to fit on a single LETTER page.

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { LICENSE_TERMS: CANON } = require('./licenseTerms');

// Map canonical fields to the field names this generator originally used,
// preserving legacy callers that read terms.name / terms.description.
const LICENSE_TERMS = Object.fromEntries(
  Object.entries(CANON).map(([k, t]) => [k, {
    name: t.pdfName,
    streams: t.streams,
    sales: t.sales,
    broadcasts: t.broadcasts,
    musicVideos: t.musicVideos,
    nonProfit: t.nonProfit,
    exclusive: t.exclusive,
    mp3Only: t.mp3Only,
    color: t.color,
    description: t.descriptionLong,
  }])
);

// OB Beats logo — embedded in header. Lives in backend/public so it ships
// with the Vercel deploy (the customer-app folder isn't deployed).
const LOGO_PATH = path.join(__dirname, 'public', 'icon.png');
const LOGO_BUF = (() => { try { return fs.readFileSync(LOGO_PATH); } catch (_) { return null; } })();

function generateLicensePDF(orderData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: true });
    const buffers = [];

    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const PAGE_W = 612;
    const PAGE_H = 792;
    const MARGIN = 50;
    const CONTENT_W = PAGE_W - MARGIN * 2; // 512

    const licenseType = orderData.licenseType || 'lease';
    const terms = LICENSE_TERMS[licenseType] || LICENSE_TERMS.lease;
    const beat = orderData.beat || {};
    const buyer = orderData.buyer || {};
    const orderId = orderData.orderId || 'N/A';
    const purchaseDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    // ── Header band (y=0..104) ──────────────────────────────────────────────
    // Gold accent bar
    doc.rect(0, 0, PAGE_W, 6).fill(terms.color);

    // Logo (left)
    if (LOGO_BUF) {
      try { doc.image(LOGO_BUF, MARGIN, 20, { width: 64, height: 64 }); } catch (_) {}
    }

    // Brand title + subtitle (centre-left, beside logo)
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#1a1a2e')
       .text("O'NEIL BEATS", MARGIN + 80, 30, { lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor('#666666')
       .text('Beat License Agreement', MARGIN + 80, 56, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#999999')
       .text('produceroneil@gmail.com  •  oneilbeats.store', MARGIN + 80, 72, { lineBreak: false });

    // License-tier pill (right-aligned in header)
    const pillW = 150;
    const pillH = 34;
    const pillX = PAGE_W - MARGIN - pillW;
    const pillY = 35;
    doc.roundedRect(pillX, pillY, pillW, pillH, 17).fill(terms.color);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
       .text(terms.name.toUpperCase(), pillX, pillY + 11, { width: pillW, align: 'center', lineBreak: false });

    // Thin separator under header
    doc.moveTo(MARGIN, 104).lineTo(PAGE_W - MARGIN, 104).strokeColor('#e5e7eb').lineWidth(0.8).stroke();

    // ── Beat info card (y=118..198) ─────────────────────────────────────────
    const boxY = 118;
    const boxH = 80;
    doc.roundedRect(MARGIN, boxY, CONTENT_W, boxH, 6).fillAndStroke('#f8f9fa', '#e5e7eb');

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#9ca3af')
       .text('BEAT TITLE', MARGIN + 16, boxY + 12, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#1a1a2e')
       .text(beat.title || 'Untitled Beat', MARGIN + 16, boxY + 24, { width: CONTENT_W - 32, lineBreak: false, ellipsis: true });

    doc.font('Helvetica').fontSize(9.5).fillColor('#4b5563')
       .text(
         `Producer: ${beat.artist || "O'Neil"}   •   Genre: ${beat.genre || 'N/A'}   •   BPM: ${beat.bpm || 'N/A'}   •   Key: ${beat.key || 'N/A'}`,
         MARGIN + 16, boxY + 50, { width: CONTENT_W - 32, lineBreak: false }
       );
    doc.font('Helvetica').fontSize(8.5).fillColor('#6b7280')
       .text(
         `Order #${orderId}   •   Licensed to: ${buyer.name || buyer.email || 'N/A'}   •   Purchased: ${purchaseDate}`,
         MARGIN + 16, boxY + 64, { width: CONTENT_W - 32, lineBreak: false }
       );

    // ── License terms table (y=216..400) ────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e')
       .text('LICENSE TERMS', MARGIN, 214, { characterSpacing: 1.2, lineBreak: false });

    const tableY = 230;
    const rowH = 21;
    const tableData = [
      ['Audio Streams', terms.streams],
      ['Paid Downloads / Sales', terms.sales],
      ['Radio Broadcasts', terms.broadcasts],
      ['Music Videos', terms.musicVideos],
      ['For-Profit Use', 'YES'],
      ['Non-Profit / Mixtape Use', 'YES'],
      ['Exclusive Rights', terms.exclusive ? 'YES — Beat Removed From Store' : 'NO — Non-Exclusive'],
      [
        'File Formats Included',
        licenseType === 'lease'   ? 'MP3'
      : licenseType === 'stems'   ? 'WAV + Stems (ZIP)'
      : licenseType === 'exclusive' ? 'MP3 + WAV + Stems'
      :                              'MP3 + WAV',
      ],
    ];
    tableData.forEach(([label, value], i) => {
      const y = tableY + i * rowH;
      if (i % 2 === 0) doc.rect(MARGIN, y, CONTENT_W, rowH).fill('#f8f9fa');
      doc.font('Helvetica').fontSize(9.5).fillColor('#374151')
         .text(label, MARGIN + 16, y + 6, { width: 240, lineBreak: false });
      const valueColor = value === 'YES' ? '#10b981'
                       : String(value).startsWith('NO ') ? '#ef4444'
                       : '#1a1a2e';
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(valueColor)
         .text(String(value), MARGIN + 260, y + 6, { width: CONTENT_W - 276, lineBreak: false });
    });
    // table outer border
    doc.rect(MARGIN, tableY, CONTENT_W, rowH * tableData.length).strokeColor('#e5e7eb').lineWidth(0.8).stroke();

    // ── Agreement terms (y=414..624) ────────────────────────────────────────
    const agreementY = 414;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e')
       .text('AGREEMENT TERMS', MARGIN, agreementY, { characterSpacing: 1.2, lineBreak: false });

    const buyerLabel = buyer.name || buyer.email || 'Licensee';
    const clauses = [
      `This License Agreement ("Agreement") is entered into as of ${purchaseDate}, between O'Neil Beats ("Licensor") and ${buyerLabel} ("Licensee").`,
      `1. GRANT OF LICENSE. Licensor grants Licensee a ${terms.exclusive ? 'exclusive' : 'non-exclusive, non-transferable'} license to use the musical composition "${beat.title || 'the Beat'}" (the "Beat") subject to the terms below.`,
      `2. PERMITTED USES. Licensee may record one (1) new song using the Beat; distribute that new song commercially and/or non-commercially; and create music videos and promotional materials, all subject to the usage limits in the License Terms above.`,
      `3. RESTRICTIONS. Licensee may not re-sell, sub-license, or transfer this license; use the Beat as a sample in another beat or instrumental; register the Beat's underlying composition with any PRO as Licensee's exclusive composition; or use the Beat in any way that infringes Licensor's copyright.`,
      `4. CREDIT. Licensee agrees to credit Licensor as "Prod. by O'Neil Beats" in all works using the Beat, including song titles, album credits, and video descriptions.`,
      `5. OWNERSHIP. ${terms.exclusive ? 'On payment in full, Licensor transfers all master rights in the Beat to Licensee. Licensor retains the songwriter share of publishing.' : 'Licensor retains all ownership and copyright in the Beat. No ownership rights transfer to Licensee. All rights not granted herein are reserved.'}`,
      `6. TERMINATION. This license terminates automatically if Licensee breaches any term. On termination, Licensee must cease all use of the Beat and destroy all copies.`,
    ];

    let textY = agreementY + 18;
    doc.font('Helvetica').fontSize(8.5).fillColor('#374151');
    for (const c of clauses) {
      const h = doc.heightOfString(c, { width: CONTENT_W, lineGap: 1.5 });
      doc.text(c, MARGIN, textY, { width: CONTENT_W, lineGap: 1.5, align: 'justify' });
      textY += h + 4;
    }

    // ── Signatures (y=655..720) ─────────────────────────────────────────────
    const sigY = 655;
    const colW = (CONTENT_W - 24) / 2;
    const leftX = MARGIN;
    const rightX = MARGIN + colW + 24;

    // labels
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#9ca3af')
       .text('LICENSOR', leftX, sigY, { characterSpacing: 1.2, lineBreak: false })
       .text('LICENSEE', rightX, sigY, { characterSpacing: 1.2, lineBreak: false });

    // signature names
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a2e')
       .text("O'Neil Beats", leftX, sigY + 12, { width: colW, lineBreak: false })
       .text(buyerLabel, rightX, sigY + 12, { width: colW, lineBreak: false, ellipsis: true });

    // signature lines
    doc.moveTo(leftX, sigY + 36).lineTo(leftX + colW, sigY + 36).strokeColor('#9ca3af').lineWidth(0.7).stroke();
    doc.moveTo(rightX, sigY + 36).lineTo(rightX + colW, sigY + 36).strokeColor('#9ca3af').lineWidth(0.7).stroke();

    // detail under line
    doc.font('Helvetica').fontSize(8.5).fillColor('#6b7280')
       .text(`Digitally signed  •  ${purchaseDate}`, leftX, sigY + 42, { width: colW, lineBreak: false })
       .text(`Accepted on purchase  •  ${purchaseDate}`, rightX, sigY + 42, { width: colW, lineBreak: false });

    // ── Footer (y=752..792) ─────────────────────────────────────────────────
    doc.rect(0, PAGE_H - 40, PAGE_W, 40).fill('#1a1a2e');
    doc.font('Helvetica').fontSize(8).fillColor('#cbd5e1')
       .text(
         `O'Neil Beats  •  produceroneil@gmail.com  •  Order: ${orderId}  •  ${purchaseDate}`,
         0, PAGE_H - 24, { width: PAGE_W, align: 'center', lineBreak: false }
       );

    doc.end();
  });
}

// ─── Split Sheet PDF Generator ──────────────────────────────────────────────
// Industry-standard collaboration split sheet showing producer/artist percentages
function generateSplitSheetPDF(orderData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    const buffers = [];

    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const beat = orderData.beat || {};
    const buyer = orderData.buyer || {};
    const orderId = orderData.orderId || 'N/A';
    const licenseType = orderData.licenseType || 'lease';
    const terms = LICENSE_TERMS[licenseType] || LICENSE_TERMS.lease;
    const isExclusive = terms.exclusive;
    const purchaseDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    // Split percentages — industry standard
    const producerSplit = isExclusive ? 0 : 50;
    const artistSplit = isExclusive ? 100 : 50;

    // Header bar
    doc.rect(0, 0, 612, 8).fill('#1a1a2e');
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(24).fillColor('#1a1a2e');
    doc.text('COLLABORATION SPLIT SHEET', { align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#666666');
    doc.text('Music Ownership & Revenue Agreement', { align: 'center' });
    doc.moveDown(0.8);

    // Song Info Box
    doc.rect(60, doc.y, 492, 70).fill('#f8f9fa').stroke('#e0e0e0');
    const infoY = doc.y - 70;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#888888');
    doc.text('SONG / BEAT TITLE', 75, infoY + 10);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1a2e');
    doc.text(beat.title || 'Untitled Beat', 75, infoY + 26);
    doc.font('Helvetica').fontSize(9).fillColor('#666666');
    doc.text(`Genre: ${beat.genre || 'N/A'}  \u2022  BPM: ${beat.bpm || 'N/A'}  \u2022  Key: ${beat.key || 'N/A'}  \u2022  Order: #${orderId.toString().slice(0, 8)}  \u2022  Date: ${purchaseDate}`, 75, infoY + 50);
    doc.moveDown(0.5);

    // Parties
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a2e');
    doc.text('PARTIES', 60, doc.y + 10);
    doc.moveDown(0.3);

    // Producer box
    doc.rect(60, doc.y, 236, 80).fill('#fff3e0').stroke('#f59e0b');
    const prodY = doc.y - 80;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#f59e0b');
    doc.text('PRODUCER', 75, prodY + 10);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a2e');
    doc.text("O'Neil", 75, prodY + 26);
    doc.font('Helvetica').fontSize(9).fillColor('#666666');
    doc.text('produceroneil@gmail.com', 75, prodY + 44);
    doc.text("O'Neil Beats", 75, prodY + 58);

    // Artist box
    doc.rect(316, prodY, 236, 80).fill('#e8f5e9').stroke('#10b981');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#10b981');
    doc.text('ARTIST / LICENSEE', 331, prodY + 10);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a2e');
    doc.text(buyer.name || 'Artist', 331, prodY + 26);
    doc.font('Helvetica').fontSize(9).fillColor('#666666');
    doc.text(buyer.email || 'N/A', 331, prodY + 44);
    doc.text(`License: ${terms.name}`, 331, prodY + 58);

    doc.moveDown(1);

    // Ownership Split Table
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a2e');
    doc.text('OWNERSHIP & REVENUE SPLIT', 60, doc.y + 10);
    doc.moveDown(0.3);

    const splitData = [
      ['Master Recording Ownership', `${producerSplit}%`, `${artistSplit}%`],
      ['Publishing / Songwriter', `${producerSplit}%`, `${artistSplit}%`],
      ['Performance Royalties (PRO)', `${producerSplit}%`, `${artistSplit}%`],
      ['Sync Licensing Revenue', `${producerSplit}%`, `${artistSplit}%`],
    ];

    // Table header
    let tY = doc.y + 5;
    doc.rect(60, tY, 492, 24).fill('#1a1a2e');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
    doc.text('REVENUE TYPE', 75, tY + 8);
    doc.text('PRODUCER', 330, tY + 8);
    doc.text('ARTIST', 430, tY + 8);
    tY += 24;

    splitData.forEach(([label, prod, art], i) => {
      doc.rect(60, tY, 492, 24).fill(i % 2 === 0 ? '#ffffff' : '#f8f9fa');
      doc.font('Helvetica').fontSize(10).fillColor('#444444');
      doc.text(label, 75, tY + 7);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#f59e0b');
      doc.text(prod, 340, tY + 7);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#10b981');
      doc.text(art, 440, tY + 7);
      tY += 24;
    });
    doc.rect(60, doc.y + 5, 492, 24 * (splitData.length + 1)).stroke('#e0e0e0');

    doc.moveDown(2);

    // Notes
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e');
    doc.text('IMPORTANT NOTES', 60, doc.y + 10);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#555555');

    if (isExclusive) {
      doc.text('\u2022 This is an EXCLUSIVE purchase. The artist owns 100% of the master recording and publishing.', 60, doc.y, { width: 492 });
      doc.text("\u2022 The beat will be removed from the O'Neil Beats store following this purchase.", 60, doc.y + 2, { width: 492 });
      doc.text('\u2022 Producer retains credit: "Prod. by O\'Neil Beats" must appear on all releases.', 60, doc.y + 2, { width: 492 });
    } else {
      doc.text('\u2022 This is a NON-EXCLUSIVE license. The producer retains ownership of the beat and may license it to others.', 60, doc.y, { width: 492 });
      doc.text('\u2022 The 50/50 split is the industry standard for non-exclusive beat licenses.', 60, doc.y + 2, { width: 492 });
      doc.text('\u2022 Producer credit: "Prod. by O\'Neil Beats" must appear on all releases.', 60, doc.y + 2, { width: 492 });
      doc.text('\u2022 Both parties should register with their respective PRO (ASCAP, BMI, SESAC) to collect royalties.', 60, doc.y + 2, { width: 492 });
    }

    doc.moveDown(2);

    // Signature lines
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e');
    doc.text('SIGNATURES', 60, doc.y);
    doc.moveDown(0.8);

    doc.moveTo(60, doc.y).lineTo(270, doc.y).stroke('#cccccc');
    doc.font('Helvetica').fontSize(9).fillColor('#666666');
    doc.text("O'Neil (Producer) \u2014 Digitally Signed", 60, doc.y + 4);
    doc.text(purchaseDate, 60, doc.y + 2);
    doc.moveDown(0.5);
    doc.moveTo(310, doc.y - 30).lineTo(552, doc.y - 30).stroke('#cccccc');
    doc.text(buyer.name || buyer.email || 'Artist', 310, doc.y - 26);
    doc.text(purchaseDate, 310, doc.y + 2);

    // Footer
    doc.rect(0, doc.page.height - 40, 612, 40).fill('#1a1a2e');
    doc.font('Helvetica').fontSize(8).fillColor('#888888');
    doc.text(
      `O'Neil Beats Split Sheet  \u2022  Order: ${orderId}  \u2022  ${purchaseDate}  \u2022  This document does not constitute legal advice.`,
      60, doc.page.height - 25, { align: 'center', width: 492 }
    );

    doc.end();
  });
}

module.exports = { generateLicensePDF, generateSplitSheetPDF, LICENSE_TERMS };
