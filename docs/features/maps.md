# Interactive Maps

MeshMonitor provides powerful interactive mapping capabilities to visualize your mesh network in real-time. View node positions, track movement, analyze signal strength, and customize your map experience with flexible tile server options.

![Interactive Map](/images/features/nodes-map.png)

## Overview

The interactive map is the primary visualization tool in MeshMonitor, displaying:

- **Node Positions**: Real-time GPS locations of all nodes in your network
- **Signal Strength**: Color-coded indicators showing network quality (SNR)
- **Network Topology**: Visual connections between nodes
- **Node Status**: Active, inactive, and flagged nodes with distinct markers
- **Traceroute Paths**: Visual representation of message routing paths
- **Custom Markers**: User-defined waypoints and points of interest

## Map Features

### Node Visualization

#### Node Markers

Each node is represented on the map with a marker that provides visual information:

- **Color Coding by SNR (Signal-to-Noise Ratio)**:
  - 🟢 Green: Excellent signal (SNR > 10 dB)
  - 🟡 Yellow: Good signal (SNR 0-10 dB)
  - 🔴 Red: Poor signal (SNR < 0 dB)
  - ⚫ Gray: No signal data available

- **Security Indicators**:
  - ⚠️ Warning icon: Node has security issues (low-entropy keys, duplicate keys)
  - See [Security Features](/features/security) for details

- **Status Indicators**:
  - Solid marker: Active node (heard recently)
  - Faded marker: Inactive node (not heard within configured time window)

#### Node Popups

Click any node marker to view detailed information:

- Node name (long name and short name)
- Node ID (hexadecimal and decimal)
- Hardware model with device image
- Battery level and voltage
- Signal quality (SNR and RSSI)
- Last heard timestamp
- Device role
- Firmware version
- Network position (hops away)

### Map Controls

#### Zoom Controls

- **Zoom In/Out**: Use `+` and `-` buttons or mouse wheel
- **Zoom Limits**: Respects the max zoom level of your selected tileset
- **Double-Click Zoom**: Double-click to zoom in on a location

#### Layer Controls

- **Tileset Selector**: Bottom-center visual picker to switch between map styles
- **Default Tilesets**: OpenStreetMap, Satellite, Topographic, Dark/Light modes
- **Custom Tilesets**: Any configured custom tile servers appear in the selector

#### Map Navigation

- **Pan**: Click and drag to move the map
- **Center on Node**: Click a node in the sidebar to center the map on that node
- **Fit to Network**: Automatically adjusts zoom to show all active nodes

### Traceroute Visualization

When viewing traceroute data:

1. Navigate to a node's details page
2. View the Traceroute section
3. Click "Show on Map" to visualize the routing path
4. The map displays:
   - Color-coded path segments showing hop sequence
   - Arrows indicating message direction
   - SNR indicators at each hop
   - Failed routes shown in red

## Map Tilesets

### Built-in Tilesets

MeshMonitor includes several pre-configured map styles:

#### OpenStreetMap (Default)

- **Style**: Standard OSM map with street and place names
- **Max Zoom**: 19
- **Use Cases**: General-purpose mapping, urban areas
- **URL**: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- **Attribution**: © OpenStreetMap contributors

#### OpenStreetMap HOT

- **Style**: Humanitarian OpenStreetMap Team style
- **Max Zoom**: 19
- **Use Cases**: Disaster response, humanitarian operations
- **URL**: `https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png`
- **Attribution**: © OpenStreetMap contributors, Tiles courtesy of HOT

#### Satellite (ESRI)

- **Style**: Satellite imagery
- **Max Zoom**: 18
- **Use Cases**: Identifying terrain features, physical landmarks
- **URL**: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
- **Attribution**: Tiles © Esri

#### OpenTopoMap

- **Style**: Topographic map with contour lines and elevation data
- **Max Zoom**: 17
- **Use Cases**: Outdoor deployments, terrain analysis, hiking
- **URL**: `https://tile.opentopomap.org/{z}/{x}/{y}.png`
- **Attribution**: © OpenStreetMap contributors, SRTM

#### CartoDB Dark Matter

- **Style**: Minimalist dark theme
- **Max Zoom**: 19
- **Use Cases**: Dark mode displays, nighttime viewing
- **URL**: `https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png`
- **Attribution**: © OpenStreetMap contributors, © CartoDB

#### CartoDB Positron (Light)

- **Style**: Minimalist light theme
- **Max Zoom**: 19
- **Use Cases**: Clean, minimal map display
- **URL**: `https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png`
- **Attribution**: © OpenStreetMap contributors, © CartoDB

### Custom Tile Servers

MeshMonitor supports adding your own custom tile servers for:

