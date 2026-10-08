'use strict';

// SAMPLE DATA for the phone preview only. Every event here is invented to
// show how the app behaves; none of it describes something that happened.
// Source names are placeholders on purpose, so nothing is attributed to a
// real newsroom or agency. The live app never uses this file.
//
// Times are minutes before the page opened (`ago`). `releaseAfter` makes an
// item "happen" that many seconds after opening, to demo live updates.

const HOME = { lat: 43.2342, lon: -86.2484, label: 'Muskegon, MI' };

// Offsets in miles from a center point (south and east are negative/positive).
function at(center, northMi, eastMi) {
  return {
    lat: +(center.lat + northMi / 69.0).toFixed(5),
    lon: +(center.lon + eastMi / (69.17 * Math.cos((center.lat * Math.PI) / 180))).toFixed(5),
  };
}

const SRC = {
  dispatch: { name: 'County 911 dispatch (sample)', kind: 'official', tier: 'gov' },
  police: { name: 'City police department (sample)', kind: 'official', tier: 'gov' },
  fire: { name: 'Fire department dispatch (sample)', kind: 'official', tier: 'gov' },
  city: { name: 'City public works (sample)', kind: 'official', tier: 'gov' },
  weather: { name: 'Weather service office (sample)', kind: 'official', tier: 'gov' },
  quakes: { name: 'Earthquake survey (sample)', kind: 'official', tier: 'gov' },
  policeX: { name: '@CityPolice_sample on X · government account', kind: 'official', tier: 'gov' },
  tvA: { name: 'Local TV Station A (sample)', kind: 'news', tier: 'established' },
  paperB: { name: 'Daily Newspaper B (sample)', kind: 'news', tier: 'established' },
  radioC: { name: 'Public Radio C (sample)', kind: 'news', tier: 'established' },
  siteD: { name: 'Neighborhood News Site D (sample)', kind: 'news', tier: 'unrated' },
  wireE: { name: 'Wire Service E (sample)', kind: 'news', tier: 'established' },
  diarioF: { name: 'Periódico local F (muestra)', kind: 'news', tier: 'established' },
  neighborX: { name: '@neighbor_sample on X', kind: 'social', tier: 'unrated' },
  community: { name: 'Community member (sample)', kind: 'community', tier: 'community' },
};
const src = (key, ago, headline) => ({ ...SRC[key], ...(ago != null ? { ago } : {}), ...(headline ? { headline } : {}), url: '' });

// Placeholder pictures for sample stories: simple drawings, not photos,
// labeled SAMPLE IMAGE. The live app shows each outlet's own article image.
const SCENES = {
  fire: { sky: ['#2a0f08', '#140a0a'], glow: '#ff8a34', shape: '<path d="M60 200V128l60-42 60 42v72z" fill="#0b0708"/><path d="M150 112l40-30 40 30v88h-80z" fill="#120a0b"/><rect x="92" y="150" width="18" height="24" fill="#ffb15c" opacity=".8"/>' },
  police: { sky: ['#0b1530', '#070a14'], glow: '#4b7bff', shape: '<rect x="0" y="160" width="320" height="40" fill="#0b0d14"/><rect x="118" y="132" width="84" height="28" rx="8" fill="#151a26"/><rect x="134" y="124" width="22" height="8" rx="2" fill="#ff4d5e"/><rect x="164" y="124" width="22" height="8" rx="2" fill="#4b7bff"/>' },
  brush: { sky: ['#2b1406', '#120a06'], glow: '#ff6a1a', shape: '<path d="M0 170q60-50 120-20t110-30 90 10v70H0z" fill="#0d0907"/><path d="M0 186q80-30 160-8t160-6v28H0z" fill="#070505"/>' },
  city: { sky: ['#10162b', '#080a12'], glow: '#ffb020', shape: '<path d="M0 200V120h30v-30h26v40h20V80h34v120zM120 200v-96h28v-24h24v120zM190 200v-70h40v-40h30v110zM270 200v-84h50v84z" fill="#0b0e18"/>' },
};
function photo(scene, credit) {
  const sc = SCENES[scene];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sc.sky[0]}"/><stop offset="1" stop-color="${sc.sky[1]}"/></linearGradient><radialGradient id="g" cx=".5" cy=".75" r=".6"><stop offset="0" stop-color="${sc.glow}" stop-opacity=".55"/><stop offset="1" stop-color="${sc.glow}" stop-opacity="0"/></radialGradient></defs><rect width="320" height="200" fill="url(#s)"/><rect width="320" height="200" fill="url(#g)"/>${sc.shape}<text x="12" y="22" font-family="sans-serif" font-size="11" font-weight="700" fill="#fff" opacity=".7" letter-spacing="1.5">SAMPLE IMAGE</text></svg>`;
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, credit: SRC[credit].name, link: '', sample: true };
}

