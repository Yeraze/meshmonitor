# Using PMTiles for Offline Maps

MeshMonitor supports **PMTiles** - a modern, efficient format for serving map tiles locally without requiring a tile server. PMTiles uses HTTP range requests to fetch only the tiles you need, making it perfect for offline deployments or reducing bandwidth usage.

## What are PMTiles?

PMTiles is a single-file archive format for map tiles that:
- **Works offline** - No internet connection needed once downloaded
- **Efficient storage** - Single file instead of millions of individual tiles
- **Fast performance** - Uses HTTP range requests to fetch only needed tiles
- **No tile server required** - Served directly as a static file
- **Smaller file sizes** - 30-50% smaller than traditional MBTiles format

## Quick Start

### 1. Download a PMTiles Basemap

You have several options for obtaining PMTiles:

#### Option A: Protomaps (Recommended for Global Coverage)

Protomaps provides pre-built PMTiles for the entire world:

1. Visit https://maps.protomaps.com/builds/
2. Download a recent build (files are named like `YYYYMMDD.pmtiles`)
3. **File sizes:**
   - **Worldwide** (zoom 0-14): ~100 GB
   - **Regional extracts**: Available at https://protomaps.com/downloads
     - North America: ~15 GB
     - Europe: ~12 GB
     - Individual countries: 100 MB - 5 GB

**Example download (North America):**
```bash
# Download North America extract (example - check site for current URLs)
wget https://build.protomaps.com/north_america-YYYYMMDD.pmtiles \
  -O basemap.pmtiles
```

#### Option B: OpenMapTiles (Planet-wide or Regional)

OpenMapTiles provides PMTiles exports:

1. Visit https://data.maptiler.com/downloads/planet/
2. Download the PMTiles format for your region
3. Free regions available at https://openmaptiles.org/downloads/

**Note:** You may need to convert MBTiles to PMTiles using the `pmtiles` CLI tool (see Conversion section below).

#### Option C: Custom Region with Planetiler

Create your own PMTiles from OpenStreetMap data:

1. Download OSM data for your region from https://download.geofabrik.de/
2. Use **Planetiler** to generate PMTiles:

```bash
# Install Planetiler
wget https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar

# Generate PMTiles (example: California)
java -Xmx4g -jar planetiler.jar \
  --download \
  --area=california \
  --output=california.pmtiles
```

See https://github.com/onthegomap/planetiler for full documentation.

#### Option D: felt/tippecanoe

Generate PMTiles from GeoJSON data:

```bash
# Install tippecanoe
git clone https://github.com/felt/tippecanoe.git
cd tippecanoe
make -j
sudo make install

# Convert GeoJSON to PMTiles
tippecanoe -o output.pmtiles input.geojson
```

### 2. Place PMTiles in the Correct Directory

#### For Local Development (npm):
```bash
# Place your PMTiles file in the public directory
cp your-downloaded-map.pmtiles public/pmtiles/basemap.pmtiles
```

#### For Docker Deployment:
```bash
# Place your PMTiles file in the public/pmtiles directory
# The Docker volume mount will make it available inside the container
cp your-downloaded-map.pmtiles public/pmtiles/basemap.pmtiles

# Restart the container to pick up the new file
docker compose restart meshmonitor
```

**Important:** The default configuration expects the file to be named `basemap.pmtiles`. If you use a different filename, see the "Custom Configuration" section below.

### 3. Enable PMTiles in MeshMonitor

