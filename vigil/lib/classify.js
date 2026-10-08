'use strict';

// Keyword rules that sort a headline or dispatch type into one of the app's
// categories. Order matters: the first matching rule wins. Severity: 3 is
// critical (life safety now), 2 is serious, 1 is informational.
const RULES = [
  { category: 'missing', severity: 3, re: /\b(amber alert|child abduction|endangered missing)\b/i },
  { category: 'crime', severity: 3, re: /\b(active shooter|shooting|shot|shots fired|gunfire|homicide|murder(ed)?|stabb(ed|ing)|hostage|barricaded)\b/i },
  { category: 'hazard', severity: 3, re: /\b(evacuat(e|ion|ions)|shelter[- ]in[- ]place|hazmat|hazardous materials|chemical (leak|spill)|explosion)\b/i },
  { category: 'fire', severity: 2, re: /\b(wildfire|brush fire|house fire|structure fire|apartment fire|fire crews|firefighters|blaze|fire)\b(?!d)/i },
  { category: 'missing', severity: 2, re: /\b(missing|silver alert|runaway)\b/i },
  { category: 'crime', severity: 2, re: /\b(robbery|robbed|carjack(ed|ing)|armed|assault(ed)?|burglary|break-in|kidnap(ped|ping)?|stolen vehicle|pursuit|chase|arrest(ed)?|suspect|police|sheriff|deputies|swat)\b/i },
  { category: 'traffic', severity: 2, re: /\b(crash|collision|wreck|rollover|pedestrian (struck|hit)|hit-and-run|road closed|lanes? (blocked|closed)|i-\d+|us-\d+|highway)\b/i },
  { category: 'medical', severity: 2, re: /\b(overdose|cardiac|unconscious|medical emergency|ambulance|ems|drowning|aid response|medic response)\b/i },
  { category: 'hazard', severity: 2, re: /\b(gas leak|power outage|downed (power )?lines?|boil water|water main|bomb threat|suspicious package)\b/i },
  { category: 'weather', severity: 2, re: /\b(tornado|severe thunderstorm|flood(ing)?|hurricane|tropical storm|blizzard|winter storm|heat advisory|wind advisory)\b/i },
];

// Words that make a "fire" match a false positive ("coach fired", "fires back").
const FIRE_FALSE_POSITIVE = /\b(fired|fires back|ceasefire|cease-fire|on fire (?:from|for) (?:fans|critics))\b/i;

function classify(text) {
  const t = String(text || '');
  for (const rule of RULES) {
    if (!rule.re.test(t)) continue;
    if (rule.category === 'fire' && FIRE_FALSE_POSITIVE.test(t) && !/\b(house|structure|brush|wild|apartment)\s?fire/i.test(t)) continue;
    return { category: rule.category, severity: rule.severity };
  }
  return null;
}

module.exports = { classify };
