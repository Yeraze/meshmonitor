#!/usr/bin/env python3
# mm_meta:
#   name: Pirate Weather
#   emoji: 🏴‍☠️
#   language: Python
"""
Weather script for MeshMonitor auto-responder using Pirate Weather API.
Supports any location format using OpenStreetMap's free Nominatim geocoding service.

Requirements:
- Python 3.6+
- PIRATE_WEATHER_API_KEY environment variable (get free key from https://pirateweather.net/)

Setup:
1. Get API key from https://pirateweather.net/
2. Add to docker-compose.yaml environment variables:
   - PIRATE_WEATHER_API_KEY=your_api_key_here
3. Ensure volume mapping in docker-compose.yaml:
   - ./scripts:/data/scripts
4. Copy PirateWeather.py to your local ./scripts/ directory (if using volume mount, it will be available in container automatically)
5. Make executable: chmod +x scripts/PirateWeather.py
6. If NOT using volume mounts, copy to container: docker cp scripts/PirateWeather.py meshmonitor:/data/scripts/
7. Configure trigger in MeshMonitor web UI:
   - Navigate to Settings → Automation → Auto Responder
   - Click "Add Trigger" button
   - Trigger Pattern: weather, weather {location}
   - Response Type: Select "Script" from dropdown
   - Response: /data/scripts/PirateWeather.py (or select from script dropdown if available)
   - Click "Save Changes"

Usage:
- MeshMonitor auto-responder: weather (shows help) or weather {location} (gets weather)
- Local testing: TEST_MODE=true PARAM_location="City, State" PIRATE_WEATHER_API_KEY=your_key python3 PirateWeather.py

Examples:
- weather (shows help)
- weather "New York, NY"
- weather 90210
- weather "Paris, France"

Made with ❤️ for the MeshMonitor community.
"""

import os
import sys
import json
import time
import urllib.request
import urllib.parse
from typing import Optional, Tuple, Dict, Any

# Configuration
PIRATE_WEATHER_API_KEY = os.environ.get("PIRATE_WEATHER_API_KEY", "")

# Test mode flag - set to True for local testing
TEST_MODE = os.environ.get("TEST_MODE", "false").lower() == "true"


class WeatherBot:
    """Weather bot that fetches weather data using Pirate Weather API."""

    def __init__(self):
        self.api_key = PIRATE_WEATHER_API_KEY

    def geocode_location(self, location: str) -> Optional[Tuple[float, float]]:
        """
        Geocode a location using Nominatim (OpenStreetMap) geocoding service.
        This is a free service that doesn't require an API key.

        Args:
            location: Location string to geocode

        Returns:
            Tuple of (latitude, longitude) or None if geocoding fails
        """
        try:
            # Use OpenStreetMap's Nominatim geocoding service (free, no API key required)
            base_url = "https://nominatim.openstreetmap.org/search"
            params = {"q": location, "format": "json", "limit": 1}

            url = f"{base_url}?{urllib.parse.urlencode(params)}"

            # Add User-Agent header (required by Nominatim)
            headers = {"User-Agent": "MeshMonitor-WeatherBot/1.0"}

            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))

            if data and len(data) > 0:
                result = data[0]
                lat = float(result.get("lat"))
                lng = float(result.get("lon"))
                return (lat, lng)

        except urllib.error.HTTPError as e:
            if e.code == 429:  # Rate limited
                print(f"Geocoding rate limited for {location}, retrying in 1 second...", file=sys.stderr)
                time.sleep(1)
                return self.geocode_location(location)  # Retry once
            print(f"Geocoding HTTP error for {location}: {e.code}", file=sys.stderr)
        except Exception as e:
            # Log geocoding errors but don't fail completely
            print(f"Geocoding error for {location}: {str(e)}", file=sys.stderr)

        return None

    def get_coordinates(self, location: str) -> Optional[Tuple[float, float]]:
        """
        Get latitude and longitude for a location using Nominatim geocoding.
        Supports any location format - relies entirely on OpenStreetMap's free geocoding service.

        Args:
            location: Any location string (city, zip, address, etc.)

        Returns:
            Tuple of (latitude, longitude) or None if geocoding fails
        """
        location = location.strip()

        if not location:
            return None

        # Try geocoding the location directly
        # Nominatim can handle various formats: city, city state, zip codes, addresses, etc.
        coords = self.geocode_location(location)
        if coords:
            return coords

        return None

    def get_weather(self, location: str) -> Dict[str, Any]:
        """
        Get weather information for a location.

        Args:
            location: Location string

        Returns:
            Dictionary with weather data or error message
        """
        try:
            coords = self.get_coordinates(location)
            if not coords:
                return {
                    "error": f"Could not find coordinates for location: {location}. "
                    'Try using a 5-digit zip code or "City, State" format.'
                }

            lat, lng = coords

            if not self.api_key:
                return {
                    "error": "Pirate Weather API key not configured. "
                    "Please set PIRATE_WEATHER_API_KEY environment variable."
                }

            # Build API URL
            url = f"https://api.pirateweather.net/forecast/{self.api_key}/{lat},{lng}"

            # Make API request
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))

            # Extract current weather
            current = data.get("currently", {})
            daily = data.get("daily", {}).get("data", [{}])[0] if data.get("daily", {}).get("data") else {}

            # Format response
            temp = current.get("temperature", "N/A")
            feels_like = current.get("apparentTemperature", "N/A")
            summary = current.get("summary", "N/A")
            humidity = current.get("humidity", 0)
            wind_speed = current.get("windSpeed", 0)
            high_temp = daily.get("temperatureHigh", "N/A")
            low_temp = daily.get("temperatureLow", "N/A")

            response_text = (
                f"Weather for {location.title()}: {summary}. "
                f"Currently {temp:.0f}°F (feels like {feels_like:.0f}°F). "
                f"Today: High {high_temp:.0f}°F, Low {low_temp:.0f}°F. "
                f"Humidity: {humidity * 100:.0f}%, Wind: {wind_speed:.0f} mph."
            )

            return {"response": response_text}

        except urllib.error.HTTPError as e:
            return {"error": f"Weather API error: {e.code} {e.reason}"}
        except urllib.error.URLError as e:
            return {"error": f"Network error: {e.reason}"}
        except json.JSONDecodeError:
            return {"error": "Invalid response from weather API"}
        except Exception as e:
            return {"error": f"Unexpected error: {str(e)}"}

    def get_help(self) -> str:
        """Return help text for the weather bot."""
        return (
            "Weather Bot:\n"
            "• weather help - Show help\n"
            "• weather {location} - Get weather\n"
            "Examples:\n"
            "• weather 90210\n"
            '• weather "New York, NY"\n'
            "• weather Paris, France\n"
            "See script for more details."
        )