1. Open MeshMonitor in your browser (http://localhost:8080)
2. Navigate to **Settings** tab
3. Under **Map Tileset**, select **"Offline Map (PMTiles)"**
4. Click **Save Settings**
5. The map will reload using your local PMTiles file

Alternatively, use the **Tileset Selector** (bottom-left of map) to quickly switch between online and offline tilesets.

## File Organization

```
meshmonitor/
├── public/
│   └── pmtiles/
│       ├── .gitkeep              # Keeps directory in git
│       ├── basemap.pmtiles       # Your main offline map
│       └── topo.pmtiles          # Optional: Additional tilesets
├── PMTILES.md                    # This documentation
└── docker-compose.yml            # Includes PMTiles volume mount
```

**Note:** `.pmtiles` files are excluded from git via `.gitignore` due to their large size.

## Advanced Configuration

### Using Multiple PMTiles Files

You can configure multiple PMTiles tilesets by editing `src/config/tilesets.ts`:

```typescript
export const TILESETS = {
  // ... existing tilesets ...

  pmtilesLocal: {
    id: 'pmtilesLocal',
    name: 'Offline Map (PMTiles)',
    url: '/pmtiles/basemap.pmtiles',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 14,
    description: 'Locally hosted offline map tiles',
    sourceType: 'pmtiles',
    offline: true
  },

  pmtilesTopographic: {
    id: 'pmtilesTopographic',
    name: 'Offline Topo (PMTiles)',
    url: '/pmtiles/topo.pmtiles',
    attribution: '© OpenStreetMap contributors, SRTM',
    maxZoom: 15,
    description: 'Topographic map with elevation contours',
    sourceType: 'pmtiles',
    offline: true
  }
} as const;
```

**Important:** After modifying `tilesets.ts`:
1. Update the `TilesetId` type to include your new tileset ID
2. Rebuild the application: `npm run build`
3. Restart the server

### Converting MBTiles to PMTiles

If you have existing MBTiles, convert them using the `pmtiles` CLI:

```bash
# Install pmtiles CLI
npm install -g pmtiles

# Convert MBTiles to PMTiles
pmtiles convert input.mbtiles output.pmtiles

# Verify the conversion
pmtiles show output.pmtiles
```

### Adjusting Max Zoom Level

The default PMTiles configuration uses `maxZoom: 14`, which is suitable for most deployments:
- **Zoom 0-10:** Continental/country level
- **Zoom 11-14:** City/neighborhood level (good for Meshtastic node visualization)
- **Zoom 15-18:** Street/building level

To change the max zoom:

1. Edit `src/config/tilesets.ts`
2. Update the `maxZoom` value for `pmtilesLocal`
3. Rebuild: `npm run build`

**Warning:** Higher zoom levels (15+) significantly increase file size:
- Zoom 14: ~100 GB (worldwide)
- Zoom 15: ~300 GB (worldwide)
- Zoom 16+: Multiple terabytes (worldwide)

Regional extracts are much smaller and can support higher zoom levels.

## Docker Deployment Considerations

### Volume Mount Configuration

The Docker configuration includes a volume mount for PMTiles:

```yaml
volumes:
  - ./public/pmtiles:/app/public/pmtiles:ro
```

This mount is:
- **Read-only (`:ro`)** - Prevents accidental modification
- **Host-mounted** - Files stay on your host system, not in Docker volumes
- **Persistent** - Survives container restarts and updates

### Updating PMTiles in Docker

To replace or update PMTiles files:

```bash
# Stop the container
docker compose stop meshmonitor

# Replace the PMTiles file
cp new-map.pmtiles public/pmtiles/basemap.pmtiles

# Start the container
docker compose start meshmonitor
```

You can also update files while the container is running - just refresh your browser to pick up changes.

### Storage Location

PMTiles files are stored on your **host system** in `public/pmtiles/`, not inside the Docker container. This means:
- ✅ Files persist across container rebuilds
- ✅ Easy to update without entering the container
- ✅ No additional storage used by Docker volumes
- ✅ Can be backed up with your application files

## Troubleshooting

### "Offline Map (PMTiles)" option not available in settings

**Solution:**
1. Verify the file exists: `ls -lh public/pmtiles/basemap.pmtiles`
2. Check file permissions: `chmod 644 public/pmtiles/basemap.pmtiles`
3. Restart the application
4. Clear browser cache and reload

### Map tiles not loading (gray squares)

**Possible causes:**

1. **File path incorrect:**
   - Verify `url` in `src/config/tilesets.ts` matches your filename
   - Default: `/pmtiles/basemap.pmtiles`

2. **File corrupted:**
   ```bash
   # Verify PMTiles integrity
   npx pmtiles show public/pmtiles/basemap.pmtiles
   ```

3. **Browser console errors:**
   - Open browser DevTools (F12) → Console tab
   - Look for 404 errors or CORS issues

4. **Docker volume not mounted:**
   ```bash
   # Check if volume is mounted
   docker compose exec meshmonitor ls -lh /app/public/pmtiles/
   ```

### PMTiles file too large to download

**Solutions:**

1. **Use a regional extract instead of worldwide:**
   - North America: ~15 GB
   - Individual states/countries: 100 MB - 5 GB

2. **Use lower max zoom:**
   - Zoom 0-12: ~30 GB (worldwide)
   - Zoom 0-14: ~100 GB (worldwide)

3. **Download in segments with resume support:**
   ```bash
   wget -c https://example.com/large-map.pmtiles
   ```

4. **Use `aria2c` for faster multi-connection downloads:**
   ```bash
   aria2c -x 16 -s 16 https://example.com/large-map.pmtiles
   ```

### Performance issues with large PMTiles

**Optimizations:**

1. **Use regional extracts** - Smaller files = faster tile lookups
2. **Enable HTTP/2** - Better range request performance
3. **Use SSD storage** - Significantly improves random access
4. **Adjust max zoom** - Lower zoom levels reduce file size and improve performance

### Docker container runs out of disk space

PMTiles files are stored on the **host system**, not in Docker volumes:

```bash
# Check host disk space
df -h public/pmtiles/

# Check Docker disk usage (should NOT include PMTiles)
docker system df -v
```

If PMTiles are consuming too much space on your host:
- Delete unused tileset files from `public/pmtiles/`
- Use a regional extract instead of worldwide
- Move `public/pmtiles/` to a larger drive and update the Docker volume mount

## File Size Reference

| Coverage | Zoom Levels | Approximate Size |
|----------|-------------|------------------|
| Worldwide | 0-12 | ~30 GB |
| Worldwide | 0-14 | ~100 GB |
| North America | 0-14 | ~15 GB |
| Europe | 0-14 | ~12 GB |
| US State (e.g., California) | 0-14 | ~1-2 GB |
| Small country | 0-14 | ~100-500 MB |
| City/metro area | 0-16 | ~50-200 MB |

## Resources

### PMTiles Tools
- **PMTiles CLI:** https://github.com/protomaps/PMTiles
- **PMTiles Specification:** https://docs.protomaps.com/pmtiles/

### Data Sources
- **Protomaps Builds:** https://maps.protomaps.com/builds/
- **OpenStreetMap Data:** https://download.geofabrik.de/
- **OpenMapTiles:** https://openmaptiles.org/downloads/

### Tile Generation Tools
- **Planetiler:** https://github.com/onthegomap/planetiler
- **Tippecanoe:** https://github.com/felt/tippecanoe
- **OpenMapTiles:** https://github.com/openmaptiles/openmaptiles

## Why PMTiles Instead of MBTiles?

| Feature | PMTiles | MBTiles |
|---------|---------|---------|
| **File Format** | Cloud-optimized single file | SQLite database |
| **Tile Server Required** | ❌ No | ✅ Yes (tileserver-gl, etc.) |
| **HTTP Range Requests** | ✅ Yes (efficient) | ❌ No |
| **File Size** | 30-50% smaller | Baseline |
| **Random Access Speed** | Faster (optimized structure) | Slower (SQLite overhead) |
| **Browser Compatibility** | ✅ Modern browsers | Requires server-side conversion |
| **Ease of Deployment** | Just drop the file | Requires tile server setup |

## Attribution Requirements

When using PMTiles based on OpenStreetMap data, you **must** provide attribution:

```
© OpenStreetMap contributors
```

The MeshMonitor tileset configuration includes this by default. If you create custom tilesets, ensure proper attribution in `src/config/tilesets.ts`.

## License Considerations

- **OpenStreetMap data:** ODbL (Open Database License) - https://www.openstreetmap.org/copyright
- **Map styles (if using pre-styled tiles):** Check the specific style's license
- **PMTiles format:** BSD-3-Clause license

Always verify licensing requirements for your specific data source and use case.

## Contributing

Found an issue with PMTiles support or have suggestions for improvement?

- **GitHub Issues:** https://github.com/yeraze/meshmonitor/issues
- **Pull Requests:** Contributions welcome!

## Support

For questions or issues:

1. Check this documentation
2. Review the [Troubleshooting](#troubleshooting) section
3. Open a GitHub issue with:
   - MeshMonitor version
   - PMTiles file source and size
   - Browser console errors (if any)
   - Deployment method (Docker/npm)
