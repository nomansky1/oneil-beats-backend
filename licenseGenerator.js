// ─── License PDF Generator ────────────────────────────────────────────────────
// Generates a PDF license agreement after purchase, matching BeatStars style

const PDFDocument = require('pdfkit');

const LICENSE_TERMS = {
  lease: {
    name: 'Basic Lease License',
    streams: '500,000',
    sales: '2,500',
    broadcasts: '1',
    musicVideos: '1',
    nonProfit: true,
    exclusive: false,
    mp3Only: true,
    color: '#f59e0b',
    description: 'Non-exclusive license for independent releases with limited distribution.',
  },
  premium: {
    name: 'Premium Lease License',
    streams: '1,000,000',
    sales: '5,000',
    broadcasts: '2',
    musicVideos: '2',
    nonProfit: true,
    exclusive: false,
    mp3Only: false, // includes wav
    color: '#8b5cf6',
    description: 'Non-exclusive license for commercial releases with wider distribution rights.',
  },
  stems: {
    name: 'Unlimited License (Stems)',
    streams: 'Unlimited',
    sales: 'Unlimited',
    broadcasts: 'Unlimited',
    musicVideos: 'Unlimited',
    nonProfit: true,
    exclusive: false,
    mp3Only: false, // includes stems
    color: '#10b981',
    description: 'Full stems + unlimited distribution. Maximum creative control.',
  },
  exclusive: {
    name: 'Exclusive Rights License',
    streams: 'Unlimited',
    sales: 'Unlimited',
    broadcasts: 'Unlimited',
    musicVideos: 'Unlimited',
    nonProfit: true,
    exclusive: true,
    mp3Only: false,
    color: '#ef4444',
    description: 'Exclusive ownership. Beat removed from store after purchase.',
  },
};