function item(id, center, n, e, fields) {
  return { id: `sample:${id}`, kind: 'incident', precision: 'block', confirmed: [], unconfirmed: [], updates: [], ...at(center, n, e), ...fields };
}

function muskegon() {
  const C = HOME;
  const place = 'Muskegon, MI';
  return [
    item('m-shots', C, -0.9, 0.6, {
      category: 'crime', severity: 3, ago: 9, place: 'Southeast side, Muskegon',
      title: 'Shots fired reported; officers searching the area',
      summary: 'Police were sent to a report of several gunshots near a residential block. Officers are checking the area.',
      sources: [src('dispatch', 9), src('tvA', 4, 'Police search neighborhood after reports of gunfire'), src('policeX', 3)],
      confirmed: ['Officers were dispatched to a shots-fired call', 'No injuries found as of the latest update'],
      unconfirmed: ['Whether anyone was hit', 'How many people were involved'],
      updates: [{ ago: 9, text: 'Dispatch logs a shots-fired call' }, { ago: 6, text: 'Several units arrive on scene' }, { ago: 2, text: 'Police say no injuries found so far' }],
    }),
    item('m-bangs', C, -1.05, 0.85, {
      kind: 'incident', category: 'community', severity: 1, ago: 6, place: 'Southeast side, Muskegon',
      title: 'Loud bangs heard; might be fireworks',
      summary: 'A neighbor reported several loud bangs. Not confirmed by police.',
      sources: [src('community', 6)],
      unconfirmed: ['What caused the noise', 'Whether this is related to the shots-fired call nearby'],
    }),
    item('m-vehfire', C, -0.4, -0.6, {
      category: 'fire', severity: 2, ago: 3, place: 'Downtown Muskegon',
      title: 'Vehicle fire in a parking lot; no injuries reported',
      sources: [src('fire', 3)],
      confirmed: ['Engine company dispatched'], unconfirmed: ['Cause of the fire'],
      updates: [{ ago: 3, text: 'Engine dispatched to a vehicle fire' }],
    }),
    item('m-housefire', C, -1.4, -0.4, {
      category: 'fire', severity: 2, ago: 22, place: 'Muskegon Heights',
      title: 'House fire: smoke showing from a two-story home',
      summary: 'Crews from two departments responded. Everyone is reported out of the home.',
      sources: [src('fire', 22), src('tvA', 15, 'Crews battle house fire; family safe'), src('paperB', 11, 'Two departments respond to Muskegon Heights house fire')],
      image: photo('fire', 'tvA'),
      confirmed: ['Fire crews on scene', 'Residents are out of the home'], unconfirmed: ['Cause', 'Extent of damage'],
      updates: [{ ago: 22, text: 'First engine reports smoke showing' }, { ago: 14, text: 'Second alarm requested for more crews' }, { ago: 5, text: 'Fire under control; crews checking for hot spots' }],
    }),
    item('m-crash', C, -0.5, 1.5, {
      category: 'traffic', severity: 2, ago: 14, place: 'East side, Muskegon',
      title: 'Two-vehicle crash with injuries; one lane blocked',
      sources: [src('dispatch', 14)],
      confirmed: ['EMS and police responding'], unconfirmed: ['Number of people hurt'],
      updates: [{ ago: 14, text: 'Crash reported with possible injuries' }, { ago: 8, text: 'One eastbound lane blocked' }],
    }),
    item('m-medical', C, -0.3, 0.2, {
      category: 'medical', severity: 1, ago: 31, place: 'Downtown Muskegon',
      title: 'Medical call: person down near a bus stop',
      sources: [src('dispatch', 31)], confirmed: ['EMS dispatched'],
    }),
    item('m-robbery', C, -1.7, 1.1, {
      category: 'crime', severity: 2, ago: 48, place: 'South side, Muskegon',
      title: 'Robbery at a convenience store; suspect left on foot',
      summary: 'Police say a man showed a weapon and took cash. No one was hurt.',
      sources: [src('police', 46), src('radioC', 20, 'Police investigate convenience store robbery')],
      confirmed: ['No injuries', 'Suspect left on foot'], unconfirmed: ['Which direction the suspect went'],
      updates: [{ ago: 48, text: 'Robbery reported' }, { ago: 30, text: 'K-9 unit searched the area without finding the suspect' }],
    }),
    item('m-missing', C, -0.2, 2.2, {
      category: 'missing', severity: 2, ago: 95, place: 'East side, Muskegon',
      title: 'Missing 79-year-old man with memory loss; last seen walking',
      summary: 'Police ask anyone who sees him to call 911. Description is on the department’s post.',
      sources: [src('policeX', 92), src('tvA', 70), src('paperB', 60)],
      confirmed: ['Police are asking the public for help'], unconfirmed: [],
      updates: [{ ago: 92, text: 'Police post a missing person alert' }, { ago: 40, text: 'Search teams checking nearby parks' }],
    }),
    item('m-gas', C, -1.6, 0.3, {
      category: 'hazard', severity: 2, ago: 140, place: 'Muskegon Heights',
      title: 'Gas leak: crews shut off service; avoid the block',
      sources: [src('fire', 140)], confirmed: ['Gas service shut off to nearby homes'], unconfirmed: ['When service will be restored'],
    }),
    item('m-outage', C, -0.9, -1.1, {
      category: 'hazard', severity: 1, ago: 55, place: 'West side, Muskegon',
      title: 'Power outage affecting about 1,200 customers',
      sources: [src('dispatch', 55), src('tvA', 35)],
      unconfirmed: ['Cause', 'Restoration time'],
    }),
    item('m-overdose', C, -0.15, 1.0, {
      category: 'medical', severity: 2, ago: 700, place: 'Downtown Muskegon',
      title: 'Overdose call; officers give naloxone before EMS arrives',
      sources: [src('dispatch', 700)], confirmed: ['Patient taken to hospital'],
    }),
    item('m-water', C, -0.7, -1.0, {
      category: 'traffic', severity: 1, ago: 300, place: 'West side, Muskegon',
      title: 'Road closed for a water main repair',
      sources: [src('city', 300)], confirmed: ['Detour posted'], unconfirmed: ['Reopening time'],
    }),
    item('m-breakins', C, -1.2, -1.3, {
      category: 'crime', severity: 2, ago: 380, place: 'Norton Shores',
      title: 'Several car break-ins reported in a parking lot',
      sources: [src('police', 380)], confirmed: ['Four vehicles reported damaged'],
    }),
    item('m-shoplift', C, -1.8, 1.6, {
      category: 'crime', severity: 1, ago: 75, place: 'South side, Muskegon',
      title: 'Shoplifting suspect detained at a pharmacy',
      sources: [src('police', 75)],
    }),
    item('m-suspicious', C, -1.3, -0.9, {
      category: 'community', severity: 1, ago: 40, place: 'Roosevelt Park',
      title: 'Person seen trying car door handles (community report)',
      summary: 'Neighbor describes someone in a gray hoodie walking the street and pulling on car doors.',
      sources: [src('community', 40)], unconfirmed: ['Not reported to or confirmed by police'],
    }),
    item('m-disabled', C, -1.5, -1.0, {
      category: 'traffic', severity: 1, ago: 12, place: 'Norton Shores',
      title: 'Disabled vehicle blocking the right lane',
      sources: [src('dispatch', 12)],
    }),
    item('m-brush', C, -1.9, -0.8, {
      category: 'fire', severity: 1, ago: 1500, place: 'Roosevelt Park',
      title: 'Small brush fire near the rail line, contained',
      sources: [src('fire', 1500)],
    }),
    item('m-burglary', C, -0.6, 1.9, {
      category: 'crime', severity: 2, ago: 2900, place: 'East side, Muskegon',
      title: 'Home burglary reported; no one was inside',
      sources: [src('police', 2900), src('siteD', 2700)],
    }),
    item('m-ramp', C, -2.6, 2.6, {
      category: 'traffic', severity: 2, ago: 4300, place: 'US-31 near Muskegon',
      title: 'Crash closes a US-31 ramp for two hours',
      sources: [src('dispatch', 4300), src('tvA', 4250)],
    }),
    item('m-shooting-old', C, -1.0, -0.2, {
      category: 'crime', severity: 3, ago: 8000, place: 'Muskegon Heights',
      title: 'Shooting leaves one person hurt; police say it was not random',
      sources: [src('police', 7990), src('tvA', 7900), src('paperB', 7800)],
      confirmed: ['One person treated at a hospital', 'Police believe the people involved knew each other'],
      unconfirmed: ['Whether anyone has been arrested'],
    }),
    // City-level news stories (no exact address in the coverage)
    { ...item('m-stabbing', C, 0, 0, {}), kind: 'story', precision: 'city', place,
      category: 'crime', severity: 2, ago: 600,
      title: 'Police investigate overnight stabbing; victim in stable condition',
      sources: [src('tvA', 600), src('paperB', 560, 'Man stabbed overnight, police say'), src('siteD', 520)],
      image: photo('police', 'tvA'),
      confirmed: ['One person was stabbed', 'The victim is in stable condition'], unconfirmed: ['Where exactly it happened', 'Whether a suspect is in custody'] },
    { ...item('m-pursuit', C, 0, 0, {}), kind: 'story', precision: 'city', place,
      category: 'crime', severity: 2, ago: 210,
      title: 'Driver arrested after short police chase ends in crash',
      sources: [src('siteD', 210)], unconfirmed: ['Charges', 'Whether anyone was hurt'] },
    { ...item('m-heli', C, 0, 0, {}), kind: 'story', precision: 'city', place,
      category: 'community', severity: 1, ago: 18,
      title: 'Neighbors say a police helicopter is circling the south side',
      sources: [src('neighborX', 18)], unconfirmed: ['Why the helicopter is there'] },
    // Area-wide official alert
    { ...item('m-storm', C, 0, 0, {}), kind: 'area', precision: 'area', areaRadiusMi: 30, place: 'Muskegon County; Ottawa County',
      category: 'weather', severity: 2, ago: 12, expiresIn: 45,
      title: 'Severe Thunderstorm Warning',
      summary: 'Storms with 60 mph wind gusts and quarter-size hail moving east at 35 mph.',
      details: 'Move to an interior room on the lowest floor. Expect damage to roofs, siding and trees.',
      sources: [src('weather', 12)], confirmed: ['Warning issued for the county'] },
    // Released while the preview is open, to show live updates
    item('m-live1', C, -0.8, -0.2, {
      category: 'traffic', severity: 2, ago: 0, releaseAfter: 20, place: 'Downtown Muskegon',
      title: 'Crash with airbags deployed; police and EMS on the way',
      sources: [src('dispatch', 0)], updates: [{ ago: 0, text: 'Call received' }],
    }),
    item('m-live2', C, -1.25, 0.45, {
      category: 'crime', severity: 2, ago: 0, releaseAfter: 50, place: 'South side, Muskegon',
      title: 'Fight outside a bar; one person detained',
      sources: [src('dispatch', 0), src('policeX', 0)],
    }),
    item('m-live3', C, -0.35, 1.2, {
      category: 'medical', severity: 1, ago: 0, releaseAfter: 95, place: 'East side, Muskegon',
      title: 'Person hurt in a fall from a ladder; EMS on scene',
      sources: [src('dispatch', 0)],
    }),
  ];
}

