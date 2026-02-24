# Custom Tile Servers

MeshMonitor allows you to configure custom tile servers for offline maps or custom styling.

## Quick Start (Most Users)

**NEW**: MeshMonitor now supports **both vector (.pbf) and raster (.png) tiles**! Vector tiles are recommended for smaller file sizes and flexible styling.

### 5-Minute Setup with TileServer GL Light

**1. Get tiles (choose one):**
- **Easiest**: Use online tiles temporarily: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- **Recommended**: Download vector tiles from [MapTiler OSM](https://www.maptiler.com/on-prem-datasets/) - smaller and more flexible
- **Alternative**: Download raster tiles from [OpenMapTiles](https://openmaptiles.org/downloads/)

**2. Start TileServer GL Light:**
```bash
# Place .mbtiles files in ./tiles directory
docker run -d \
  --name tileserver \
  -p 8080:8080 \
  -v $(pwd)/tiles:/data \
  maptiler/tileserver-gl-light:latest
```

**3. Add in MeshMonitor Settings → Map Settings → Custom Tile Servers:**

**For vector tiles (.pbf):**
```
Name: Local Vector Tiles
URL: http://localhost:8080/data/v3/{z}/{x}/{y}.pbf
Attribution: © OpenStreetMap contributors
Max Zoom: 14
```

**For raster tiles (.png):**
```
Name: Local Raster Tiles
URL: http://localhost:8080/styles/basic/{z}/{x}/{y}.png
Attribution: © OpenStreetMap contributors
Max Zoom: 18
```

**4. Select your custom tileset** from the Map Tileset dropdown

✅ **Works on all platforms** - TileServer GL Light has no native dependencies, no `sharp` issues

✨ **Vector tiles** are automatically detected by file extension (.pbf, .mvt) and rendered client-side using MapLibre GL

## Overview

Custom tile servers enable:
- **Offline operation** - Use locally hosted tiles without internet access
- **Privacy** - No third-party tile requests leaking node locations
- **Custom branding** - Organization-specific map styles
- **High availability** - Independence from external tile services

## Adding Custom Tile Server in MeshMonitor

1. Navigate to **Settings** → **Map Settings**
2. Scroll to the **Custom Tile Servers** section
3. Click **+ Add Custom Tile Server**
4. Fill in the required fields:
   - **Name**: Friendly name (e.g., "Local Tiles")
   - **Tile URL**: URL template with placeholders
   - **Attribution**: Attribution text for the map
   - **Max Zoom**: Maximum zoom level (1-22)
   - **Description**: Optional description
5. Click **Save**
6. Select your custom tileset from the **Map Tileset** dropdown

## Tile URL Format

Custom tile servers must use the standard XYZ tile format:

```
https://example.com/{z}/{x}/{y}.png
```

### Required Placeholders

- `{z}` - Zoom level
- `{x}` - Tile X coordinate
- `{y}` - Tile Y coordinate

### Optional Placeholders

- `{s}` - Subdomain (e.g., a, b, c for load balancing)

### Examples

**Local tile server:**
```
http://localhost:8081/{z}/{x}/{y}.png
```

**Subdomain-based:**
```
https://{s}.tiles.example.com/{z}/{x}/{y}.png
```

**Custom path:**
```
https://maps.example.com/tiles/{z}/{x}/{y}.webp
```

## Understanding Tile Types: Vector vs Raster

**NEW**: MeshMonitor now supports **both vector and raster tiles**! Vector tiles are automatically rendered client-side using MapLibre GL.

### Vector Tiles (✅ Supported - Client-side Rendering)

**What they are**: Compressed vector data in Protobuf format

**File extensions**: `.pbf`, `.mvt`

**Advantages**:
- ✅ **Smaller storage** - Vector data is very compact (5-10x smaller than raster)
- ✅ **Flexible styling** - Can adjust colors and appearance dynamically
- ✅ **Sharp at any zoom** - Scales beautifully without pixelation
- ✅ **Client-side rendering** - Using MapLibre GL (auto-detected by file extension)

**Disadvantages**:
- ⚠️ Slightly higher CPU usage for rendering (negligible on modern devices)
- ⚠️ Limited to max zoom 14 by default (sufficient for most use cases)

**Example sources**:
- [MapTiler OSM](https://www.maptiler.com/on-prem-datasets/) - Pre-made vector tiles (recommended)
- OpenMapTiles v3 format (.pbf)

**How to use**:
- TileServer GL Light serves vector tiles at `/data/v3/{z}/{x}/{y}.pbf`
- MeshMonitor automatically detects `.pbf` extension and uses MapLibre GL renderer

### Raster Tiles (✅ Supported - Traditional)

**What they are**: Pre-rendered images (PNG, JPG, WebP)

**File extensions**: `.png`, `.jpg`, `.jpeg`, `.webp`

**Advantages**:
- ✅ No client-side rendering needed
- ✅ Works with any tile server or static file hosting
- ✅ Predictable performance
- ✅ Can support higher zoom levels (18-19)

**Disadvantages**:
- ❌ Larger storage (every zoom level pre-rendered)
- ❌ Fixed styling (can't change appearance without regenerating)
- ❌ 5-10x larger than vector tiles

**Example sources**:
- OpenStreetMap tiles (https://tile.openstreetmap.org/)
- OpenMapTiles raster .mbtiles
- Directory tiles in Z/X/Y.png structure

**How to identify what you have**:

```bash
# Check .mbtiles format
sqlite3 your-file.mbtiles "SELECT value FROM metadata WHERE name='format';"

# Output "pbf" = vector tiles (✅ works with MeshMonitor + MapLibre GL)
# Output "png" or "jpg" = raster tiles (✅ works with MeshMonitor + Leaflet)
```

## Alternative Deployment Options

### Using Docker Compose Configurator (Easiest)

The [Docker Compose Configurator](/configurator) has a built-in option for TileServer GL Light:

1. Check **"Enable Offline Map Tiles (TileServer GL Light)"**
2. Set port (default: 8081)
3. Download generated `docker-compose.yml`
4. Place .mbtiles files in `./tiles` directory
5. Run `docker compose up -d`
6. Supports both vector (.pbf) and raster (.png) tiles automatically

### Directory Tiles with TileServer GL Light

If you have pre-rendered tiles in Z/X/Y folder structure:

```bash
# Tiles directory structure:
# tiles/0/0/0.png
# tiles/1/0/0.png
# tiles/1/0/1.png

docker run -d \
  --name tileserver \
  -p 8080:8080 \
  -v $(pwd)/tiles:/data \
  maptiler/tileserver-gl-light:latest

# URL in MeshMonitor: http://localhost:8080/{z}/{x}/{y}.png
```

### Nginx Caching Tile Proxy (Gradual Offline Coverage)

**Best for**: Building an offline tile cache gradually without downloading everything upfront.

This solution downloads tiles from online sources (like OpenStreetMap) and caches them locally. Over time, you build up offline coverage of frequently-viewed areas.

**Create nginx.conf:**

```nginx
events {
    worker_connections 1024;
}

http {
    # Cache storage: 10GB max, files kept for 60 days
    proxy_cache_path /var/cache/nginx/tiles
                     levels=1:2
                     keys_zone=tiles_cache:10m
                     max_size=10g
                     inactive=60d
                     use_temp_path=off;

    server {
        listen 8081;
        server_name localhost;

        location / {
            # Proxy to OpenStreetMap (or any tile server)
            proxy_pass https://tile.openstreetmap.org;

            # Cache settings
            proxy_cache tiles_cache;
            proxy_cache_valid 200 60d;  # Keep successful responses for 60 days
            proxy_cache_valid 404 1m;   # Retry 404s after 1 minute

            # CORS headers for browser access
            add_header Access-Control-Allow-Origin *;
            add_header X-Cache-Status $upstream_cache_status;

            # Client cache headers
            expires 60d;
        }
    }
}
```

**Run with Docker:**

```bash
# Create cache directory
mkdir -p tile-cache

# Run nginx proxy
docker run -d \
  --name tile-proxy \
  -p 8081:8081 \
  -v $(pwd)/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v $(pwd)/tile-cache:/var/cache/nginx/tiles \
  nginx:alpine
```

**Configure in MeshMonitor:**
```
Name: OpenStreetMap (Cached)
URL: http://localhost:8081/{z}/{x}/{y}.png
Attribution: © OpenStreetMap contributors
Max Zoom: 19
Description: OSM tiles with local caching
```

**How it works**:
1. **First request**: Downloads from OSM → saves to cache → serves to browser
2. **Subsequent requests**: Serves from local cache (works offline!)
3. **Over time**: Builds up offline coverage of your area
4. **Offline**: Already-cached tiles work without internet

**Advantages**:
- ✅ No large upfront download
- ✅ Gradually builds offline coverage
- ✅ Always works (online falls back to cache, offline uses cache)
- ✅ Simple to set up
- ✅ Can proxy any raster tile server

**Disadvantages**:
- ❌ Need internet initially to populate cache
- ❌ Only areas you've viewed are cached

**Pro tip**: Pre-warm the cache by loading your area of interest in MeshMonitor before going offline.

## Tile Sources: Where to Get Tiles

### Raster Tile Sources (✅ Works with MeshMonitor)

**Free Online Services** (use with caching proxy above):
- **OpenStreetMap**: https://tile.openstreetmap.org/{z}/{x}/{y}.png (max zoom: 19)
- **OpenTopoMap**: https://tile.opentopomap.org/{z}/{x}/{y}.png (max zoom: 17)
- **CyclOSM**: https://tile.cyclosm.org/{z}/{x}/{y}.png (cycling-focused, max zoom: 20)

⚠️ **Note**: Check usage policies. Some services limit requests. Use caching proxy to be respectful.

**Commercial Services** (require API key):
- **Mapbox**: https://api.mapbox.com/styles/v1/{style}/{z}/{x}/{y}?access_token={token}
- **Maptiler**: https://api.maptiler.com/maps/{style}/{z}/{x}/{y}.png?key={token}
- **Thunderforest**: https://{s}.tile.thunderforest.com/{style}/{z}/{x}/{y}.png?apikey={token}

**Pre-rendered Raster Downloads** (for true offline):
- Generate yourself using QGIS + QTiles plugin
- Use tile downloader tools (see below)
- Convert from vector tiles using TileServer GL Full

### Vector Tile Sources (⚠️ Needs Rendering)

If you get vector tiles, you'll need to render them first:

**Pre-made Vector .mbtiles**:
- **OpenMapTiles**: https://openmaptiles.org/downloads/ (free regions available)
- **Protomaps**: https://protomaps.com/downloads/osm (OSM extracts)

**Rendering vector → raster**:
- Use TileServer GL Full (may have `sharp` issues)
- Pre-render using Mapnik, Maputnik, or similar tools
- Use caching proxy to gradually convert on-demand

### Tools for Downloading Tiles

**QGIS QTiles Plugin** (easiest for custom areas):
1. Install QGIS (free, open-source GIS software)
2. Install "QTiles" plugin
3. Load OpenStreetMap base layer
4. Select area with rectangle tool
5. Export tiles (select zoom levels, output format)
6. Outputs Z/X/Y directory structure

**tile-downloader** (command-line):
```bash
pip install tile-downloader

# Download specific region
tile-downloader \
  --url "https://tile.openstreetmap.org/{z}/{x}/{y}.png" \
  --bbox "-125.0,25.0,-65.0,50.0" \  # West, South, East, North
  --zoom "0-12" \
  --output tiles.mbtiles
```

**mbutil** (convert .mbtiles ↔ directory):
```bash
pip install mbutil

# Extract .mbtiles to directory
mb-util tiles.mbtiles tiles-dir

# Create .mbtiles from directory
mb-util tiles-dir tiles.mbtiles
```

#### Converting OSM Data to MBTiles

If you have `.osm.pbf` files (e.g., from [Geofabrik](https://download.geofabrik.de/)), convert them to MBTiles:

**Using OpenMapTiles (Recommended):**

```bash
# 1. Clone OpenMapTiles
git clone https://github.com/openmaptiles/openmaptiles.git
cd openmaptiles

# 2. Download OSM data for your region from Geofabrik
wget https://download.geofabrik.de/north-america/us/california-latest.osm.pbf

# 3. Generate MBTiles (requires Docker)
./quickstart.sh california

# 4. Output will be in data/tiles.mbtiles
# Copy to your TileServer GL tiles directory
cp data/tiles.mbtiles ../tiles/california.mbtiles
```

**Using Tilemaker (Faster, simpler):**

```bash
# Install tilemaker
docker pull ghcr.io/systemed/tilemaker:master

# Convert OSM.PBF to MBTiles
docker run -v $(pwd):/data ghcr.io/systemed/tilemaker:master \
  /data/input.osm.pbf \
  --output=/data/output.mbtiles \
  --process=/usr/local/share/tilemaker/resources/process-openmaptiles.lua \
  --config=/usr/local/share/tilemaker/resources/config-openmaptiles.json
```

**Quick Downloads:**
- **Geofabrik** - Free OSM extracts by region: https://download.geofabrik.de/
- **BBBike** - Custom area extracts: https://extract.bbbike.org/
- **Planet OSM** - Full planet: https://planet.openstreetmap.org/

### For Hosted Deployment

#### Mapbox Custom Style

Professional styling with CDN distribution.

**Setup:**
1. Create account at [mapbox.com](https://www.mapbox.com/)
2. Design custom style in Mapbox Studio
3. Get style ID and access token

**Configure in MeshMonitor:**
```
URL: https://api.mapbox.com/styles/v1/{username}/{style_id}/tiles/{z}/{x}/{y}?access_token={token}
```

**Note:** Replace `{username}`, `{style_id}`, and `{token}` with actual values

#### Maptiler Cloud

Custom maps with generous free tier.

**Setup:**
1. Create account at [maptiler.com](https://www.maptiler.com/)
2. Choose or customize a map style
3. Get API key

**Configure in MeshMonitor:**
```
URL: https://api.maptiler.com/maps/{map_id}/{z}/{x}/{y}.png?key={api_key}
```

## Configuration Examples

### Example 1: Local OpenStreetMap Tiles

```
Name: Local OSM
URL: http://localhost:8080/styles/osm-bright/{z}/{x}/{y}.png
Attribution: © OpenStreetMap contributors
Max Zoom: 18
Description: Offline OpenStreetMap tiles
```

### Example 2: Local Satellite Imagery

```
Name: Local Satellite
URL: http://192.168.1.100:8081/satellite/{z}/{x}/{y}.jpg
Attribution: Local Imagery
Max Zoom: 16
Description: Pre-downloaded satellite imagery
```

### Example 3: Custom Mapbox Style

```
Name: Company Branded Map
URL: https://api.mapbox.com/styles/v1/mycompany/ckxxx/{z}/{x}/{y}?access_token=pk.xxx
Attribution: © Mapbox © OpenStreetMap
Max Zoom: 20
Description: Custom branded map style
```

## Security Considerations

### HTTPS vs HTTP

- **HTTPS recommended** for production deployments
- **HTTP allowed** for localhost/127.0.0.1 only
- Mixed content warnings if using HTTP tiles on HTTPS site

### CORS Configuration

Custom tile servers must allow cross-origin requests:

**Nginx:**
```nginx
add_header Access-Control-Allow-Origin *;
```

**Apache:**
```apache
Header set Access-Control-Allow-Origin "*"
```

**Node.js/Express:**
```javascript
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});
```

### URL Validation

MeshMonitor validates tile URLs to prevent:
- Missing required placeholders ({z}, {x}, {y})
- Invalid URL format
- Non-HTTP/HTTPS protocols
- Excessively long URLs (> 500 characters)

## Troubleshooting

### Tiles Not Loading

**Symptoms:** Gray squares instead of map tiles

**Solutions:**

1. **Check CORS headers:**
   ```bash
   curl -I http://localhost:8080/tiles/0/0/0.png
   # Should include: Access-Control-Allow-Origin: *
   ```

2. **Verify tile server is running:**
   ```bash
   curl http://localhost:8080/tiles/0/0/0.png
   # Should return image data
   ```

3. **Check URL format:**
   - Ensure {z}, {x}, {y} placeholders are present
   - Test with real values: replace {z} with 0, {x} with 0, {y} with 0

4. **Browser console errors:**
   - Open DevTools (F12)
   - Check Console tab for CORS or 404 errors
   - Check Network tab to see failing requests

### Mixed Content Warnings

**Symptoms:** Browser blocks HTTP tile requests on HTTPS site

**Solutions:**

1. **Use HTTPS for tile server** (recommended)
2. **Use localhost/127.0.0.1** (allowed for development)
3. **Configure reverse proxy** to serve tiles over HTTPS

### Slow Tile Loading

**Symptoms:** Map loads slowly or tiles timeout

**Solutions:**

1. **Use local tile server** - Faster than remote servers
2. **Reduce max zoom** - Fewer high-resolution tiles to load
3. **Enable tile caching** - Browser will cache tiles
4. **Optimize tile size** - Use WebP or compressed PNG

### Custom Tileset Not Appearing

**Symptoms:** Added tileset doesn't show in dropdown

**Solutions:**

1. **Refresh the page** - Settings are loaded on page load
2. **Check browser console** - Look for JavaScript errors
3. **Verify save succeeded** - Check for error messages
4. **Clear localStorage** - Sometimes cached state causes issues:
   ```javascript
   // In browser console:
   localStorage.clear();
   location.reload();
   ```

### OpaqueResponseBlocking Error (Historical - Fixed in Latest Version)

**Note:** This error no longer occurs in the latest version of MeshMonitor, which now supports both vector and raster tiles.

**Symptoms (older versions):** Browser console shows "A resource is blocked by OpaqueResponseBlocking" for `.pbf` files

**Solution:** **Upgrade to the latest MeshMonitor** - Vector tiles (.pbf) are now fully supported with automatic client-side rendering using MapLibre GL.

**For older versions:**

If you're unable to upgrade, you can:

1. **Use raster tiles instead**:
   ```
   # Change from vector:
   http://localhost:8081/data/v3/{z}/{x}/{y}.pbf

   # To raster endpoint:
   http://localhost:8081/styles/basic/{z}/{x}/{y}.png
   ```

2. **Or upgrade MeshMonitor** to get vector tile support with better performance and smaller file sizes.

### TileServer GL "sharp" Module Error

**Symptoms:** TileServer GL Full crashes with error about `sharp` module:
```
Something went wrong installing the "sharp" module
Cannot find module '../build/Release/sharp-linux-x64.node'
```

**Cause:** TileServer GL Full uses the `sharp` library to render vector tiles to raster images. The library has native dependencies that may not be compatible with your platform/architecture.

**Solutions:**

1. **Use TileServer GL Light instead** (recommended if you have raster tiles):
   ```bash
   docker run -d \
     --name tileserver \
     -p 8080:8080 \
     -v $(pwd)/tiles:/data \
     maptiler/tileserver-gl-light:latest
   ```

   **Note**: Light version can't render vector → raster, but works perfectly with raster .mbtiles or directory tiles.

2. **Use nginx caching proxy** (easiest for offline):
   - Set up [nginx caching proxy](#nginx-caching-tile-proxy-easiest-for-offline)
   - Proxy to OpenStreetMap or other raster tile service
   - Gradually builds offline cache as you use it
   - No rendering needed!

3. **Get raster tiles instead of vector:**
   - Download pre-rendered raster tiles from QGIS QTiles plugin
   - Use tile downloader tools (see [Tile Sources](#tile-sources-where-to-get-tiles))
   - Serve with simple nginx or TileServer GL Light

4. **Try different TileServer GL Full image** (if you must use Full):
   ```bash
   # Try older version (may have better compatibility)
   docker run -d \
     --name tileserver \
     -p 8080:8080 \
     -v $(pwd)/tiles:/data \
     maptiler/tileserver-gl:v3.1.1
   ```

**Why this happens:**
- `sharp` requires native binaries compiled for your platform
- Docker images include pre-compiled binaries for common platforms
- Platform/architecture mismatches cause module loading failures
- Light version avoids this by not including rendering capabilities

**Best practice:** Use raster tiles + TileServer GL Light, or use nginx caching proxy for simplest offline setup.

## Advanced Usage

### Subdomain Load Balancing

Use multiple subdomains for faster tile loading:

```
URL: https://{s}.tiles.example.com/{z}/{x}/{y}.png
```

Configure DNS records:
- a.tiles.example.com → Server 1
- b.tiles.example.com → Server 2
- c.tiles.example.com → Server 3

### Custom Tile Formats

MeshMonitor supports various tile formats:
- **PNG** - Best quality, larger file size
- **JPEG** - Good for satellite imagery
- **WebP** - Smaller file size, modern browsers

Example:
```
URL: https://example.com/tiles/{z}/{x}/{y}.webp
```

### Retina/High-DPI Tiles

For high-resolution displays, use @2x tiles:

```
URL: https://example.com/tiles/{z}/{x}/{y}@2x.png
```

Note: Adjust zoom levels accordingly (typically maxZoom - 1)

## Limitations

- **Maximum 50 custom tilesets** per instance
- **URL length limit:** 500 characters
- **Name length limit:** 100 characters
- **Attribution length limit:** 200 characters
- **Description length limit:** 200 characters
- **Zoom range:** 1-22

## Best Practices

1. **Test locally first** - Verify tiles load correctly before deployment
2. **Use descriptive names** - Make it easy to identify tilesets
3. **Include attribution** - Give credit to tile data providers
4. **Set appropriate max zoom** - Match your tile data's capabilities
5. **Monitor storage** - Offline tiles can consume significant disk space
6. **Regular updates** - Keep offline tiles current for accuracy
7. **Backup configurations** - Export custom tileset settings

## Security Notes

- **Validate tile servers** - Only use trusted tile sources
- **Secure credentials** - Don't embed API keys in URLs if possible
- **Monitor access** - Log tile server requests for security audits
- **Rate limiting** - Some services have rate limits on API requests

## Support

For issues or questions:
- GitHub Issues: https://github.com/Yeraze/meshmonitor/issues
- Documentation: https://github.com/Yeraze/meshmonitor/tree/main/docs
