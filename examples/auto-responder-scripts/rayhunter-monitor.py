#!/usr/bin/env python3
"""
RayHunter Monitor - Timer Trigger script for MeshMonitor

Polls a RayHunter instance for the current analysis and reports
any warnings (Low/Medium/High severity events) found.

Configure as a MeshMonitor Timer Trigger with:
  - Script Path: /data/scripts/rayhunter-monitor.py
  - Script Args: --url http://192.168.1.1:8080 (optional, this is the default)
  - Channel: your desired broadcast channel
  - Cron: e.g. */5 * * * * (every 5 minutes)

Environment variables (optional):
  RAYHUNTER_URL - Base URL of the RayHunter instance (default: http://192.168.1.1:8080)
"""

import argparse
import json
import os
import sys
from urllib.request import urlopen, Request
from urllib.error import URLError

DEFAULT_URL = "http://192.168.1.1:8080"
SEVERITY_ORDER = {"Informational": 0, "Low": 1, "Medium": 2, "High": 3}
SEVERITY_EMOJI = {"Low": "⚠️", "Medium": "🟠", "High": "🔴"}


def fetch_json(url):
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def fetch_text(url):
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=10) as resp:
        return resp.read().decode()


def get_current_entry(base_url):
    manifest = fetch_json(f"{base_url}/api/qmdl-manifest")
    return manifest.get("current_entry")


def parse_analysis_report(ndjson_text):
    """Parse NDJSON analysis report. First line is metadata, rest are rows."""
    lines = [l.strip() for l in ndjson_text.strip().split("\n") if l.strip()]
    if not lines:
        return None, []

    metadata = json.loads(lines[0])
    rows = []
    for line in lines[1:]:
        row = json.loads(line)
        rows.append(row)
    return metadata, rows


def extract_warnings(rows):
    """Extract non-informational events from analysis rows."""
    warnings = []
    for row in rows:
        # Each row has a list of events (one per analyzer), most are null
        events = row.get("events", [])
        timestamp = row.get("packet_timestamp", "")
        for event in events:
            if event is None:
                continue
            event_type = event.get("event_type", "Informational")
            if event_type != "Informational":
                warnings.append({
                    "severity": event_type,
                    "message": event.get("message", "Unknown"),
                    "timestamp": timestamp,
                })
    return warnings


def format_response(warnings, entry_name):
    """Format warnings into a mesh broadcast message."""
    if not warnings:
        return None

    # Count by severity
    counts = {}
    for w in warnings:
        sev = w["severity"]
        counts[sev] = counts.get(sev, 0) + 1

    # Build summary header
    parts = []
    for sev in ("High", "Medium", "Low"):
        if sev in counts:
            emoji = SEVERITY_EMOJI.get(sev, "")
            parts.append(f"{emoji}{counts[sev]} {sev}")

    header = f"RayHunter Alert: {', '.join(parts)}"

    # Add highest-severity warning details (keep message short for mesh)
    worst = max(warnings, key=lambda w: SEVERITY_ORDER.get(w["severity"], 0))
    detail = worst["message"]
    # Truncate detail to keep within mesh message limits
    if len(detail) > 150:
        detail = detail[:147] + "..."

    return f"{header}\n{detail}"


def main():
    parser = argparse.ArgumentParser(description="RayHunter Monitor for MeshMonitor")
    parser.add_argument("--url", default=None, help="RayHunter base URL")
    parser.add_argument("--always-report", action="store_true",
                        help="Report even when no warnings found (for testing)")
    args = parser.parse_args()

    base_url = (args.url
                or os.environ.get("RAYHUNTER_URL")
                or DEFAULT_URL).rstrip("/")

    try:
        entry = get_current_entry(base_url)
        if not entry:
            if args.always_report:
                print(json.dumps({"response": "RayHunter: No active recording"}))
            sys.exit(0)

        entry_name = entry["name"]
        ndjson = fetch_text(f"{base_url}/api/analysis-report/{entry_name}")
        metadata, rows = parse_analysis_report(ndjson)

        if not rows:
            if args.always_report:
                print(json.dumps({"response": f"RayHunter: Recording {entry_name} active, no analysis rows yet"}))
            sys.exit(0)

        warnings = extract_warnings(rows)

        if warnings:
            message = format_response(warnings, entry_name)
            print(json.dumps({"response": message}))
        elif args.always_report:
            print(json.dumps({"response": f"RayHunter: {len(rows)} packets analyzed, no warnings"}))

    except URLError as e:
        print(json.dumps({"response": f"RayHunter: Cannot reach device ({e.reason})"}),
              file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"response": f"RayHunter: Error - {e}"}),
              file=sys.stderr)
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
