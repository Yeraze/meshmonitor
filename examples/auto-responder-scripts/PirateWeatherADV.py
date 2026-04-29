#!/usr/bin/env python3
"""
PirateWeatherADV — Weather script for mesh network auto-responders.
Uses the Pirate Weather API for data and OpenStreetMap Nominatim for geocoding.

TWO SEPARATE TRIGGERS:

  weather / w  — Current conditions only (single message)
    Output example:
      Weather for Peterborough, Ontario, Canada: Misty.
      Currently 40°F / 4°C (feels like 32°F / 0°C).
      Today: High 47°F / 8°C, Low 38°F / 3°C.
      Humidity: 96%, Wind: 9 mph.

  forecast / f — 7-day forecast (split into as many messages as needed)
    Output example (message 1 of 2):
      7-Day Forecast - Peterborough, Ontario, Canada:
      Mon: Misty. Hi 40°F/4°C Lo 33°F/1°C 💧85%
      Tue: Cloudy. Hi 47°F/8°C Lo 38°F/3°C 💧40%
      Wed: Partly Cloudy. Hi 52°F/11°C Lo 41°F/5°C 💧15%
    Output example (message 2 of 2):
      Thu: Clear. Hi 55°F/13°C Lo 43°F/6°C
      Fri: Rain. Hi 48°F/9°C Lo 39°F/4°C 💧90%
      Sat: Cloudy. Hi 44°F/7°C Lo 36°F/2°C 💧50%
      Sun: Clear. Hi 50°F/10°C Lo 38°F/3°C 💧10%

GPS MODE (no location typed):
  Both triggers fall back to GPS coordinates in this order:
    1. FROM_LAT / FROM_LON  — GPS sent by the requesting node
    2. LOCAL_LAT / LOCAL_LON — local node GPS (also accepts MM_LAT / MM_LON)
  GPS mode output uses emoji format with a reverse-geocoded city name.
  GPS mode example output:
    📍 Peterborough, CA
    🌡️ 40°F / 4°C (feels like 32°F / 0°C)
    📊 Forecast: Misty
    ↕️ High: 47°F / 8°C  Low: 38°F / 3°C
    💧 Humidity: 96%  💨 Wind: 9 mph

INPUT FORMATS (spaces after commas are fine, all produce identical results):
  weather peterborough,ontario,canada
  weather peterborough, ontario, canada
  w peterborough, ontario, canada
  forecast peterborough, ontario, canada
  f peterborough, ontario, canada

MODE DETECTION ORDER (how the script decides weather vs forecast):
  1. TRIGGER env var  — MeshMonitor sets this to the matched trigger pattern.
                        Most reliable source; checked first.
  2. MESSAGE env var  — Full original message typed by the user. Fallback if
                        TRIGGER alone doesn't identify the mode.
  3. PARAM_mode       — Explicit override env var ('forecast' or 'weather').
                        Useful for Timed Events.
  4. Leading keyword  — Keyword at the start of CLI arg or PARAM_location
                        (e.g. "forecast peterborough,ontario,canada").
  5. Default          — 'weather' if none of the above match.

All weather data is sourced exclusively from Pirate Weather (pirateweather.net).
Location names are resolved via OpenStreetMap Nominatim (free, no API key needed).

Requirements:
- Python 3.6+
- PIRATE_WEATHER_API_KEY environment variable (get free key at https://pirateweather.net/)

Setup:
1. Get a free API key from https://pirateweather.net/
2. Add to docker-compose.yaml environment variables:
   - PIRATE_WEATHER_API_KEY=your_api_key_here
   - LOCAL_LAT=your_latitude      # optional GPS fallback for local node
   - LOCAL_LON=your_longitude     # (MM_LAT / MM_LON also accepted as aliases)
3. Ensure volume mapping in docker-compose.yaml:
   - ./scripts:/data/scripts
4. Copy PirateWeatherADV.py to scripts/ directory
5. Make executable: chmod +x scripts/PirateWeatherADV.py

MeshMonitor Auto Responder Configuration:
  Navigate to Settings → Automation → Auto Responder → Add Trigger.
  Create TWO trigger entries, each pointing to the same script:

  Trigger 1 — Current conditions (weather / w):
    Trigger field:  weather, weather {location:.+}, w {location:.+}
    Response type:  Script
    Script path:    /data/scripts/PirateWeatherADV.py

  Trigger 2 — 7-day forecast (forecast / f):
    Trigger field:  forecast, forecast {location:.+}, f {location:.+}
    Response type:  Script
    Script path:    /data/scripts/PirateWeatherADV.py

  The comma-separated patterns in each trigger field allow one entry to handle
  both the bare keyword (GPS mode) and the keyword + location variants.
  MeshMonitor sets the TRIGGER env var to the matched pattern, which the script
  uses to reliably determine weather vs forecast mode regardless of whether
  PARAM_location contains the keyword.

Local testing:
  Current conditions by location:
    TEST_MODE=true PARAM_location="peterborough,ontario,canada" PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py
  7-day forecast by location:
    TEST_MODE=true PARAM_location="forecast peterborough,ontario,canada" PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py
  GPS mode — current conditions:
    TEST_MODE=true FROM_LAT=43.55 FROM_LON=-78.49 PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py
  GPS mode — forecast (simulate forecast trigger):
    TEST_MODE=true TRIGGER=forecast FROM_LAT=43.55 FROM_LON=-78.49 PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py
  CLI argument — current conditions (Timed Events):
    TEST_MODE=true PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py peterborough,ontario,canada
  CLI argument — forecast (Timed Events):
    TEST_MODE=true PIRATE_WEATHER_API_KEY=your_key python3 PirateWeatherADV.py forecast peterborough,ontario,canada
"""

