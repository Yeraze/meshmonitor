#!/usr/bin/env python3
# mm_meta:
#   name: Pirate Weather ADV
#   emoji: 🌦️
#   language: Python
"""
Weather script for mesh network auto-responders using the Pirate Weather API.

Resolution order — the script tries each source in order and uses the first that works:
  1. CLI argument          — location passed directly to the script (e.g. Timed Events)
  2. PARAM_location env var — location string set by the auto-responder trigger pipeline
  3. FROM_LAT / FROM_LON   — GPS coordinates sent by the requesting node
  4. LOCAL_LAT / LOCAL_LON — GPS coordinates configured on the local node (fallback)

Note: A leading "weather" keyword is automatically stripped from the location string in
both CLI arguments and PARAM_location, so both of these work:
  peterborough,ontario,canada
  weather peterborough,ontario,canada

When a location string is used, output matches the original format:
  Weather for Peterborough, Ontario, Canada: Misty. Currently 40°F (feels like 32°F).
  Today: High 47°F, Low 38°F. Humidity: 96%, Wind: 9 mph.

When GPS coordinates are used, output uses the emoji format with a reverse-geocoded city:
  📍 Peterborough, Ontario
  🌡️ Temperature: 40°F (feels like 32°F)
  📊 Forecast: Misty
  ↕️ High: 47°F  Low: 38°F
  💧 Humidity: 96%  💨 Wind: 9 mph

All weather data is sourced exclusively from Pirate Weather (pirateweather.net).
Location names are resolved via OpenStreetMap Nominatim (free, no API key needed).

Requirements:
- Python 3.6+
- PIRATE_WEATHER_API_KEY environment variable (get free key from https://pirateweather.net/)

Setup:
1. Get API key from https://pirateweather.net/
2. Add to docker-compose.yaml environment variables:
   - PIRATE_WEATHER_API_KEY=your_api_key_here
   - LOCAL_LAT=your_latitude      # fallback GPS for local node
   - LOCAL_LON=your_longitude
3. Ensure volume mapping in docker-compose.yaml:
   - ./scripts:/data/scripts
4. Copy PirateWeatherADV.py to scripts/ directory
5. Make executable: chmod +x scripts/PirateWeatherADV.py
6. Configure triggers in your auto-responder:
   - Trigger: weather               (GPS mode — uses node coordinates)
   - Trigger: weather {location:.+} (location mode — user types a place name)
   - Response Type: script
   - Response: /data/scripts/PirateWeatherADV.py

Local testing:
  GPS mode:
    TEST_MODE=true FROM_LAT=43.55 FROM_LON=-78.49 PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py
  Location mode:
    TEST_MODE=true PARAM_location="peterborough,ontario,canada" PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py
  CLI argument mode (e.g. Timed Events):
    TEST_MODE=true PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py peterborough,ontario,canada
"""

import os
import sys
import json
import urllib.request
import urllib.parse
from typing import Optional, Tuple, Dict, Any


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PIRATE_WEATHER_API_KEY = os.environ.get('PIRATE_WEATHER_API_KEY', '')
TEST_MODE = os.environ.get('TEST_MODE', 'false').lower() == 'true'


# ---------------------------------------------------------------------------
# Coordinate helpers
# ---------------------------------------------------------------------------

def _parse_coords(lat_str: str, lon_str: str, label: str) -> Optional[Tuple[float, float]]:
    """Parse and range-validate a lat/lon pair. Returns (lat, lon) or None."""
    try:
        lat = float(lat_str)
        lon = float(lon_str)
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            print(f'Coordinates out of valid range for {label}: {lat}, {lon}', file=sys.stderr)
            return None
        return (lat, lon)
    except ValueError:
        print(f'Invalid coordinate values for {label}: {lat_str}, {lon_str}', file=sys.stderr)
        return None


def geocode_location(location: str) -> Optional[Tuple[float, float]]:
    """
    Forward-geocode a location string to (lat, lon) using Nominatim.
    Returns None if the location cannot be found.
    """
    try:
        params = {'q': location, 'format': 'json', 'limit': 1}
        url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'User-Agent': 'PirateWeatherADV/1.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        if data:
            return (float(data[0]['lat']), float(data[0]['lon']))
    except Exception as e:
        print(f'Geocoding error for "{location}": {e}', file=sys.stderr)
    return None


