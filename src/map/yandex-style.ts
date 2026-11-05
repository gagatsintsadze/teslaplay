/**
 * Yandex vector map customization for driving (YMapDefaultSchemeLayer `customization`).
 * Same palette as the app's OpenStreetMap "Drive" style: soft land, green parks, blue water,
 * wider white roads with clear edges when zoomed out, and asphalt with white markings at street
 * level — Yandex's own road surfaces and lane markings where it has them.
 * Tags/elements per https://yandex.com/maps-api/docs/js-api/map/customization.html
 * (an unknown tag only disables its own block, never the whole style).
 */

type Item = { tags?: { any?: string[]; all?: string[]; none?: string[] }; types?: string; elements?: string; stylers: Record<string, unknown>[] };

const STREET: [number, number] = [17, 21];
const CITY: [number, number] = [0, 16];

export function yandexCustomization(theme: 'light' | 'dark'): Item[] {
  const d = theme === 'dark';
  const c = d
    ? {
      land: '#1b1e24', urban: '#1f2229', park: '#1d3326', water: '#0f2b47', building: '#2c3038',
      road: '#3b404a', roadOutline: '#2a2e36', highway: '#5c5136', highwayOutline: '#3d3626', asphalt: '#3c414b', minorAsphalt: '#353a43',
      marking: '#d2d6dd', label: '#dfe2e8', labelOutline: '#1b1e24', roadLabel: '#c9ced6',
    }
    : {
      land: '#f2efe9', urban: '#ece8e0', park: '#cde6bc', water: '#9ccdf3', building: '#e9e2d6',
      road: '#ffffff', roadOutline: '#d6d0c5', highway: '#fde3a2', highwayOutline: '#e6c36e', asphalt: '#6a707a', minorAsphalt: '#7d838c',
      marking: '#ffffff', label: '#33363b', labelOutline: '#ffffff', roadLabel: '#3c3f45',
    };

  return [
    // Ground
    { tags: { all: ['land'] }, elements: 'geometry', stylers: [{ color: c.land }] },
    { tags: { any: ['urban_area', 'residential', 'industrial'] }, elements: 'geometry', stylers: [{ color: c.urban }] },
    { tags: { any: ['park', 'vegetation', 'national_park', 'sports_ground', 'cemetery'] }, types: 'polygon', elements: 'geometry', stylers: [{ color: c.park }] },
    { tags: { all: ['water'] }, elements: 'geometry', stylers: [{ color: c.water }] },
    { tags: { all: ['building'] }, elements: 'geometry', stylers: [{ color: c.building }] },

    // Roads — zoomed out: clean, slightly wider lines; motorways/trunks warm.
    { tags: { any: ['road_1', 'road_2'] }, elements: 'geometry.fill', stylers: [{ zoom: CITY, color: c.highway }, { zoom: STREET, color: c.asphalt }] },
    { tags: { any: ['road_1', 'road_2'] }, elements: 'geometry.outline', stylers: [{ zoom: CITY, color: c.highwayOutline }, { zoom: STREET, color: c.roadOutline }] },
    { tags: { any: ['road_3', 'road_4'] }, elements: 'geometry.fill', stylers: [{ zoom: CITY, color: c.road }, { zoom: STREET, color: c.asphalt }] },
    { tags: { any: ['road_5', 'road_6', 'road_7', 'road_minor', 'road_unclassified'] }, elements: 'geometry.fill', stylers: [{ zoom: CITY, color: c.road }, { zoom: STREET, color: c.minorAsphalt }] },
    { tags: { any: ['road_3', 'road_4', 'road_5', 'road_6', 'road_7', 'road_minor'] }, elements: 'geometry.outline', stylers: [{ color: c.roadOutline }] },
    { tags: { any: ['road'] }, types: 'polyline', elements: 'geometry', stylers: [{ zoom: [13, 16], scale: 1.25 }, { zoom: STREET, scale: 1.35 }] },
    // Street level: Yandex's detailed carriageways and lane markings.
    { tags: { all: ['road_surface'] }, elements: 'geometry', stylers: [{ zoom: STREET, color: c.asphalt }] },
    { tags: { all: ['road_marking'] }, elements: 'geometry', stylers: [{ color: c.marking }, { opacity: 0.9 }] },

    // Labels
    { tags: { any: ['road'] }, elements: 'label.text.fill', stylers: [{ color: c.roadLabel }] },
    { tags: { any: ['road'] }, elements: 'label.text.outline', stylers: [{ color: c.labelOutline }] },
    { tags: { any: ['admin', 'locality', 'district'] }, elements: 'label.text.fill', stylers: [{ color: c.label }] },
    { tags: { any: ['admin', 'locality', 'district'] }, elements: 'label.text.outline', stylers: [{ color: c.labelOutline }] },
  ];
}