function nationwide() {
  const P = (lat, lon) => ({ lat, lon });
  return [
    item('sea-aid', P(47.6097, -122.3331), 0.3, 0.2, { category: 'medical', severity: 1, ago: 7, place: 'Downtown Seattle, WA', title: 'Aid response: medic unit dispatched', sources: [src('fire', 7)] }),
    item('sea-fire', P(47.6097, -122.3331), -1.2, 0.8, { category: 'fire', severity: 2, ago: 26, place: 'Seattle, WA', title: 'Apartment fire: residents evacuated from third floor', sources: [src('fire', 26), src('tvA', 12), src('paperB', 9)], image: photo('city', 'paperB') }),
    item('chi-rob', P(41.8781, -87.6298), 0.4, -0.3, { category: 'crime', severity: 2, ago: 33, place: 'The Loop, Chicago, IL', title: 'Robbery reported on a train platform; suspect in custody', sources: [src('police', 33), src('radioC', 20)] }),
    { ...item('hou-flood', P(29.7604, -95.3698), 0, 0, {}), kind: 'area', precision: 'area', areaRadiusMi: 30, place: 'Harris County, TX', category: 'weather', severity: 3, ago: 18, expiresIn: 120, title: 'Flash Flood Warning', summary: 'Heavy rain is flooding low-lying roads. Turn around, don’t drown.', sources: [src('weather', 18)] },
    item('hou-crash', P(29.7604, -95.3698), 1.5, -2.0, { category: 'traffic', severity: 2, ago: 41, place: 'Houston, TX', title: 'Multi-vehicle crash closes two freeway lanes', sources: [src('dispatch', 41), src('tvA', 30)] }),
    item('la-brush', P(34.1184, -118.3004), 0.8, 0.5, { category: 'fire', severity: 3, ago: 52, place: 'Hillside neighborhood, Los Angeles, CA', title: 'Brush fire prompts evacuation orders for nearby streets', sources: [src('fire', 52), src('tvA', 40), src('paperB', 35), src('wireE', 25)], image: photo('brush', 'wireE'), confirmed: ['Evacuation orders issued for several streets'], unconfirmed: ['Acres burned'] }),
    item('la-quake', P(34.0522, -118.2437), 4, 6, { category: 'quake', severity: 1, ago: 130, place: 'Near Los Angeles, CA', precision: 'exact', title: 'M3.4 earthquake', summary: 'Light shaking reported. No damage expected at this size.', sources: [src('quakes', 128)], unconfirmed: ['Magnitude may be revised'] }),
    item('nyc-track', P(40.7831, -73.9712), 0.2, 0.1, { category: 'hazard', severity: 2, ago: 64, place: 'Manhattan, New York, NY', title: 'Subway service suspended after a track fire', sources: [src('fire', 64), src('radioC', 50), src('paperB', 44)] }),
    { ...item('mia-coast', P(25.7617, -80.1918), 0, 0, {}), kind: 'area', precision: 'area', areaRadiusMi: 30, place: 'Miami-Dade County, FL', category: 'weather', severity: 1, ago: 200, expiresIn: 300, title: 'Coastal Flood Advisory', summary: 'King tide flooding expected in low spots near the bay.', sources: [src('weather', 200)] },
    item('det-crime', P(42.3314, -83.0458), -1.0, 1.3, { category: 'crime', severity: 2, ago: 90, place: 'Detroit, MI', title: 'Carjacking reported at a gas station; no injuries', sources: [src('police', 88), src('tvA', 70)] }),
    item('gr-crash', P(42.9634, -85.6681), 0.6, -0.8, { category: 'traffic', severity: 1, ago: 25, place: 'Grand Rapids, MI', title: 'Crash slows traffic on the highway near downtown', sources: [src('dispatch', 25)] }),
    item('anc-quake', P(61.5, -149.9), 0, 0, { category: 'quake', severity: 2, ago: 300, place: '40 km north of Anchorage, AK', precision: 'exact', title: 'M4.6 earthquake', summary: 'Felt widely in Anchorage. No tsunami threat.', sources: [src('quakes', 298)] }),
    item('hnl-brush', P(21.4389, -158.1700), 0, 0, { category: 'fire', severity: 2, ago: 150, place: 'West Oʻahu, HI', title: 'Brush fire closes a coastal road', sources: [src('fire', 150), src('tvA', 110)] }),
    // Territories
    item('sju-robo', P(18.4655, -66.1057), -0.5, 0.4, { category: 'crime', severity: 2, ago: 70, place: 'San Juan, PR', title: 'Robo a mano armada en una farmacia; la policía investiga', summary: 'Armed robbery at a pharmacy; police are investigating. (Spanish-language source.)', sources: [src('police', 70), src('diarioF', 45, 'Asaltan farmacia en San Juan')] }),
    { ...item('sju-flood', P(18.4655, -66.1057), 0, 0, {}), kind: 'area', precision: 'area', areaRadiusMi: 25, place: 'San Juan and Carolina, PR', category: 'weather', severity: 1, ago: 35, expiresIn: 150, title: 'Flood Advisory · Advertencia de inundaciones', summary: 'Urban and small stream flooding from heavy showers.', sources: [src('weather', 35)] },
    { ...item('gu-typhoon', P(13.4757, 144.7489), 0, 0, {}), kind: 'area', precision: 'area', areaRadiusMi: 40, place: 'Guam', category: 'weather', severity: 2, ago: 240, expiresIn: 720, title: 'Typhoon Watch', summary: 'Damaging winds possible within 48 hours. Secure loose items and check supplies.', sources: [src('weather', 240)] },
    item('gu-crash', P(13.4757, 144.7489), 1.0, 0.5, { category: 'traffic', severity: 1, ago: 80, place: 'Hagåtña, GU', title: 'Crash blocks one lane of the main coastal road', sources: [src('police', 80)] }),
    item('vi-water', P(18.3419, -64.9307), 0.3, 0.6, { category: 'hazard', severity: 1, ago: 400, place: 'St. Thomas, VI', title: 'Boil water notice for parts of St. Thomas', sources: [src('city', 400), src('paperB', 300)] }),
    item('as-quake', P(-14.9, -171.6), 0, 0, { category: 'quake', severity: 2, ago: 500, place: 'Samoa Islands region', precision: 'exact', title: 'M5.1 earthquake', summary: 'No tsunami threat to American Samoa.', sources: [src('quakes', 498)] }),
    { ...item('mp-craft', P(15.1778, 145.7505), 0, 0, {}), kind: 'area', precision: 'area', areaRadiusMi: 40, place: 'Saipan, Tinian and Rota, MP', category: 'weather', severity: 1, ago: 180, expiresIn: 600, title: 'Small Craft Advisory', summary: 'Hazardous seas for small boats through tomorrow.', sources: [src('weather', 180)] },
  ];
}

