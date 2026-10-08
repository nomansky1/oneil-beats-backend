'use strict';

// Official public sex offender registry site for every state, DC and the
// five inhabited territories, from the list the U.S. Dept. of Justice
// links at nsopw.gov/all-registries. The app links to these sites; it does
// not copy their records. `checked: false` means the address was found on
// the agency's own pages but not on a .gov domain; recheck before launch.
const REGISTRIES = {
  AL: { url: 'https://app.alea.gov/community/default.aspx', agency: 'Alabama Law Enforcement Agency' },
  AK: { url: 'https://sor.dps.alaska.gov/', agency: 'Alaska Dept. of Public Safety' },
  AZ: { url: 'https://www.azdps.gov/content/basic-page/106', agency: 'Arizona Dept. of Public Safety' },
  AR: { url: 'https://portal.arkansas.gov/service/ar-sex-offender-registry-search/', agency: 'Arkansas Crime Information Center' },
  CA: { url: 'https://www.meganslaw.ca.gov/', agency: 'California Dept. of Justice' },
  CO: { url: 'https://apps.colorado.gov/apps/dps/sor/', agency: 'Colorado Bureau of Investigation' },
  CT: { url: 'https://portal.ct.gov/services/public-safety/sex-offender-registry', agency: 'Connecticut Dept. of Emergency Services & Public Protection' },
  DE: { url: 'https://sexoffender.dsp.delaware.gov/', agency: 'Delaware State Police' },
  DC: { url: 'https://mpdc.dc.gov/service/sex-offender-registry', agency: 'Metropolitan Police Department' },
  FL: { url: 'https://offender.fdle.state.fl.us/', agency: 'Florida Dept. of Law Enforcement' },
  GA: { url: 'https://state.sor.gbi.ga.gov/sort_public/', agency: 'Georgia Bureau of Investigation' },
  HI: { url: 'https://sexoffenders.ehawaii.gov/sexoffender/welcome.html', agency: 'Hawaii Criminal Justice Data Center' },
  ID: { url: 'https://apps.isp.idaho.gov/sor_id/', agency: 'Idaho State Police' },
  IL: { url: 'https://sor.isp.illinois.gov/', agency: 'Illinois State Police' },
  IN: { url: 'https://www.in.gov/idoc/divisions/sex-and-violent-offender-registry/', agency: 'Indiana Dept. of Correction' },
  IA: { url: 'https://www.iowasexoffender.gov/', agency: 'Iowa Dept. of Public Safety' },
  KS: { url: 'https://www.kbi.ks.gov/registeredoffender/', agency: 'Kansas Bureau of Investigation' },
  KY: { url: 'http://kspsor.state.ky.us/', agency: 'Kentucky State Police' },
  LA: { url: 'https://lsp.org/community-outreach/sex-offender-registry/', agency: 'Louisiana State Police', checked: false },
  ME: { url: 'https://apps.web.maine.gov/cgi-bin/sor/index.pl', agency: 'Maine State Police' },
  MD: { url: 'https://dpscs.maryland.gov/onlineservs/socem/default.shtml', agency: 'Maryland Dept. of Public Safety & Correctional Services' },
  MA: { url: 'https://www.mass.gov/orgs/sex-offender-registry-board', agency: 'Massachusetts Sex Offender Registry Board' },
  MI: { url: 'https://mspsor.com/', agency: 'Michigan State Police' },
  MN: { url: 'https://coms.doc.state.mn.us/publicregistrantsearch', agency: 'Minnesota Dept. of Corrections (Level 3)' },
  MS: { url: 'https://state.sor.dps.ms.gov/', agency: 'Mississippi Dept. of Public Safety' },
  MO: { url: 'https://www.mshp.dps.missouri.gov/CJ38/searchRegistry.jsp', agency: 'Missouri State Highway Patrol' },
  MT: { url: 'https://app.doj.mt.gov/apps/svow/default.aspx', agency: 'Montana Dept. of Justice' },
  NE: { url: 'https://sor.nebraska.gov/', agency: 'Nebraska State Patrol' },
  NV: { url: 'https://sexoffenders.nv.gov/', agency: 'Nevada Dept. of Public Safety' },
  NH: { url: 'https://business.nh.gov/nsor/', agency: 'New Hampshire State Police' },
  NJ: { url: 'https://njsp.njoag.gov/nj-sex-offender-registry/', agency: 'New Jersey State Police' },
  NM: { url: 'http://www.nmsexoffender.dps.state.nm.us/', agency: 'New Mexico Dept. of Public Safety', checked: false },
  NY: { url: 'https://www.criminaljustice.ny.gov/nsor/', agency: 'New York Division of Criminal Justice Services' },
  NC: { url: 'https://sexoffender.ncsbi.gov/', agency: 'North Carolina State Bureau of Investigation' },
  ND: { url: 'https://sexoffender.nd.gov/', agency: 'North Dakota Attorney General' },
  OH: { url: 'https://ohio.gov/residents/resources/sex-offender-search', agency: 'Ohio Attorney General' },
  OK: { url: 'https://sors.doc.ok.gov/ords/svorp/sors/r/sors/public-search', agency: 'Oklahoma Dept. of Corrections' },
  OR: { url: 'https://sexoffenders.osp.oregon.gov/', agency: 'Oregon State Police' },
  PA: { url: 'https://www.meganslaw.psp.pa.gov/', agency: 'Pennsylvania State Police' },
  RI: { url: 'https://risp.ri.gov/safety-education/sex-offenders', agency: 'Rhode Island State Police' },
  SC: { url: 'https://scor.sled.sc.gov/', agency: 'South Carolina Law Enforcement Division' },
  SD: { url: 'https://sor.sd.gov/', agency: 'South Dakota Attorney General' },
  TN: { url: 'https://sor.tbi.tn.gov/search', agency: 'Tennessee Bureau of Investigation' },
  TX: { url: 'https://publicsite.dps.texas.gov/SexOffenderRegistry', agency: 'Texas Dept. of Public Safety' },
  UT: { url: 'https://bci.utah.gov/offender-registries/', agency: 'Utah Bureau of Criminal Identification' },
  VT: { url: 'https://vcic.vermont.gov/sor', agency: 'Vermont Crime Information Center' },
  VA: { url: 'https://sex-offender.vsp.virginia.gov/sor/', agency: 'Virginia State Police', checked: false },
  WA: { url: 'https://www.wasor.org', agency: 'Washington Assn. of Sheriffs & Police Chiefs', checked: false },
  WV: { url: 'https://apps.wv.gov/StatePolice/SexOffender/', agency: 'West Virginia State Police' },
  WI: { url: 'https://appsdoc.wi.gov/public', agency: 'Wisconsin Dept. of Corrections' },
  WY: { url: 'https://wyomingdci.wyo.gov/criminal-justice-information-services-cjis/sex-offender-registry', agency: 'Wyoming Division of Criminal Investigation' },
  PR: { url: 'https://sor.cjis.pr.gov/', agency: 'Puerto Rico Dept. of Justice' },
  GU: { url: 'https://sor.guamcourts.gov/', agency: 'Judiciary of Guam' },
  VI: { url: 'https://usvi.nsopw.gov/', agency: 'Virgin Islands Dept. of Justice' },
  AS: { url: 'https://americansamoa.nsopw.gov/', agency: 'American Samoa Office of the Attorney General' },
  MP: { url: 'https://cnmi.nsopw.gov/', agency: 'CNMI Dept. of Public Safety' },
};

const NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

const registryFor = (stateCode) => (stateCode && REGISTRIES[stateCode] ? { state: stateCode, name: NAMES[stateCode], ...REGISTRIES[stateCode] } : null);

module.exports = { REGISTRIES, registryFor };
