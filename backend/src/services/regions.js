// Static region taxonomy for the Clients globe/map page. Offices have no
// region/country/business-type columns in the schema (see offices table —
// just code/name/is_hq/currency), and this grouping is presentation-only, so
// it's kept as a config map here rather than a migration. Keyed by office
// `code` (matches seed.js's OFFICES list).
//
// Source: the 3-region breakdown given for the Clients page (Australia,
// Europe, Asia). Two real offices — Texas (USA) and Germany — don't fit any
// of those 3 and are placed in a 4th bucket so they aren't silently dropped.
// Two names mentioned in that breakdown — Netherlands and Thailand — have no
// office row yet; they're listed here anyway (office: null) so they appear
// greyed-out on the map and light up automatically the moment a real office
// is created with that code.
export const REGIONS = [
  {
    id: 'australia',
    label: 'Australia & NZ',
    officeType: 'Receive & Sales Office',
    businessTypes: ['Natural', 'Lab Diamonds', 'Gemstones', 'Jewellery'],
    lat: -25, lng: 134,
    countries: [
      { name: 'Australia', offices: ['WS-SYD', 'WS-MEL', 'WS-BNE'] },
      { name: 'New Zealand', offices: ['WS-NZ'] },
    ],
  },
  {
    id: 'europe',
    label: 'Europe',
    officeType: 'Receive & Sales Office',
    businessTypes: ['Natural', 'Lab Diamonds', 'Gemstones', 'Jewellery'],
    lat: 50, lng: 15,
    countries: [
      { name: 'Italy', offices: ['WS-IT'] },
      { name: 'Poland', offices: ['WS-POL'] },
      { name: 'UK', offices: ['WS-UK'] },
      { name: 'Netherlands', offices: [] },
    ],
  },
  {
    id: 'asia',
    label: 'Asia',
    officeType: 'Source & Export Office',
    businessTypes: ['Natural', 'Lab Diamonds', 'Gemstones', 'Jewellery'],
    lat: 15, lng: 90,
    countries: [
      { name: 'India', offices: ['HQ', 'DM-HQ'] },
      { name: 'Thailand', offices: [] },
    ],
  },
  {
    id: 'other',
    label: 'Americas & Other',
    officeType: 'Receive & Sales Office',
    businessTypes: ['Jewellery'],
    lat: 31, lng: -100,
    countries: [
      { name: 'USA', offices: ['DM-USA'] },
      { name: 'Germany', offices: ['DM-GER'] },
    ],
  },
];

const OFFICE_TO_REGION = new Map();
for (const region of REGIONS) {
  for (const country of region.countries) {
    for (const officeCode of country.offices) {
      OFFICE_TO_REGION.set(officeCode, { regionId: region.id, countryName: country.name });
    }
  }
}

export function regionForOfficeCode(code) {
  return OFFICE_TO_REGION.get(code) || { regionId: 'other', countryName: 'Unassigned' };
}
