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

## MCOimg v3 codec and palettes

MeshMonitor draws `im3:` chat images with a decoder ported to TypeScript from
the MCOimg v3 reference codec. The port lives in `src/utils/mcoImage/`.

- Source: <https://github.com/HDDen/meshcore-open>, branch `rename-mco-advanced`,
  commit `c38c1650fe8394835e333b5b4a1ac84ead2d5e5a`
  (`docs/mcoimg-js/mcoimg-v3-codec.global.js`).
- Licence: MIT.
- Credit: Copyright (c) 2025 zjs81.
- Changes: translated to TypeScript. We ported only the decoder, the Base91
  reader, and the palette tables. The encoder is not included.


## MCOimg v4 decoder

MeshMonitor draws `im4:` chat images with a decoder and renderer translated
to TypeScript from the MCOimg v4 reference. The code lives in `src/utils/mcoImage/`.

- Source: <https://github.com/HDDen/meshcore-open>, tag `9.5.1-mod-1.9.0`,
  commit `fe375741226588440e268002b4975349b2e95ffe`
  (`lib/helpers/mcoimg_v4_codec.dart`, `mcoimg_v4_model.dart`,
  `lib/widgets/mco_image_v4_view.dart`, and the black index from `mcoimg_palette.dart`).
- Licence: MIT.
- Credit: Copyright (c) 2025 zjs81.
- Changes: translated to TypeScript. We ported only the decoder and renderer.
  The encoder is not included.

## MCOtxt v1 decoder and generation-0 tables

IM4 captions use MCOtxt v1 text. MeshMonitor decodes it with logic translated
to TypeScript from `lib/MCOtxt/` at tag `9.5.1-mod-1.9.0`. The generation-0
model tables are copied verbatim from `docs/mcotxt/assets/mcotxt.js` at commit
`c38c1650fe8394835e333b5b4a1ac84ead2d5e5a`.

- Source: <https://github.com/HDDen/meshcore-open>
- Licence: MIT.
- Credit: Copyright (c) 2025 zjs81.
- Changes: translated to TypeScript. The encoder is not included.
- Wire hashes of the seven models (a test checks each one):
  - en `55988b3bb2a000adf6e768a8541df5a25fec1628b4ec661a10b577e3af8b3770`
  - ru `d123c4978a635bf1b26fe37261b7e96a0206b3ba15b2a80542e560f00d1eb193`
  - fr `910c5821a202a9b35313a9b939355f09d1c4293fe2ed246fed0123639d379ccb`
  - de `00b971288fee56f37535ce03b4ac0d8ebddfc12ecbd5ef282ab4b0f4a659f451`
  - it `f6d073a1d6ae6344eaac445b86fb8a454b276a740fd40651956b1ff28f5af270`
  - uk `949992c57156526843cdb9634c5c14bee23218878f116ef90be2a8497274c131`
  - be `dd23c2b82288e0a4452f237ccd905055974779e3cc5cc6f3d03be1b24e5bb1fd`

The test fixtures in `src/utils/mcoImage/__fixtures__/` come from the upstream
code and test suite, under the same licence.