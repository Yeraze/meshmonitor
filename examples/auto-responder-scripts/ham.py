#!/usr/bin/env python3
# mm_meta:
#   name: Ham Conditions
#   emoji: 📻
#   language: Python
"""
Ham Conditions — HF band conditions for mesh network auto-responders.

Returns current Ham Radio band conditions for day and night propagation,
plus solar flux, K-index, and A-index. Data is pulled from the HamQSL solar
XML feed (https://www.hamqsl.com/solarxml.php) — no API key required.

Example trigger: !ham

Output example:
  Flux:142 KI:2 AI:7
  Day:
    80m-40m: 🟢Good
    30m-20m: 🟢Good
    17m-15m: 🟡Fair
    12m-10m: 🔴Poor
  Night:
    80m-40m: 🟡Fair
    30m-20m: 🟢Good
    17m-15m: 🔴Poor
    12m-10m: 🔴Poor

Output format: { "response": "..." }  (or { "error": "..." } on failure)

Submitted by: itxpress (issue #3584)
"""

import json
import urllib.request
import xml.etree.ElementTree as ET


def get_ham_data():
    # Fetch data from HamQSL solar XML feed
    url = "https://www.hamqsl.com/solarxml.php"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

    try:
        http_response = urllib.request.urlopen(req)
        xml_data = http_response.read()
        root = ET.fromstring(xml_data)

        # Extract desired elements
        solar_data = {}
        solardata_elem = root.find('solardata')
        if solardata_elem is not None:
            for child in solardata_elem:
                if child.tag != 'calculatedconditions':
                    solar_data[child.tag] = child.text

            # Extract calculated conditions for band openings
            day_conditions = []
            night_conditions = []
            calc_conds = solardata_elem.find('calculatedconditions')
            if calc_conds is not None:
                for band in calc_conds.findall('band'):
                    # Map text status to colored emoji dots
                    cond_lower = band.text.lower() if band.text else ""
                    if "good" in cond_lower:
                        dot = "🟢"
                    elif "fair" in cond_lower:
                        dot = "🟡"
                    elif "poor" in cond_lower:
                        dot = "🔴"
                    else:
                        dot = "⚪"  # Unknown status fallback

                    band_name = band.get('name', 'Unknown')
                    condition_str = f"  {band_name:<7}: {dot}{band.text}"

                    time = band.get('time', 'N/A')
                    if "day" in time:
                        day_conditions.append(condition_str)
                    else:
                        night_conditions.append(condition_str)

            flux = solar_data.get('solarflux', 'N/A')
            kindex = solar_data.get('kindex', 'N/A')
            aindex = solar_data.get('aindex', 'N/A')

            reply = (
                f"Flux:{flux} KI:{kindex} AI:{aindex}\n"
                + "Day:\n" + "\n".join(day_conditions)
                + "\nNight:\n" + "\n".join(night_conditions)
            )

            print(json.dumps({"response": reply}))

    except Exception as e:
        print(json.dumps({"error": str(e)}, indent=4))


if __name__ == "__main__":
    get_ham_data()