def reverse_geocode_city(lat: float, lon: float) -> str:
    """
    Reverse-geocode (lat, lon) to a human-readable city name using Nominatim.
    Falls back to raw coordinates if the lookup fails.
    """
    try:
        params = {'lat': lat, 'lon': lon, 'format': 'json', 'zoom': 10}
        url = 'https://nominatim.openstreetmap.org/reverse?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'User-Agent': 'PirateWeatherADV/1.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))

        address = data.get('address') or {}
        city = (
            address.get('city')
            or address.get('town')
            or address.get('village')
            or address.get('hamlet')
            or address.get('county')
        )
        state = address.get('state', '')
        country_code = address.get('country_code', '').upper()

        if city:
            if state and country_code == 'US':
                return f'{city}, {state}'
            elif country_code:
                return f'{city}, {country_code}'
            else:
                return city
    except Exception as e:
        print(f'Reverse geocode error: {e}', file=sys.stderr)

    return f'{lat:.4f}, {lon:.4f}'


# ---------------------------------------------------------------------------
# Input resolution
# ---------------------------------------------------------------------------

def resolve_input() -> Tuple[Optional[Tuple[float, float]], Optional[str], str]:
    """
    Determine the source of the weather lookup.

    Returns:
      (coords, location_label, mode)

      coords         — (lat, lon) or None if nothing could be resolved
      location_label — display name for the response (only set in 'location' mode)
      mode           — 'location' (user typed a place) or 'gps' (node coordinates)

    Resolution order:
      1. PARAM_location — user-supplied location string, geocoded via Nominatim
      2. FROM_LAT / FROM_LON — GPS from the requesting node
      3. LOCAL_LAT / LOCAL_LON — GPS from the local node (fallback)
    """
    # 1. Check for CLI argument first (e.g. Timed Events passing "peterborough,ontario,canada")
    #    then fall back to PARAM_location env var (set by trigger pipeline)
    location = ''
    if len(sys.argv) > 1:
        location = ' '.join(sys.argv[1:]).strip()
    if not location:
        location = os.environ.get('PARAM_location', '').strip()

    # Strip leading "weather" keyword if someone includes it in either source
    # e.g. "weather peterborough,ontario,canada" → "peterborough,ontario,canada"
    if location.lower().startswith('weather'):
        location = location[len('weather'):].strip()

    if location and location.lower() not in ('help', 'h', '?'):
        coords = geocode_location(location)
        # Build a clean display label from the raw input.
        # Split on commas, then capitalise each part carefully so that short
        # all-caps tokens (province/state codes like "ON", "NY", "CA") are
        # preserved, and apostrophes (e.g. "st. john's" → "St. John's")
        # aren't mangled by str.title().
        def _fmt(part: str) -> str:
            words = part.strip().split()
            out = []
            for w in words:
                if not w:
                    continue
                if w.isupper() and len(w) <= 3:   # looks like an abbreviation
                    out.append(w)
                else:
                    out.append(w[0].upper() + w[1:])
            return ' '.join(out)

        label = ', '.join(_fmt(part) for part in location.split(','))
        if coords:
            return (coords, label, 'location')
        else:
            # Geocoding failed — return None so main() can report the error
            return (None, label, 'location')

    # 2. Requesting node GPS
    from_lat = os.environ.get('FROM_LAT', '').strip()
    from_lon = os.environ.get('FROM_LON', '').strip()
    if from_lat and from_lon:
        coords = _parse_coords(from_lat, from_lon, 'requesting node')
        if coords:
            return (coords, None, 'gps')

    # 3. Local node GPS fallback
    local_lat = os.environ.get('LOCAL_LAT', '').strip()
    local_lon = os.environ.get('LOCAL_LON', '').strip()
    if local_lat and local_lon:
        coords = _parse_coords(local_lat, local_lon, 'local node')
        if coords:
            return (coords, None, 'gps')

    return (None, None, 'gps')


# ---------------------------------------------------------------------------
# Weather fetch
# ---------------------------------------------------------------------------

