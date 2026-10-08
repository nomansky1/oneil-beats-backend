'use strict';

// Groups articles about the same event so one story shows "reported by 4
// outlets" instead of four near-identical cards. Greedy single pass over
// articles sorted oldest-first, matching on title word overlap.
const STOP = new Set(
  'a an the and or of to in on at for from by with after before over into as is are was were be been has have had it its this that near police says said say new update updates video watch live breaking'.split(' ')
);

function tokens(title) {
  return new Set(
    String(title)
      .toLowerCase()
      .replace(/[’']s\b/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  // Overlap coefficient: headlines vary a lot in length, so compare against
  // the shorter one rather than the union.
  return shared / Math.min(a.size, b.size);
}

function clusterArticles(articles, threshold = 0.5) {
  const sorted = [...articles].sort((x, y) => new Date(x.published) - new Date(y.published));
  const clusters = [];
  for (const art of sorted) {
    const t = tokens(art.title);
    let best = null, bestScore = 0;
    for (const c of clusters) {
      const score = similarity(t, c.tokens);
      if (score > bestScore) { best = c; bestScore = score; }
    }
    if (best && bestScore >= threshold) {
      best.articles.push(art);
      for (const w of t) best.tokens.add(w);
    } else {
      clusters.push({ tokens: t, articles: [art] });
    }
  }
  return clusters.map((c) => c.articles);
}

module.exports = { clusterArticles, tokens, similarity };
