#!/usr/bin/env python3
# mm_meta:
#   name: Distance Calculator
#   emoji: 📏
#   language: Python
"""
Distance Calculator Script - Uses location environment variables.

This script demonstrates how to use the FROM_LAT/FROM_LON and MM_LAT/MM_LON
environment variables to calculate the distance between the sender and the
MeshMonitor node.

Requirements:
- Python 3.6+
- No external dependencies

Setup:
1. Copy this script to your scripts directory
2. Configure trigger in MeshMonitor UI:
   - Trigger Pattern: distance, dist
   - Response Type: Script
   - Response: /data/scripts/distance.py

Usage:
- distance - Calculates distance from sender to MeshMonitor node
- dist - Alias for distance

Environment Variables Used:
- FROM_LAT, FROM_LON: Sender's location
- MM_LAT, MM_LON: MeshMonitor node location
- FROM_NODE: Sender's node number (for display)
"""

import os
import json
import math
from typing import Optional, Tuple


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great-circle distance between two points on Earth.

    Args:
        lat1, lon1: First point (latitude, longitude in degrees)
        lat2, lon2: Second point (latitude, longitude in degrees)

    Returns:
        Distance in kilometers
    """
    R = 6371  # Earth's radius in km

    # Convert to radians
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    # Haversine formula
    a = math.sin(dlat / 2) ** 2 + \
        math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))

    return R * c


def km_to_miles(km: float) -> float:
    """Convert kilometers to miles."""
    return km * 0.621371


def get_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the bearing from point 1 to point 2.

    Args:
        lat1, lon1: Starting point (latitude, longitude in degrees)
        lat2, lon2: Ending point (latitude, longitude in degrees)

    Returns:
        Bearing in degrees (0-360)
    """
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    dlon = math.radians(lon2 - lon1)

    x = math.sin(dlon) * math.cos(lat2_rad)
    y = math.cos(lat1_rad) * math.sin(lat2_rad) - \
        math.sin(lat1_rad) * math.cos(lat2_rad) * math.cos(dlon)

    bearing = math.degrees(math.atan2(x, y))
    return (bearing + 360) % 360


def bearing_to_direction(bearing: float) -> str:
    """Convert bearing to compass direction."""
    directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    index = round(bearing / 45) % 8
    return directions[index]


def get_location(lat_var: str, lon_var: str) -> Optional[Tuple[float, float]]:
    """Get location from environment variables."""
    lat = os.environ.get(lat_var)
    lon = os.environ.get(lon_var)

    if lat and lon:
        try:
            return (float(lat), float(lon))
        except ValueError:
            return None
    return None


def main():
    """Main function to calculate and report distance."""
    try:
        # Get locations from environment
        from_loc = get_location("FROM_LAT", "FROM_LON")
        mm_loc = get_location("MM_LAT", "MM_LON")
        from_node = os.environ.get("FROM_NODE", "?")
        short_name = "!{}".format("{0:04x}".format(int(from_node))[4:])

        # Check if both locations are available
        if not from_loc:
            output = {
                "response": f"Hi {short_name}, your location is not available. "
                           "Send a position update first."
            }
            print(json.dumps(output))
            return

        if not mm_loc:
            output = {
                "response": f"Hi {short_name}, MeshMonitor location not set. "
                           "The node needs a GPS fix or manual position."
            }
            print(json.dumps(output))
            return

        # Calculate distance
        dist_km = haversine(from_loc[0], from_loc[1], mm_loc[0], mm_loc[1])
        dist_mi = km_to_miles(dist_km)

        # Calculate bearing (from sender to MM)
        bearing = get_bearing(from_loc[0], from_loc[1], mm_loc[0], mm_loc[1])
        direction = bearing_to_direction(bearing)

        # Format response based on distance
        if dist_km < 1:
            # Less than 1 km - show in meters
            dist_m = dist_km * 1000
            response = f"Hi {short_name}, distance: {dist_m:.0f}m ({direction})"
        elif dist_km < 10:
            # Less than 10 km - show one decimal
            response = f"Hi {short_name}, distance: {dist_km:.1f}km / {dist_mi:.1f}mi ({direction})"
        else:
            # Larger distances - show whole numbers
            response = f"Hi {short_name}, distance: {dist_km:.0f}km / {dist_mi:.0f}mi ({direction})"

        output = {"response": response}
        print(json.dumps(output))

    except Exception as e:
        error_msg = f"Error calculating distance: {str(e)}"
        if len(error_msg) > 195:
            error_msg = error_msg[:192] + "..."
        output = {"response": error_msg}
        print(json.dumps(output))
        print(f"Script error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