def get_weather(lat: float, lon: float) -> Dict[str, Any]:
    """
    Fetch current weather from Pirate Weather for (lat, lon).

    Returns:
      {'data': {...}} on success, or {'error': '...'} on failure.
    """
    if not PIRATE_WEATHER_API_KEY:
        return {
            'error': 'Pirate Weather API key not configured. '
                     'Please set PIRATE_WEATHER_API_KEY environment variable.'
        }

    try:
        url = f'https://api.pirateweather.net/forecast/{PIRATE_WEATHER_API_KEY}/{lat},{lon}'
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))

        current      = data.get('currently') or {}
        daily_periods = (data.get('daily') or {}).get('data') or []
        today        = daily_periods[0] if daily_periods else {}

        temp       = current.get('temperature')
        feels_like = current.get('apparentTemperature')
        summary    = current.get('summary') or 'N/A'
        humidity   = current.get('humidity') or 0
        wind_speed = current.get('windSpeed') or 0
        high_temp  = today.get('temperatureHigh')
        low_temp   = today.get('temperatureLow')

        if temp is None or feels_like is None:
            return {'error': 'Pirate Weather returned incomplete data (missing temperature).'}

        return {'data': {
            'temp':       temp,
            'feels_like': feels_like,
            'summary':    summary,
            'humidity':   humidity,
            'wind_speed': wind_speed,
            'high_temp':  high_temp,
            'low_temp':   low_temp,
        }}

    except urllib.error.HTTPError as e:
        return {'error': f'Weather API error: {e.code} {e.reason}'}
    except urllib.error.URLError as e:
        return {'error': f'Network error: {e.reason}'}
    except json.JSONDecodeError:
        return {'error': 'Invalid response from Pirate Weather API'}
    except Exception as e:
        return {'error': f'Unexpected error: {str(e)}'}


# ---------------------------------------------------------------------------
# Response formatters
# ---------------------------------------------------------------------------

def format_location_response(label: str, d: dict) -> str:
    """
    Original single-line text format used when the user typed a location name.
    Example:
      Weather for Peterborough, Ontario, Canada: Misty. Currently 40°F (feels like 32°F).
      Today: High 47°F, Low 38°F. Humidity: 96%, Wind: 9 mph.
    """
    response = (
        f'Weather for {label}: {d["summary"]}. '
        f'Currently {d["temp"]:.0f}°F (feels like {d["feels_like"]:.0f}°F). '
    )
    if d['high_temp'] is not None and d['low_temp'] is not None:
        response += f'Today: High {d["high_temp"]:.0f}°F, Low {d["low_temp"]:.0f}°F. '
    response += f'Humidity: {d["humidity"]*100:.0f}%, Wind: {d["wind_speed"]:.0f} mph.'
    return response


def format_gps_response(lat: float, lon: float, d: dict) -> str:
    """
    Emoji multi-line format used when coordinates come from the node GPS.
    City name is reverse-geocoded from the coordinates.
    """
    city_name = reverse_geocode_city(lat, lon)
    lines = [
        f'📍 {city_name}',
        f'🌡️ Temperature: {d["temp"]:.0f}°F (feels like {d["feels_like"]:.0f}°F)',
        f'📊 Forecast: {d["summary"]}',
    ]
    if d['high_temp'] is not None and d['low_temp'] is not None:
        lines.append(f'↕️ High: {d["high_temp"]:.0f}°F  Low: {d["low_temp"]:.0f}°F')
    lines.append(f'💧 Humidity: {d["humidity"]*100:.0f}%  💨 Wind: {d["wind_speed"]:.0f} mph')
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    try:
        coords, label, mode = resolve_input()

        if coords is None:
            if mode == 'location' and label:
                response = (
                    f'Could not find location: "{label}". '
                    'Try a more specific format, e.g. "peterborough,ontario,canada".'
                )
            else:
                response = (
                    'No location or GPS data available. '
                    'Options: '
                    '(1) Send "weather peterborough,ontario,canada" to query by location. '
                    '(2) Add a CLI argument in your Timed Event: "peterborough,ontario,canada". '
                    '(3) Ensure your node has GPS (FROM_LAT/FROM_LON). '
                    '(4) Configure LOCAL_LAT/LOCAL_LON as a GPS fallback.'
                )
        else:
            lat, lon = coords

            if TEST_MODE:
                print(f'Mode: {mode} | Coords: {lat}, {lon} | Label: {label}', file=sys.stderr)

            result = get_weather(lat, lon)

            if 'error' in result:
                response = f'Error: {result["error"]}'
            elif mode == 'location':
                response = format_location_response(label, result['data'])
            else:
                response = format_gps_response(lat, lon, result['data'])

        print(json.dumps({'response': response}))
        sys.stdout.flush()

        if TEST_MODE:
            print(f'\n--- TEST MODE OUTPUT ---\n{response}\n--- END TEST ---\n', file=sys.stderr)

    except Exception as e:
        error_msg = f'Error: {str(e)}'
        print(json.dumps({'response': error_msg}))
        sys.stdout.flush()

        if TEST_MODE:
            print(f'\n--- TEST MODE ERROR ---\n{error_msg}\n--- END TEST ---\n', file=sys.stderr)

        sys.exit(0)


if __name__ == '__main__':
    main()