function generateLicensePDF(orderData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    const buffers = [];

    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const licenseType = orderData.licenseType || 'lease';
    const terms = LICENSE_TERMS[licenseType] || LICENSE_TERMS.lease;
    const beat = orderData.beat;
    const buyer = orderData.buyer;
    const orderId = orderData.orderId;
    const purchaseDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    // ── Header ──────────────────────────────────────────────────────────────
    // Gold accent bar
    doc.rect(0, 0, 612, 8).fill(terms.color);

    doc.moveDown(1);

    // Logo text
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#1a1a2e');
    doc.text("O'NEIL BEATS", { align: 'center' });

    doc.font('Helvetica').fontSize(11).fillColor('#666666');
    doc.text('Premium Beat License Agreement', { align: 'center' });
    doc.moveDown(0.5);

    // License type badge
    doc.roundedRect(doc.page.width / 2 - 100, doc.y, 200, 30, 6)
       .fill(terms.color);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff');
    doc.text(terms.name.toUpperCase(), doc.page.width / 2 - 100, doc.y - 22, {
      width: 200, align: 'center',
    });
    doc.moveDown(2);

    // ── Beat Info Box ────────────────────────────────────────────────────────
    doc.rect(60, doc.y, 492, 90).fill('#f8f9fa').stroke('#e0e0e0');
    const boxY = doc.y - 90;

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#888888');
    doc.text('BEAT TITLE', 70, boxY + 12);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1a2e');
    doc.text(beat.title || 'Untitled Beat', 70, boxY + 26);

    doc.font('Helvetica').fontSize(10).fillColor('#666666');
    doc.text(`Producer: ${beat.artist || "O'Neil"}   •   Genre: ${beat.genre || 'N/A'}   •   BPM: ${beat.bpm || 'N/A'}   •   Key: ${beat.key || 'N/A'}`, 70, boxY + 56);
    doc.text(`Order #${orderId}   •   Purchased: ${purchaseDate}`, 70, boxY + 72);
    doc.moveDown(0.5);

    // ── License Terms Table ──────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a2e');
    doc.text('LICENSE TERMS', 60, doc.y + 10);
    doc.moveDown(0.3);

    const tableData = [
      ['Audio Streams', terms.streams],
      ['Paid Downloads / Sales', terms.sales],
      ['Radio Broadcasts', terms.broadcasts],
      ['Music Videos', terms.musicVideos],
      ['For-Profit Use', 'YES'],
      ['Non-Profit / Mixtape Use', 'YES'],
      ['Exclusive Rights', terms.exclusive ? 'YES — Beat Removed From Store' : 'NO — Non-Exclusive'],
      ['File Formats Included', licenseType === 'lease' ? 'MP3' : licenseType === 'stems' ? 'WAV + Stems (ZIP)' : 'MP3 + WAV'],
    ];

    let rowY = doc.y + 5;
    tableData.forEach(([label, value], i) => {
      const bgColor = i % 2 === 0 ? '#ffffff' : '#f8f9fa';
      doc.rect(60, rowY, 492, 24).fill(bgColor);
      doc.font('Helvetica').fontSize(10).fillColor('#444444');
      doc.text(label, 75, rowY + 7);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(value === 'YES' ? '#10b981' : value.startsWith('NO') ? '#ef4444' : '#1a1a2e');
      doc.text(value, 340, rowY + 7);
      rowY += 24;
    });
    doc.rect(60, doc.y - (24 * tableData.length) - 5, 492, 24 * tableData.length + 5).stroke('#e0e0e0');

    doc.moveDown(1.5);

    // ── Legal Terms ──────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a2e');
    doc.text('AGREEMENT TERMS', 60);
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(9).fillColor('#555555');
    const legalText = `This License Agreement ("Agreement") is entered into as of ${purchaseDate}, between O'Neil Beats ("Licensor") and ${buyer.name || buyer.email} ("Licensee").

1. GRANT OF LICENSE. Licensor hereby grants Licensee a non-exclusive, non-transferable license to use the musical composition "${beat.title}" (the "Beat") subject to the terms and conditions of this Agreement.

2. PERMITTED USES. Licensee may use the Beat for: recording one (1) new song; distributing the new song for commercial and/or non-profit purposes; and creating music videos and promotional materials, subject to the usage limits set forth in the License Terms above.

3. RESTRICTIONS. Licensee may not: re-sell, sub-license, or otherwise transfer the Beat or this license to any third party; use the Beat as a sample in another beat or instrumental; register the Beat's underlying composition with any Performing Rights Organization (PRO) as Licensee's exclusive composition; or use the Beat in any way that would infringe upon Licensor's copyrights.

4. CREDIT. Licensee agrees to credit Licensor as "Prod. by O'Neil Beats" in all works using the Beat, including but not limited to song titles, album credits, and video descriptions.

5. OWNERSHIP. Licensor retains all ownership and copyright in the Beat. This Agreement does not transfer any ownership rights to Licensee. All rights not specifically granted herein are reserved by Licensor.

6. TERMINATION. This license automatically terminates if Licensee breaches any term of this Agreement. Upon termination, Licensee must cease all use of the Beat and destroy all copies in their possession.`;

    doc.text(legalText, 60, doc.y, { width: 492, lineGap: 2 });
    doc.moveDown(1);

    // ── Signatures ───────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e');
    doc.text('LICENSOR', 60, doc.y + 20, { width: 200 });
    doc.text('LICENSEE', 360, doc.y - 14, { width: 200 });

    doc.font('Helvetica').fontSize(9).fillColor('#666666');
    doc.text("O'Neil Beats (Digitally Signed)", 60, doc.y + 5, { width: 200 });
    doc.text(buyer.name || buyer.email, 360, doc.y - 14, { width: 200 });
    doc.text(purchaseDate, 60, doc.y + 5, { width: 200 });
    doc.text(purchaseDate, 360, doc.y - 14, { width: 200 });

    // ── Footer ───────────────────────────────────────────────────────────────
    doc.rect(0, doc.page.height - 40, 612, 40).fill('#1a1a2e');
    doc.font('Helvetica').fontSize(8).fillColor('#888888');
    doc.text(
      `O'Neil Beats  •  produceroneil@gmail.com  •  Order: ${orderId}  •  ${purchaseDate}`,
      60, doc.page.height - 25, { align: 'center', width: 492 }
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