// Sample plate-camera positions for the preview only (the live app loads
// real mapped cameras from OpenStreetMap).
function cameras() {
  const C = HOME;
  const spots = [[-0.35, 0.9, 90], [-1.1, 0.2, 180], [-0.6, -0.8, 270], [-1.7, 1.4, 0], [-0.2, 1.8, 45], [-1.35, -0.6, 135], [-2.1, 0.7, 315], [-0.9, 1.6, null]];
  return spots.map(([n, e, dir], i) => ({
    id: `sample:cam-${i}`, kind: 'camera', ...at(C, n, e), direction: dir,
    manufacturer: 'Flock Safety', operator: 'Sample police department', model: '', sample: true, url: '',
  }));
}

// Placeholder registry records for the preview only. Not real people: no
// names, photos or addresses of anyone. The last one appears 25 seconds
// after the page opens to show the "newly listed" alert.
function registrants() {
  const C = HOME;
  const spots = [[-0.6, 0.4, 'A', 'Tier II'], [-1.3, -0.5, 'B', 'Tier III'], [0.4, 1.1, 'C', 'Tier I'], [-0.9, 1.5, 'D', 'Tier II', 25]];
  return spots.map(([n, e, letter, level, releaseAfter]) => ({
    id: `sample:reg-${letter}`, kind: 'registrant', ...at(C, n, e),
    name: `Sample Registrant ${letter}`, photo: '', precision: 'address',
    address: 'Sample address (placeholder)', offenses: ['Sample offense (placeholder text)'], level,
    updated: '', recordUrl: '', source: { name: 'State registry (sample)', url: '' }, sample: true,
    ...(releaseAfter ? { releaseAfter } : {}),
  }));
}

const SAMPLE_AREAS = [
  HOME,
  { label: 'Seattle, WA', lat: 47.6097, lon: -122.3331 },
  { label: 'Los Angeles, CA', lat: 34.0522, lon: -118.2437 },
  { label: 'San Juan, PR', lat: 18.4655, lon: -66.1057 },
  { label: 'Hagåtña, GU', lat: 13.4757, lon: 144.7489 },
];

module.exports = { HOME, SAMPLE_AREAS, items: () => muskegon().concat(nationwide()), cameras, registrants };
