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

module.exports = { generateLicensePDF, LICENSE_TERMS };