def main():
    """Main function to handle weather requests."""
    try:
        # Get location parameter from environment (set by MeshMonitor)
        location = os.environ.get("PARAM_location", "").strip()

        # If parameter is empty or seems incomplete, extract from MESSAGE using TRIGGER pattern
        # This handles cases where MeshMonitor doesn't extract multi-word parameters correctly
        if not location or (len(location) < 2 and " " in os.environ.get("MESSAGE", "")):
            original_message = os.environ.get("MESSAGE", "").strip()
            trigger_pattern = os.environ.get("TRIGGER", "").strip()

            if original_message and trigger_pattern:
                import re

                # Find {param} in trigger pattern (e.g., "weather {location}")
                param_match = re.search(r"\{(\w+)\}", trigger_pattern)
                if param_match:
                    # Get the trigger prefix (e.g., "weather " from "weather {location}")
                    trigger_prefix = trigger_pattern.split("{")[0].strip()
                    if original_message.lower().startswith(trigger_prefix.lower()):
                        # Extract everything after the trigger prefix
                        location = original_message[len(trigger_prefix) :].strip()
                        # Remove quotes if present
                        if location.startswith('"') and location.endswith('"'):
                            location = location[1:-1]
                        elif location.startswith("'") and location.endswith("'"):
                            location = location[1:-1]

        bot = WeatherBot()

        if not location:
            # No location provided - show help (triggered by "weather" pattern)
            response = bot.get_help()
        else:
            # Get weather for location
            result = bot.get_weather(location)
            if "error" in result:
                # Invalid location - provide helpful error with usage info
                error_msg = result["error"]
                response = f'Error: {error_msg}\nUsage: weather {{location}}\nExamples: weather 90210, weather "NYC"'
            else:
                response = result["response"]

        # Ensure we always have a response
        if not response:
            response = "Error: No response generated"

        # Output JSON response for MeshMonitor
        try:
            output = {"response": response}
            print(json.dumps(output))
            sys.stdout.flush()

            if TEST_MODE:
                print(f"\n--- TEST MODE OUTPUT ---\n{response}\n--- END TEST ---\n", file=sys.stderr)
        except Exception as output_error:
            try:
                error_output = {"response": f"Error: Failed to format response: {str(output_error)}"}
                print(json.dumps(error_output))
                sys.stdout.flush()
            except:
                print('{"response": "Error: Script execution failed"}')
                sys.stdout.flush()

    except Exception as e:
        # Handle any unexpected errors - ensure we always output something
        try:
            error_msg = f"Error: {str(e)}"
            if len(error_msg) > 195:
                error_msg = error_msg[:192] + "..."
            output = {"response": error_msg}
            print(json.dumps(output))
            sys.stdout.flush()

            if TEST_MODE:
                print(f"\n--- TEST MODE ERROR ---\n{error_msg}\n--- END TEST ---\n", file=sys.stderr)

            print(f"Error in weather script: {str(e)}", file=sys.stderr)
        except:
            print('{"response": "Error: Script execution failed"}')
            sys.stdout.flush()
        finally:
            sys.exit(0)


if __name__ == "__main__":
    main()