import os
import sys
import json
import time
import urllib.request
import urllib.parse
from typing import Optional, Tuple, Dict, List, Any


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PIRATE_WEATHER_API_KEY = os.environ.get('PIRATE_WEATHER_API_KEY', '')
TEST_MODE = os.environ.get('TEST_MODE', 'false').lower() == 'true'

# MeshMonitor enforces a 200-char max per message and a 10-second script timeout.
# Network timeouts: geocode 3s + API 4s + reverse geocode 3s = 10s worst case.
MSG_LIMIT = 200

# Day-of-week abbreviations indexed by Python's tm_wday (0=Mon … 6=Sun)
DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

# Trigger keywords that identify forecast mode
FORECAST_KEYWORDS = ('forecast', 'f')
# Trigger keywords that identify weather (current conditions) mode
WEATHER_KEYWORDS  = ('weather', 'w')


# ---------------------------------------------------------------------------
# Unit conversion
# ---------------------------------------------------------------------------

def to_c(f: float) -> float:
    """Convert Fahrenheit to Celsius."""
    return (f - 32) * 5 / 9


def fmt_temp(f: float) -> str:
    """Format a temperature as XX°F / XX°C."""
    return f'{f:.0f}°F / {to_c(f):.0f}°C'


def fmt_temp_compact(f: float) -> str:
    """Compact temperature format for forecast lines: XX°F/XX°C."""
    return f'{f:.0f}°F/{to_c(f):.0f}°C'


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
    Returns None if the location cannot be found or the request fails.
    """
    try:
        params = {'q': location, 'format': 'json', 'limit': 1}
        url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'User-Agent': 'PirateWeatherADV/1.0'})
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        if data:
            return (float(data[0]['lat']), float(data[0]['lon']))
    except Exception as e:
        print(f'Geocoding error for "{location}": {e}', file=sys.stderr)
    return None


def reverse_geocode_city(lat: float, lon: float) -> str:
    """
    Reverse-geocode (lat, lon) to a city name using Nominatim.
    Returns a raw coordinate string if the lookup fails.
    """
    try:
        params = {'lat': lat, 'lon': lon, 'format': 'json', 'zoom': 10}
        url = 'https://nominatim.openstreetmap.org/reverse?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'User-Agent': 'PirateWeatherADV/1.0'})
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))

        address = data.get('address') or {}
        city = (
            address.get('city')
            or address.get('town')
            or address.get('village')
            or address.get('hamlet')
            or address.get('county')
        )
        state        = address.get('state', '')
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
# Label formatter
# ---------------------------------------------------------------------------

def _fmt_label(location: str) -> str:
    """
    Build a clean display label from a raw location string.
    Splits on commas, capitalises each part carefully so:
      - Abbreviations (ON, NY, CA) are preserved in upper case
      - Apostrophes (St. John's) are not mangled by str.title()
      - Empty parts from double/trailing commas are skipped
    """
    def _fmt_part(part: str) -> str:
        words = part.strip().split()
        out = []
        for w in words:
            if not w:
                continue
            if w.isupper() and len(w) <= 3:
                out.append(w)
            else:
                out.append(w[0].upper() + w[1:])
        return ' '.join(out)

    parts = [p.strip() for p in location.split(',') if p.strip()]
    return ', '.join(_fmt_part(p) for p in parts)


# ---------------------------------------------------------------------------
# Input resolution
# ---------------------------------------------------------------------------

def resolve_input() -> Tuple[Optional[Tuple[float, float]], Optional[str], str, str]:
    """
    Determine coordinates, display label, output mode (weather/forecast),
    and input mode (location/gps).

    Returns:
      (coords, label, output_mode, input_mode)

      coords      — (lat, lon) or None if nothing could be resolved
      label       — display name string, or None if GPS mode
      output_mode — 'weather' (current conditions) or 'forecast' (7-day)
      input_mode  — 'location' or 'gps'

    Resolution order for location:
      1. CLI arguments (e.g. Timed Events)
      2. PARAM_location env var (trigger pipeline)

    Resolution order for coordinates when no location string given:
      3. FROM_LAT / FROM_LON  — requesting node GPS
      4. LOCAL_LAT / LOCAL_LON or MM_LAT / MM_LON — local node GPS

    Output mode is determined by:
      - The leading keyword in the location string (forecast/f vs weather/w)
      - PARAM_mode env var as a fallback override ('forecast' or 'f')
      - Defaults to 'weather' if no keyword is found
    """
    # ---------------------------------------------------------------------------
    # Determine output_mode from multiple sources, in priority order:
    #
    # 1. TRIGGER env var — MeshMonitor sets this to the pattern that matched
    #    e.g. "forecast {location:.+}" or "forecast" — most reliable source.
    # 2. MESSAGE env var — full original message, e.g. "forecast peterborough..."
    #    Used as fallback when TRIGGER doesn't contain the keyword.
    # 3. PARAM_mode env var — explicit override, useful for Timed Events.
    # 4. Leading keyword in the CLI arg or PARAM_location string.
    # 5. Default: 'weather'
    # ---------------------------------------------------------------------------

    output_mode = 'weather'  # default

    # 1. Check TRIGGER env var (most reliable — set by MeshMonitor)
    trigger = os.environ.get('TRIGGER', '').strip().lower()
    if any(trigger == kw or trigger.startswith(kw + ' ') or trigger.startswith(kw + ',')
           for kw in FORECAST_KEYWORDS):
        output_mode = 'forecast'
    elif any(trigger == kw or trigger.startswith(kw + ' ') or trigger.startswith(kw + ',')
             for kw in WEATHER_KEYWORDS):
        output_mode = 'weather'

    # 2. Check full MESSAGE env var as fallback
    if output_mode == 'weather':  # only if not already determined
        message = os.environ.get('MESSAGE', '').strip().lower()
        if any(message == kw or message.startswith(kw + ' ') or message.startswith(kw + ',')
               for kw in FORECAST_KEYWORDS):
            output_mode = 'forecast'

    # 3. PARAM_mode explicit override
    param_mode = os.environ.get('PARAM_mode', '').strip().lower()
    if param_mode in ('forecast', 'f'):
        output_mode = 'forecast'
    elif param_mode in ('weather', 'w'):
        output_mode = 'weather'

    # Gather raw location string: CLI args first, then PARAM_location
    location = ''
    if len(sys.argv) > 1:
        location = ' '.join(sys.argv[1:]).strip()
    if not location:
        location = os.environ.get('PARAM_location', '').strip()

    # 4. Detect and strip leading keyword from the location string itself
    #    (handles CLI args and direct PARAM_location with keyword prefix)
    loc_lower = location.lower()
    stripped = False
    for kw in FORECAST_KEYWORDS:
        if loc_lower == kw or loc_lower.startswith(kw + ' ') or loc_lower.startswith(kw + ','):
            output_mode = 'forecast'
            location = location[len(kw):].strip()
            stripped = True
            break
    if not stripped:
        for kw in WEATHER_KEYWORDS:
            if loc_lower == kw or loc_lower.startswith(kw + ' ') or loc_lower.startswith(kw + ','):
                output_mode = 'weather'
                location = location[len(kw):].strip()
                break

    # If we have a location string, geocode it
    if location and location.lower() not in ('help', 'h', '?'):
        # Normalise: strip spaces around commas, filter empty parts
        parts = [p.strip() for p in location.split(',') if p.strip()]
        location_normalised = ','.join(parts)
        coords = geocode_location(location_normalised)
        label  = _fmt_label(location)
        if coords:
            return (coords, label, output_mode, 'location')
        else:
            return (None, label, output_mode, 'location')

    # No location string — fall back to GPS coordinates
    from_lat = os.environ.get('FROM_LAT', '').strip()
    from_lon = os.environ.get('FROM_LON', '').strip()
    if from_lat and from_lon:
        coords = _parse_coords(from_lat, from_lon, 'requesting node')
        if coords:
            return (coords, None, output_mode, 'gps')

    local_lat = (os.environ.get('LOCAL_LAT', '') or os.environ.get('MM_LAT', '')).strip()
    local_lon = (os.environ.get('LOCAL_LON', '') or os.environ.get('MM_LON', '')).strip()
    if local_lat and local_lon:
        coords = _parse_coords(local_lat, local_lon, 'local node')
        if coords:
            return (coords, None, output_mode, 'gps')

    return (None, None, output_mode, 'gps')


# ---------------------------------------------------------------------------
# Weather fetch
# ---------------------------------------------------------------------------

def get_weather(lat: float, lon: float) -> Dict[str, Any]:
    """
    Fetch current conditions and 7-day daily forecast from Pirate Weather.

    Returns {'data': {...}} on success or {'error': '...'} on failure.
    """
    if not PIRATE_WEATHER_API_KEY:
        return {'error': 'PIRATE_WEATHER_API_KEY not set. Get a free key at pirateweather.net.'}

    try:
        url = f'https://api.pirateweather.net/forecast/{PIRATE_WEATHER_API_KEY}/{lat},{lon}'
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode('utf-8'))

        current       = data.get('currently') or {}
        daily_periods = (data.get('daily') or {}).get('data') or []
        today         = daily_periods[0] if daily_periods else {}

        temp       = current.get('temperature')
        feels_like = current.get('apparentTemperature')
        summary    = current.get('summary') or 'N/A'
        humidity   = current.get('humidity') or 0
        wind_speed = current.get('windSpeed') or 0
        high_temp  = today.get('temperatureHigh')
        low_temp   = today.get('temperatureLow')

        if temp is None or feels_like is None:
            return {'error': 'Pirate Weather returned incomplete data (missing temperature).'}

        # Timezone offset in seconds (offset field is a float, e.g. -5.0 or 5.5)
        tz_offset_sec = int((data.get('offset') or 0) * 3600)

        # Build 7-day forecast list from all available daily periods.
        # Use 8 entries so we always have a full 7-day lookahead regardless
        # of what day of the week today is (index 0 = today, so 8 covers today
        # plus 7 future days, and build_forecast_messages caps output at 7 days).
        forecast = []
        for day in daily_periods[:8]:
            day_time   = day.get('time')
            day_high   = day.get('temperatureHigh')
            day_low    = day.get('temperatureLow')
            day_sum    = day.get('summary') or 'N/A'
            day_precip = day.get('precipProbability') or 0

            if day_time is None or day_high is None or day_low is None:
                continue

            forecast.append({
                'time':        day_time,
                'summary':     day_sum,
                'high':        day_high,
                'low':         day_low,
                'precip_prob': day_precip,
            })

        return {'data': {
            'temp':          temp,
            'feels_like':    feels_like,
            'summary':       summary,
            'humidity':      humidity,
            'wind_speed':    wind_speed,
            'high_temp':     high_temp,
            'low_temp':      low_temp,
            'forecast':      forecast,
            'tz_offset_sec': tz_offset_sec,
        }}

    except urllib.error.HTTPError as e:
        return {'error': f'Weather API error: {e.code} {e.reason}'}
    except urllib.error.URLError as e:
        return {'error': f'Network error: {e.reason}'}
    except json.JSONDecodeError:
        return {'error': 'Invalid response from Pirate Weather API'}
    except Exception as e:
        # Sanitise exception message — strip API key if it appears
        err_msg = str(e).replace(PIRATE_WEATHER_API_KEY, '***') if PIRATE_WEATHER_API_KEY else str(e)
        return {'error': f'Unexpected error: {err_msg}'}


# ---------------------------------------------------------------------------
# Response formatters
# ---------------------------------------------------------------------------

def format_weather(label: str, d: dict) -> str:
    """
    Format current conditions as a single message string.

    Example:
      Weather for Peterborough, Ontario, Canada: Misty.
      Currently 40°F / 4°C (feels like 32°F / 0°C).
      Today: High 47°F / 8°C, Low 38°F / 3°C.
      Humidity: 96%, Wind: 9 mph.
    """
    msg = (
        f'Weather for {label}: {d["summary"]}. '
        f'Currently {fmt_temp(d["temp"])} (feels like {fmt_temp(d["feels_like"])}). '
    )
    if d['high_temp'] is not None and d['low_temp'] is not None:
        msg += f'Today: High {fmt_temp(d["high_temp"])}, Low {fmt_temp(d["low_temp"])}. '
    msg += f'Humidity: {d["humidity"]*100:.0f}%, Wind: {d["wind_speed"]:.0f} mph.'
    return msg


def format_weather_gps(lat: float, lon: float, d: dict) -> str:
    """
    Format current conditions in emoji style for GPS mode.

    Example:
      📍 Peterborough, CA
      🌡️ 40°F / 4°C (feels like 32°F / 0°C)
      📊 Forecast: Misty
      ↕️ High: 47°F / 8°C  Low: 38°F / 3°C
      💧 Humidity: 96%  💨 Wind: 9 mph
    """
    city = reverse_geocode_city(lat, lon)
    lines = [
        f'📍 {city}',
        f'🌡️ {fmt_temp(d["temp"])} (feels like {fmt_temp(d["feels_like"])})',
        f'📊 Forecast: {d["summary"]}',
    ]
    if d['high_temp'] is not None and d['low_temp'] is not None:
        lines.append(f'↕️ High: {fmt_temp(d["high_temp"])}  Low: {fmt_temp(d["low_temp"])}')
    lines.append(f'💧 Humidity: {d["humidity"]*100:.0f}%  💨 Wind: {d["wind_speed"]:.0f} mph')
    return '\n'.join(lines)


def build_forecast_messages(label: str, d: dict) -> List[str]:
    """
    Build the 7-day forecast as a list of messages, each within MSG_LIMIT bytes.

    The first message starts with a header line. Subsequent day lines are packed
    into messages greedily. If a day line starts a new message, that message
    begins directly with the day line (no repeated header).

    Returns a list of message strings (may be empty if no forecast data).
    """
    forecast = d.get('forecast', [])
    if not forecast:
        return []

    tz_offset = d.get('tz_offset_sec', 0)
    header    = f'7-Day Forecast - {label}:'

    # Build all day lines first — cap at 7 days regardless of how many
    # entries were returned (we fetch 8 to guarantee 7 future days exist)
    day_lines = []
    for day in forecast[:7]:
        try:
            local_ts = day['time'] + tz_offset
            day_name = DAY_NAMES[time.gmtime(local_ts).tm_wday]
        except Exception:
            day_name = '???'

        high   = day['high']
        low    = day['low']
        summ   = day['summary']
        precip = day['precip_prob']

        hi_str     = fmt_temp_compact(high)
        lo_str     = fmt_temp_compact(low)
        precip_str = f' 💧{precip*100:.0f}%' if precip else ''

        line = f'{day_name}: {summ}. Hi {hi_str} Lo {lo_str}{precip_str}'
        # Safety: if a single line exceeds MSG_LIMIT (e.g. very long API summary),
        # truncate it so MeshMonitor never silently drops characters.
        while len(line.encode('utf-8')) > MSG_LIMIT:
            line = line[:-1]
        day_lines.append(line)

    if not day_lines:
        return []

    # Pack day lines into messages greedily, respecting MSG_LIMIT bytes
    messages = []
    current  = header  # first message always starts with the header

    for line in day_lines:
        candidate = current + '\n' + line if current else line

        if len(candidate.encode('utf-8')) <= MSG_LIMIT:
            current = candidate
        else:
            # Current message is full — save it and start a new one
            if current:
                messages.append(current)
            # New message starts with just the day line (no repeated header)
            current = line

    # Don't forget the last message
    if current:
        messages.append(current)

    return messages


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def emit(messages: List[str]) -> None:
    """
    Print the correct MeshMonitor JSON output format and flush stdout.

    Single message  → {"response": "..."}
    Multiple messages → {"responses": ["msg1", "msg2", ...]}
    """
    if not messages:
        print(json.dumps({'response': 'No data to display.'}))
    elif len(messages) == 1:
        print(json.dumps({'response': messages[0]}))
    else:
        print(json.dumps({'responses': messages}))
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    try:
        coords, label, output_mode, input_mode = resolve_input()

        if TEST_MODE:
            trigger = os.environ.get('TRIGGER', '(none)')
            print(
                f'TRIGGER={trigger!r} | output_mode={output_mode} | '
                f'input_mode={input_mode} | coords={coords} | label={label}',
                file=sys.stderr
            )

        # Handle no-location / no-GPS case
        if coords is None:
            if input_mode == 'location' and label:
                emit([f'Could not find location: "{label}". '
                      'Try e.g. "weather peterborough,ontario,canada".'])
            else:
                emit([
                    'No location or GPS data available. '
                    'Options: (1) Send "weather city,province,country". '
                    '(2) Use CLI arg in Timed Event: "peterborough,ontario,canada". '
                    '(3) Ensure node has GPS (FROM_LAT/FROM_LON). '
                    '(4) Set LOCAL_LAT/LOCAL_LON in docker-compose.'
                ])
            return

        lat, lon = coords

        result = get_weather(lat, lon)
        if 'error' in result:
            emit([f'Error: {result["error"]}'])
            return

        d = result['data']

        if output_mode == 'forecast':
            # Use typed label or reverse-geocoded city name for GPS mode
            fc_label = label if label else reverse_geocode_city(lat, lon)
            messages = build_forecast_messages(fc_label, d)
            if not messages:
                emit(['No forecast data available.'])
            else:
                emit(messages)

                if TEST_MODE:
                    for i, msg in enumerate(messages, 1):
                        print(f'\n--- FORECAST MSG {i} ---\n{msg}', file=sys.stderr)
                    print('--- END TEST ---\n', file=sys.stderr)

        else:  # output_mode == 'weather'
            if input_mode == 'location':
                msg = format_weather(label, d)
            else:
                msg = format_weather_gps(lat, lon, d)

            emit([msg])

            if TEST_MODE:
                print(f'\n--- WEATHER MSG ---\n{msg}\n--- END TEST ---\n', file=sys.stderr)

    except Exception as e:
        emit([f'Error: {str(e)}'])
        if TEST_MODE:
            import traceback
            traceback.print_exc(file=sys.stderr)
        sys.exit(0)


if __name__ == '__main__':
    main()
