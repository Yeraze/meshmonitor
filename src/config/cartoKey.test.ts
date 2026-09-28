import { describe, it, expect } from 'vitest';
import { withCartoKey, isCartoUrl, createCartoTransformRequest } from './cartoKey';

describe('isCartoUrl', () => {
  it('recognizes Carto raster tile templates (with {s} placeholder)', () => {
    expect(isCartoUrl('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png')).toBe(true);
  });

  it('recognizes Carto GL style JSON URLs', () => {
    expect(isCartoUrl('https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json')).toBe(true);
  });

  it('rejects non-Carto hosts', () => {
    expect(isCartoUrl('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png')).toBe(false);
    expect(isCartoUrl('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}')).toBe(false);
  });

  it('rejects a lookalike host that only contains the suffix as a substring', () => {
    expect(isCartoUrl('https://basemaps.cartocdn.com.evil.example/{z}/{x}/{y}.png')).toBe(false);
  });

  it('returns false for unparseable input', () => {
    expect(isCartoUrl('not a url')).toBe(false);
  });
});

describe('withCartoKey', () => {
  const carto = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';

  it('appends ?key= to a Carto raster template, preserving placeholders', () => {
    expect(withCartoKey(carto, 'ABC123')).toBe(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=ABC123',
    );
  });

  it('appends ?key= to a Carto style JSON URL', () => {
    expect(withCartoKey('https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', 'K')).toBe(
      'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json?key=K',
    );
  });

  it('uses & when the URL already has a query string', () => {
    expect(withCartoKey('https://basemaps.cartocdn.com/x/{z}/{x}/{y}.png?scale=2', 'K')).toBe(
      'https://basemaps.cartocdn.com/x/{z}/{x}/{y}.png?scale=2&key=K',
    );
  });

  it('keeps the key before a URL fragment', () => {
    expect(withCartoKey('https://basemaps.cartocdn.com/style.json#foo', 'K')).toBe(
      'https://basemaps.cartocdn.com/style.json?key=K#foo',
    );
  });

  it('handles an existing query string AND a fragment together', () => {
    expect(withCartoKey('https://basemaps.cartocdn.com/x.json?v=2#hash', 'K')).toBe(
      'https://basemaps.cartocdn.com/x.json?v=2&key=K#hash',
    );
  });

  it('is idempotent — does not double-append when a key is already present', () => {
    const keyed = 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=EXISTING';
    expect(withCartoKey(keyed, 'NEW')).toBe(keyed);
  });

  it('url-encodes the key', () => {
    expect(withCartoKey('https://basemaps.cartocdn.com/style.json', 'a b/c')).toBe(
      'https://basemaps.cartocdn.com/style.json?key=a%20b%2Fc',
    );
  });

  it('is a no-op when the key is empty/nullish', () => {
    expect(withCartoKey(carto, '')).toBe(carto);
    expect(withCartoKey(carto, null)).toBe(carto);
    expect(withCartoKey(carto, undefined)).toBe(carto);
  });

  it('is a no-op for non-Carto URLs', () => {
    const osm = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    expect(withCartoKey(osm, 'K')).toBe(osm);
  });
});

describe('createCartoTransformRequest (#5448)', () => {
  it('appends the key to every CARTO CDN request a GL style makes', () => {
    const transform = createCartoTransformRequest('KEY123');
    for (const url of [
      'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
      'https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json',
      'https://tiles-c.basemaps.cartocdn.com/vectortiles/carto.streets/v1/5/9/12.mvt',
      'https://tiles.basemaps.cartocdn.com/gl/voyager-gl-style/sprite@2x.json',
      'https://tiles.basemaps.cartocdn.com/fonts/Montserrat%20Medium/0-255.pbf',
    ]) {
      expect(transform(url)).toEqual({ url: `${url}?key=KEY123` });
    }
  });

  it('leaves non-CARTO hosts alone (returns undefined)', () => {
    const transform = createCartoTransformRequest('KEY123');
    expect(transform('https://tiles.example.com/1/2/3.pbf')).toBeUndefined();
    expect(transform('http://localhost:8080/map-styles/carto-voyager-dark.json')).toBeUndefined();
    // A look-alike host must not receive the key.
    expect(transform('https://basemaps.cartocdn.com.attacker.example/style.json')).toBeUndefined();
  });

  it('is a no-op for every URL when there is no key', () => {
    for (const key of [undefined, null, '']) {
      const transform = createCartoTransformRequest(key);
      expect(transform('https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json')).toBeUndefined();
    }
  });

  it('does not double-append a key that is already present', () => {
    const transform = createCartoTransformRequest('KEY123');
    expect(transform('https://tiles.basemaps.cartocdn.com/a.pbf?key=OTHER')).toEqual({
      url: 'https://tiles.basemaps.cartocdn.com/a.pbf?key=OTHER',
    });
  });
});
