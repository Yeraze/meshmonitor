# Third-party data

MeshMonitor's own code is under the BSD-3-Clause licence (see `LICENSE`). The
data sets below ship inside MeshMonitor under their own terms.

## Offline geocoder (MQTT root finder)

The MQTT root finder names your country, state or province, and nearest city
from your position, without any network lookup (#6336). It uses two data sets,
embedded in `src/server/data/geo/` and rebuilt by hand with
`scripts/geo/build-offline-geocoder.ts`. Versions and checksums are pinned in
`src/server/data/geo/geoDataVersion.ts`.

### Natural Earth

- Data: 10m admin-1 states and provinces, release v5.1.2.
- Source: <https://www.naturalearthdata.com/>, <https://github.com/nvkelso/natural-earth-vector>
- Licence: public domain. No permission is needed to use it.
- Credit: Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.
- Changes: merged to top-level ISO 3166-2 subdivisions (for example, French
  departments into regions and UK council areas into England, Scotland, Wales
  and Northern Ireland), simplified, and rounded to 0.00001 degrees.

### GeoNames

- Data: `cities15000` (places with more than 15,000 people, and seats of
  administrative divisions), downloaded 2026-11-10.
- Source: <https://www.geonames.org/>, <https://download.geonames.org/export/dump/>
- Licence: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
- Credit: Contains data from GeoNames (geonames.org), licensed under CC BY 4.0.
- Changes: kept only name, position, population and id; dropped neighbourhoods
  and historical places; linked each place to a Natural Earth subdivision.
