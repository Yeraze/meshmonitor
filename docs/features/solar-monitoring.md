# Solar Monitoring

MeshMonitor provides integrated solar production monitoring and visualization to help optimize off-grid Meshtastic deployments. By integrating with the forecast.solar API, you can monitor expected solar power generation and correlate it with your node's telemetry data.

## Overview

The solar monitoring feature automatically fetches solar production estimates from [forecast.solar](https://forecast.solar) based on your configured location and solar panel parameters. These estimates are displayed as translucent overlays on telemetry graphs, allowing you to:

- Predict when your solar-powered nodes will have sufficient power
- Correlate battery charging patterns with solar production
- Plan maintenance windows during peak solar production
- Optimize solar panel placement and orientation

## Configuration

### Solar Panel Settings

To enable solar monitoring, navigate to **Settings** and configure the following parameters:

#### Required Settings

- **Latitude**: Geographic latitude of your solar installation (-90 to 90)
- **Longitude**: Geographic longitude of your solar installation (-180 to 180)
- **Declination**: Tilt angle of your solar panels from horizontal (0-90 degrees)
  - 0° = Horizontal (flat)
  - 90° = Vertical
  - Most installations use 20-40° depending on latitude
- **Azimuth**: Compass direction your panels face (0-360 degrees)
  - 0° = North
  - 90° = East
  - 180° = South (optimal in Northern Hemisphere)
  - 270° = West

#### Additional Configuration Details

- **Panel Capacity**: The wattage of your solar panels (optional, affects scaling)
- **API Requests**: Estimates are automatically fetched hourly at :05 minutes past the hour
- **Data Retention**: Solar estimates are stored in the database for historical analysis

### Validation

After configuring your settings, click **Save Settings**. MeshMonitor will begin fetching solar estimates on the next hourly cycle. You can verify the configuration is working by:

1. Navigating to the **Telemetry Dashboard** or **Node Details** page
2. Looking for the translucent yellow overlay on telemetry graphs
3. Checking that solar estimates appear in graph tooltips

## Visualization

### Telemetry Graphs

Solar production estimates appear as **translucent yellow area overlays** on all telemetry graphs showing time-series data.

#### Features

- **Dual Y-Axes**: The left axis shows telemetry metrics (battery %, voltage, etc.), while a hidden right axis scales the solar estimates
- **Automatic Alignment**: Solar forecast timestamps are matched to telemetry data points using nearest-neighbor search (within 1-hour window)
- **Tooltip Integration**: Hover over any data point to see both telemetry values and the corresponding solar estimate
- **Auto-Refresh**: Solar data refreshes automatically every 60 seconds to show the latest forecasts

#### Display Locations

Solar overlays appear on:
- **Node Details** page: Telemetry graphs for individual nodes
- **Telemetry Dashboard**: All favorite telemetry charts
- **Any time-series telemetry visualization**

### Visual Design

- **Color**: Translucent yellow (`#f9e2af` with 30% opacity)
- **Overlay**: Sits behind telemetry line charts to avoid obscuring data
- **Scale**: Automatically scaled to match the visible range of telemetry data

## Data Management

### Automatic Fetching

MeshMonitor automatically fetches solar estimates using a cron scheduler:

- **Schedule**: Runs at :05 minutes past every hour (e.g., 1:05, 2:05, etc.)
- **Forecast Range**: Retrieves up to 500 data points per request
- **Upsert Logic**: Uses `INSERT OR REPLACE` to handle overlapping forecast timestamps
- **Silent Failure**: If solar monitoring is not configured, fetching silently skips without errors

### Manual Triggering

For testing or immediate updates, you can manually trigger a solar estimate fetch:

```bash
curl -X POST http://your-meshmonitor:8080/api/solar/trigger
```

This is useful for:
- Testing your solar configuration
- Updating estimates after changing panel parameters
- Debugging forecast data issues

### Database Storage

Solar estimates are stored in the `solar_estimates` table with:

- **Timestamp**: Unix epoch seconds (stored as INTEGER)
- **Watt-Hours**: Estimated solar production at that timestamp
- **Unique Constraint**: Prevents duplicate entries for the same timestamp

## API Endpoints

### Get Recent Estimates

```http
GET /api/solar/estimates?limit=500
```

**Parameters**:
- `limit` (optional): Maximum number of estimates to return (default: 100, max: 500)

**Response**:
```json
[
  {
    "timestamp": 1704067200,
    "watts": 125
  },
  {
    "timestamp": 1704070800,
    "watts": 250
  }
]
```

### Get Estimates for Time Range

```http
GET /api/solar/estimates/range?start=1704067200&end=1704153600
```

**Parameters**:
- `start` (required): Unix timestamp (seconds) for range start
- `end` (required): Unix timestamp (seconds) for range end

**Response**:
```json
[
  {
    "timestamp": 1704067200,
    "watts": 125
  },
  {
    "timestamp": 1704070800,
    "watts": 250
  }
]
```

### Trigger Manual Fetch

```http
POST /api/solar/trigger
```

**Response**:
```json
{
  "success": true,
  "message": "Solar estimates fetched successfully"
}
```

## Technical Details

### Data Flow

1. **Configuration**: User configures solar panel parameters in Settings
2. **Scheduling**: Cron job runs hourly at :05 minutes past the hour
3. **API Request**: MeshMonitor queries forecast.solar with configured parameters
4. **Storage**: Estimates are stored in SQLite database with unique timestamp constraint
5. **Retrieval**: Frontend fetches estimates via `/api/solar/estimates` endpoint
6. **Alignment**: Nearest-neighbor algorithm matches forecast timestamps to telemetry data
7. **Rendering**: Recharts ComposedChart displays solar overlay with telemetry lines

### Timestamp Handling

- **API Storage**: Unix seconds (INTEGER in database)
- **Frontend**: Converts to milliseconds for JavaScript Date objects
- **Matching**: Nearest-neighbor search within 1-hour (3600000ms) window
- **Alignment**: Ensures forecast data aligns with telemetry data points even when timestamps don't match exactly

### Performance Considerations

- **Fetch Frequency**: Hourly fetching minimizes API calls while maintaining fresh data
- **Data Limit**: 500 estimate limit prevents excessive memory usage
- **Caching**: Database storage acts as cache to reduce API dependencies
- **Lazy Loading**: Solar data loads independently and doesn't block telemetry display

### forecast.solar Integration

MeshMonitor uses the free [forecast.solar](https://forecast.solar) API, which provides:

- **No Registration Required**: Free tier works without API keys
- **Global Coverage**: Works anywhere in the world
- **Accurate Forecasts**: Uses weather data and solar physics models
- **Future Estimates**: Provides multi-day forecasts for planning

For high-traffic deployments, consider the forecast.solar [paid tiers](https://forecast.solar/pricing) for:
- Higher rate limits
- Extended forecast periods
- Commercial support

## Use Cases

### Battery Monitoring Correlation

Compare battery levels with solar production to:
- Identify charging inefficiencies
- Detect failing solar panels or charge controllers
- Optimize battery bank sizing

### Network Planning

Use solar forecasts to:
- Schedule network maintenance during peak production hours
- Plan firmware updates when batteries will be fully charged
- Predict when remote nodes may go offline due to insufficient solar

### Off-Grid Optimization

- Determine optimal panel tilt for your latitude
- Analyze seasonal production variations
- Size battery banks based on worst-case solar scenarios

### Performance Monitoring

- Detect underperforming panels (actual vs forecast)
- Identify shading issues affecting production
- Track long-term solar system degradation

## Troubleshooting

### No Solar Overlay Appearing

**Possible Causes**:
- Solar monitoring not configured (latitude/longitude missing)
- No data available yet (wait for next hourly fetch at :05)
- API request failed (check server logs)
- Telemetry time range doesn't overlap with forecast data

**Solutions**:
1. Verify solar settings are saved in Settings tab
2. Manually trigger a fetch: `POST /api/solar/trigger`
3. Check browser console for API errors
4. Verify telemetry date range includes future timestamps

### Incorrect Estimates

**Possible Causes**:
- Wrong latitude/longitude configured
- Incorrect azimuth or declination settings
- Panel capacity not matching actual installation

**Solutions**:
1. Verify location coordinates are accurate
2. Use a compass to confirm panel azimuth
3. Measure panel tilt angle with protractor or angle finder
4. Update settings and trigger new fetch

### API Rate Limiting

**Symptoms**:
- Estimates stop updating
- 429 HTTP errors in server logs

**Solutions**:
1. Reduce fetch frequency (modify cron schedule)
2. Consider forecast.solar paid tier for higher limits
3. Contact forecast.solar support if issues persist

## Privacy & Security

- **No Personal Data**: Only solar panel configuration is sent to forecast.solar
- **No Authentication Required**: API calls don't include user information
- **Optional Feature**: Solar monitoring is completely optional and can be left unconfigured
- **Local Storage**: All fetched estimates are stored locally in your MeshMonitor database

## Related Documentation

- [Settings](/features/settings) - Configure solar panel parameters
- [Telemetry Visualization](/features/device#telemetry-graphs) - Understanding telemetry graphs
- [API Reference](/api/API_REFERENCE) - Complete API documentation
- [Database Schema](/database/SCHEMA) - Solar estimates table structure

## Version History

- **v2.14.0**: Added solar overlay to Telemetry Dashboard
- **v2.13.0**: Initial solar monitoring integration with forecast.solar
- **v2.12.0**: Added solar panel configuration UI in Settings