- **Offline Operation**: Host tiles locally for complete offline functionality
- **Privacy**: Prevent third-party tile requests from leaking node locations
- **Custom Branding**: Organization-specific map styles
- **High Availability**: Independence from external tile services
- **Specialized Maps**: Aviation charts, nautical charts, custom overlays

#### Supported Tile Types

**Vector Tiles** (Client-side rendered):

- **File Extensions**: `.pbf`, `.mvt`
- **Rendering**: Automatic client-side rendering using MapLibre GL
- **Advantages**:
  - ✅ 5-10x smaller storage than raster tiles
  - ✅ Flexible styling (can adjust colors dynamically)
  - ✅ Sharp at any zoom level
  - ✅ Scales beautifully without pixelation
- **Disadvantages**:
  - ⚠️ Slightly higher CPU usage for rendering
  - ⚠️ Limited to max zoom 14 by default

**Raster Tiles** (Pre-rendered images):

- **File Extensions**: `.png`, `.jpg`, `.jpeg`, `.webp`
- **Rendering**: Browser displays pre-rendered images
- **Advantages**:
  - ✅ No client-side rendering overhead
  - ✅ Works with any tile server or static hosting
  - ✅ Predictable performance
  - ✅ Can support higher zoom levels (18-19)
- **Disadvantages**:
  - ❌ 5-10x larger storage than vector tiles
  - ❌ Fixed styling (can't change appearance)

#### Quick Setup Examples

**For Vector Tiles (.pbf)**:

```
Name: Local Vector Tiles
URL: http://localhost:8080/data/v3/{z}/{x}/{y}.pbf
Attribution: © OpenStreetMap contributors
Max Zoom: 14
```

**For Raster Tiles (.png)**:

```
Name: Local Raster Tiles
URL: http://localhost:8080/styles/basic/{z}/{x}/{y}.png
Attribution: © OpenStreetMap contributors
Max Zoom: 18
```

**For Nginx Caching Proxy**:

```
Name: OpenStreetMap (Cached)
URL: http://localhost:8081/{z}/{x}/{y}.png
Attribution: © OpenStreetMap contributors
Max Zoom: 19
Description: OSM tiles with local caching
```

See the [Custom Tile Servers](/configuration/custom-tile-servers) guide for complete setup instructions, deployment options, and troubleshooting.

## Configuring Map Settings

### Changing the Active Tileset

**Method 1: Settings Tab**

1. Navigate to **Settings** → **Map Settings**
2. In the **Map Tileset Selection** dropdown, choose your desired tileset
3. Click **Save Settings**
4. The map will reload with the new tileset

**Method 2: Visual Selector (Nodes Tab)**

1. Navigate to the **Nodes** tab
2. Locate the tileset selector at the bottom-center of the map
3. Click to open the visual picker showing tileset previews
4. Click your desired tileset
5. The map immediately switches to the new tileset

### Adding Custom Tile Servers

1. Navigate to **Settings** → **Map Settings** → **Custom Tile Servers**
2. Click **+ Add Custom Tile Server**
3. Fill in the required fields:
   - **Name**: Friendly name (e.g., "Local Offline Tiles")
   - **Tile URL**: URL template with `{z}/{x}/{y}` placeholders
   - **Attribution**: Attribution text for the map source
   - **Max Zoom**: Maximum zoom level (1-22)
   - **Description**: Optional description
4. Click **Save**
5. Your custom tileset now appears in the tileset dropdown

### Tile URL Format

Custom tile servers must use the standard XYZ tile format:

```
https://example.com/{z}/{x}/{y}.png
```

**Required Placeholders**:

- `{z}` - Zoom level (0-22)
- `{x}` - Tile X coordinate
- `{y}` - Tile Y coordinate

**Optional Placeholders**:

- `{s}` - Subdomain (e.g., a, b, c for load balancing)

**Examples**:

```
Local server:        http://localhost:8081/{z}/{x}/{y}.png
Subdomain-based:     https://{s}.tiles.example.com/{z}/{x}/{y}.png
Custom path:         https://maps.example.com/tiles/{z}/{x}/{y}.webp
Vector tiles:        http://localhost:8080/data/v3/{z}/{x}/{y}.pbf
```

## Offline Map Operation

### Why Offline Maps?

Offline maps are essential for:

- **Remote Deployments**: Areas without reliable internet connectivity
- **Privacy-Sensitive Operations**: Prevent third-party tile requests from leaking node locations
- **Emergency Response**: Maintain mapping capabilities during network outages
- **High-Traffic Events**: Avoid rate limits and service disruptions
- **Cost Control**: Reduce external API usage and bandwidth costs

### Offline Deployment Options

#### Option 1: TileServer GL Light (Recommended)

**Best for**: True offline operation with pre-downloaded tiles

**Supports**: Both vector (.pbf) and raster (.png) tiles

**Setup**:

1. Download tiles (`.mbtiles` format):
   - Vector tiles: [MapTiler OSM](https://www.maptiler.com/on-prem-datasets/)
   - Raster tiles: [OpenMapTiles Downloads](https://openmaptiles.org/downloads/)

2. Place `.mbtiles` files in `./tiles` directory

3. Start TileServer GL Light:
   ```bash
   docker run -d \
     --name tileserver \
     -p 8080:8080 \
     -v $(pwd)/tiles:/data \
     maptiler/tileserver-gl-light:latest
   ```

4. Add to MeshMonitor (see Quick Setup Examples above)

**Advantages**:
- ✅ Works completely offline
- ✅ No external dependencies
- ✅ Predictable performance
- ✅ No native library issues

#### Option 2: Nginx Caching Proxy

**Best for**: Gradual offline coverage without large upfront download

**Supports**: Raster tiles only

**How it works**:
1. First request: Downloads from online source → saves to cache → serves to browser
2. Subsequent requests: Serves from local cache (works offline)
3. Over time: Builds offline coverage of frequently-viewed areas

**Setup**: See the [Nginx Caching Tile Proxy](/configuration/custom-tile-servers#nginx-caching-tile-proxy-gradual-offline-coverage) section

**Advantages**:
- ✅ No large upfront download
- ✅ Gradually builds offline coverage
- ✅ Works online and offline
- ✅ Simple setup

#### Option 3: Directory Tiles with Static Web Server

**Best for**: Custom tile generation or specific area coverage

**Supports**: Raster tiles only

**Setup**:

1. Generate tiles using QGIS QTiles plugin or tile-downloader
2. Organize in Z/X/Y directory structure:
   ```
   tiles/0/0/0.png
   tiles/1/0/0.png
   tiles/1/0/1.png
   ...
   ```
3. Serve with nginx, Apache, or any static web server
4. Configure CORS headers to allow cross-origin requests

**Advantages**:
- ✅ Full control over tile generation
- ✅ Flexible server options
- ✅ Can customize tile rendering

## Map Privacy and Security

### Privacy Considerations

When using online tile servers:

- **Location Leakage**: Each tile request reveals the geographic area you're viewing
- **Network Topology**: Repeated requests can reveal node locations and network structure
- **Third-Party Tracking**: External tile servers may log IP addresses and request patterns

**Recommended for Privacy**:

1. Use custom tile servers hosted on your network
2. Deploy offline tiles for sensitive operations
3. Use nginx caching proxy to minimize external requests
4. Consider self-hosting TileServer GL on your infrastructure

### Security Best Practices

**HTTPS vs HTTP**:

- **HTTPS**: Required for production deployments and internet-facing servers
- **HTTP**: Acceptable for localhost (127.0.0.1) or trusted internal networks only
- **Mixed Content**: HTTPS sites cannot load HTTP tiles (browser security policy)

**CORS Configuration**:

Custom tile servers must allow cross-origin requests. Configure your server:

**Nginx**:
```nginx
add_header Access-Control-Allow-Origin *;
```

**Apache**:
```apache
Header set Access-Control-Allow-Origin "*"
```

**Node.js/Express**:
```javascript
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});
```

**URL Validation**:

MeshMonitor validates tile URLs to prevent:
- Missing required placeholders (`{z}`, `{x}`, `{y}`)
- Invalid URL format
- Non-HTTP/HTTPS protocols
- Excessively long URLs (> 500 characters)

## Troubleshooting

### Tiles Not Loading (Gray Squares)

**Symptoms**: Map shows gray squares instead of map tiles

**Solutions**:

1. **Check CORS headers**:
   ```bash
   curl -I http://localhost:8080/tiles/0/0/0.png
   # Should include: Access-Control-Allow-Origin: *
   ```

2. **Verify tile server is running**:
   ```bash
   curl http://localhost:8080/tiles/0/0/0.png
   # Should return image data
   ```

3. **Test URL format**:
   - Ensure `{z}`, `{x}`, `{y}` placeholders are present
   - Test with real values: replace `{z}` with 0, `{x}` with 0, `{y}` with 0

4. **Check browser console** (F12 → Console tab):
   - Look for CORS errors
   - Look for 404 Not Found errors
   - Check Network tab for failing requests

### Mixed Content Warnings

**Symptoms**: Browser blocks HTTP tile requests on HTTPS site

**Error Message**: "Mixed Content: The page at 'https://...' was loaded over HTTPS, but requested an insecure resource 'http://...'"

**Solutions**:

1. **Use HTTPS for tile server** (recommended for production)
2. **Use localhost/127.0.0.1** (allowed for development)
3. **Configure reverse proxy** to serve tiles over HTTPS

### Slow Tile Loading

**Symptoms**: Map loads slowly, tiles timeout, or appear gradually

**Solutions**:

1. **Use local tile server**: Much faster than remote servers
2. **Reduce max zoom**: Fewer high-resolution tiles to load
3. **Enable browser caching**: Tiles are cached automatically by modern browsers
4. **Optimize tile size**: Use WebP format for smaller file sizes
5. **Check network bandwidth**: Slow internet affects external tile servers
6. **Use vector tiles**: 5-10x smaller than raster tiles

### Vector Tiles Not Rendering

**Symptoms**: Blank map or gray squares when using `.pbf` tiles

**Solutions**:

1. **Verify file extension**: URL must end with `.pbf` or `.mvt`
2. **Check MapLibre GL**: Ensure browser supports WebGL (all modern browsers do)
3. **Test tile URL directly**: Open tile URL in browser, should download a binary file
4. **Check console errors**: Look for WebGL or MapLibre errors in browser console

### Custom Tileset Not Appearing in Dropdown

**Symptoms**: Added tileset doesn't show in the map tileset selector

**Solutions**:

1. **Refresh the page**: Settings are loaded on page load
2. **Check save succeeded**: Look for success message or error
3. **Verify URL format**: Must include `{z}`, `{x}`, `{y}` placeholders
4. **Clear browser cache**: Force reload with Ctrl+F5 (Cmd+Shift+R on Mac)
5. **Check browser console**: Look for JavaScript errors

## Performance Optimization

### For Large Networks (100+ Nodes)

- Use vector tiles for smaller file sizes and better performance
- Set appropriate max node age to filter inactive nodes
- Consider clustering markers at low zoom levels (future feature)
- Use raster tiles with lower max zoom if vector rendering is slow

### For Limited Bandwidth

- Use nginx caching proxy to build offline coverage gradually
- Choose raster tiles with lower resolution (max zoom 12-14)
- Use WebP format for 20-30% smaller file sizes
- Pre-download only necessary zoom levels

### For Offline Deployments

- Use vector tiles for 5-10x smaller storage
- Download only necessary zoom levels (e.g., 0-14)
- Use regional extracts instead of full planet tiles
- Consider lower resolution tiles for large coverage areas

## Advanced Usage

### Subdomain Load Balancing

Distribute tile requests across multiple servers:

```
URL: https://{s}.tiles.example.com/{z}/{x}/{y}.png
```

Configure DNS:
- `a.tiles.example.com` → Server 1
- `b.tiles.example.com` → Server 2
- `c.tiles.example.com` → Server 3

Benefits:
- Parallel tile loading (faster map rendering)
- Load distribution across servers
- Increased reliability

### Retina/High-DPI Displays

For high-resolution displays, use `@2x` tiles:

```
URL: https://example.com/tiles/{z}/{x}/{y}@2x.png
```

**Note**: Adjust max zoom accordingly (typically max zoom - 1)

### Custom Tile Formats

MeshMonitor supports various tile formats:

- **PNG**: Best quality, larger file size, supports transparency
- **JPEG**: Good for satellite imagery, no transparency, smaller file size
- **WebP**: Modern format, 20-30% smaller, excellent quality, modern browsers only

Example:
```
URL: https://example.com/tiles/{z}/{x}/{y}.webp
```

## Limits and Constraints

- **Maximum Custom Tilesets**: 50 per instance
- **URL Length**: 500 characters maximum
- **Name Length**: 100 characters maximum
- **Attribution Length**: 200 characters maximum
- **Description Length**: 200 characters maximum
- **Zoom Range**: 1-22 (practical limits depend on tile data availability)

## Related Documentation

- [Custom Tile Servers](/configuration/custom-tile-servers) - Complete setup guide
- [Settings](/features/settings) - Map settings configuration
- [Security Features](/features/security) - Understanding security indicators on the map
- [Getting Started](/getting-started) - Initial MeshMonitor setup

## Best Practices

1. **Test locally first**: Verify tiles load correctly before production deployment
2. **Use descriptive names**: Make it easy to identify tilesets
3. **Include attribution**: Give proper credit to tile data providers
4. **Set appropriate max zoom**: Match your tile data's capabilities
5. **Monitor storage**: Offline tiles can consume significant disk space
6. **Regular updates**: Keep offline tiles current for map accuracy
7. **Backup configurations**: Export custom tileset settings before major changes
8. **Choose the right tile type**: Vector for flexibility and size, raster for compatibility
9. **Plan for offline**: Pre-download tiles for areas you'll need offline
10. **Secure your tile server**: Use HTTPS in production, restrict access if needed

## Support and Feedback

For issues, questions, or feature requests:

- **GitHub Issues**: [github.com/yeraze/meshmonitor/issues](https://github.com/yeraze/meshmonitor/issues)
- **Documentation**: [MeshMonitor Docs](https://yeraze.github.io/meshmonitor/)
- **Custom Tile Server Guide**: [Custom Tile Servers](/configuration/custom-tile-servers)
