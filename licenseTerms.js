// ─── CANONICAL LICENSE TERMS — single source of truth ─────────────────────
//
// Every customer-facing surface MUST derive license terms from this file:
//   • backend/licenseGenerator.js   → the binding PDF contract sent via Stripe
//   • OneilBeatsApp/src/licenseTerms.js  → mirror copy (App.js + screenshot script)
//   • OneilBeatsApp/App.js LICENSE_INFO / LICENSE_DETAILS  → in-app popup
//   • OneilBeatsApp/generate-iap-screenshots.mjs  → Apple IAP review screenshots
//   • App Store Connect IAP localizations  → manual paste; check script prints text
//
// To change a license term:
//   1. Edit ONLY this file
//   2. Run `node scripts/check-license-consistency.mjs` from the parent dir to
//      verify all in-tree mirrors match and to print canonical ASC text
//   3. If ASC localizations changed, paste the printed text into
//      App Store Connect → In-App Purchases → <product> → English (U.S.)
//
// The Claude PostToolUse hook in .claude/settings.local.json runs the check
// automatically after edits to any of the dependent files; if drift is
// detected, the hook fails and prints what to fix.

const LICENSE_TERMS = {
  lease: {
    iapProductId: 'com.oneilbeats.app.license.lease',

    // Names / labels (per surface)
    pdfName: 'Basic Lease License',          // PDF header badge
    title: 'Basic Lease',                    // screenshot title + popup heading
    label: 'Lease',                          // app: short button label
    icon: 'musical-note',                    // app: Ionicons name

    // Pricing
    price: '$29.99',
    priceCents: 2999,
    priceKey: 'lease_price',                 // app: which beat field carries this price

    // Color
    color: '#f59e0b',                        // PDF accent + popup tint

    // Format / quality
    format: 'MP3',
    mp3Only: true,

    // Stream / use limits — single source of truth
    streams: '500,000',
    streamsShort: '500K',
    sales: '2,500',
    broadcasts: '1',
    musicVideos: '1',

    // Description copy
    descriptionShort: 'MP3 · 500K streams',  // app LICENSE_INFO.desc
    descriptionLong: 'Non-exclusive license for independent releases with limited distribution.',
    rights: [
      'Up to 500,000 streams',
      'Up to 2,500 sales',
      '1 broadcast / radio play',
      '1 music video',
      'Non-exclusive rights',
    ],

    // App Store Connect IAP localization (English U.S.) — paste exactly into ASC
    ascDisplayName: 'Basic Lease — MP3 License',
    ascDescription: 'MP3 lease for one beat. Up to 500,000 streams.',

    // Legal flags
    nonProfit: true,
    exclusive: false,
  },

  premium: {
    iapProductId: 'com.oneilbeats.app.license.premium',

    pdfName: 'Premium Lease License',
    title: 'Premium Lease',
    label: 'Premium',
    icon: 'diamond',

    price: '$99.99',
    priceCents: 9999,
    priceKey: 'premium_price',

    color: '#8b5cf6',

    format: 'WAV + MP3',
    mp3Only: false,

    streams: '1,000,000',
    streamsShort: '1M',
    sales: '5,000',
    broadcasts: '2',
    musicVideos: '2',

    descriptionShort: 'WAV · 1M streams',
    descriptionLong: 'Non-exclusive license for commercial releases with wider distribution rights.',
    rights: [
      'Up to 1,000,000 streams',
      'Up to 5,000 sales',
      '2 broadcast / radio plays',
      '2 music videos',
      'Non-exclusive rights',
      'High quality untagged WAV',
    ],

    ascDisplayName: 'Premium Lease — MP3 + WAV',
    ascDescription: 'MP3 + WAV lease for one beat. Up to 1,000,000 streams.',

    nonProfit: true,
    exclusive: false,
  },

  stems: {
    iapProductId: 'com.oneilbeats.app.license.stems',

    pdfName: 'Unlimited License (Stems)',
    title: 'Stems / Track-Out',
    label: 'Stems',
    icon: 'layers',

    price: '$199.99',
    priceCents: 19999,
    priceKey: 'stems_price',

    color: '#10b981',

    format: 'Stems (ZIP) + WAV + MP3',
    mp3Only: false,

    streams: 'Unlimited',
    streamsShort: 'Unlimited',
    sales: 'Unlimited',
    broadcasts: 'Unlimited',
    musicVideos: 'Unlimited',

    descriptionShort: 'Stems · Unlimited',
    descriptionLong: 'Full stems + unlimited distribution. Maximum creative control.',
    rights: [
      'Unlimited streams',
      'Unlimited sales',
      'Unlimited broadcasts',
      'Unlimited music videos',
      'Non-exclusive rights',
      'Individual track stems for mixing',
      'Full creative control',
    ],

    ascDisplayName: 'Stems / Track-Out License',
    ascDescription: 'Full stems + WAV + MP3 for one beat. Unlimited streams.',

    nonProfit: true,
    exclusive: false,
  },

  // Exclusive is NOT an IAP — handled off-platform via "Contact Producer"
  // email. Kept here so the PDF generator and app can reference the same
  // terms when an exclusive deal is finalised manually.
  exclusive: {
    iapProductId: null,

    pdfName: 'Exclusive Rights License',
    title: 'Exclusive Rights',
    label: 'Exclusive',
    icon: 'flame',

    price: 'Contact Producer',
    priceCents: null,
    priceKey: 'exclusive_price',

    color: '#ef4444',

    format: 'All Files + Stems + Full Ownership',
    mp3Only: false,

    streams: 'Unlimited',
    streamsShort: 'Unlimited',
    sales: 'Unlimited',
    broadcasts: 'Unlimited',
    musicVideos: 'Unlimited',

    descriptionShort: 'Full Buyout · Exclusive',
    descriptionLong: 'Exclusive ownership. Beat removed from store after purchase.',
    rights: [
      'Unlimited streams',
      'Unlimited sales',
      'Unlimited broadcasts',
      'Unlimited music videos',
      'Exclusive ownership',
      'Beat removed from store',
      'Full creative control',
      'Resale rights',
    ],

    ascDisplayName: null,
    ascDescription: null,

    nonProfit: true,
    exclusive: true,
  },
};

module.exports = { LICENSE_TERMS };
