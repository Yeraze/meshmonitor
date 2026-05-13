---
id: news-2026-01-28-geofence-triggers
title: 'New Feature: Geofence Triggers'
date: '2026-01-28T18:00:00Z'
category: feature
priority: important
minVersion: 3.4.0
---
MeshMonitor v3.4.0 introduces **Geofence Triggers** - a powerful new automation feature that lets you trigger actions when nodes enter, exit, or remain inside geographic areas.

## What Are Geofence Triggers?

Geofence Triggers monitor node positions and automatically execute responses when location conditions are met. Define circular or polygon-shaped zones on an interactive map, and MeshMonitor will watch for nodes crossing those boundaries.

## Key Features

- **Flexible Zone Shapes**: Draw circles (specify center and radius) or polygons (custom boundaries) directly on the map
- **Three Event Types**: Trigger on entry, exit, or periodically while a node remains inside
- **Node Filtering**: Monitor all nodes or select specific ones
- **Dynamic Responses**: Send text messages with tokens like `{LONG_NAME}`, `{GEOFENCE_NAME}`, `{DISTANCE_TO_CENTER}`, or execute custom scripts
- **Routing Options**: Send alerts to a channel or as direct messages to the triggering node

## Use Cases

- Arrival/departure notifications for family or team members
- Asset tracking and delivery confirmation
- Proximity alerts for restricted or hazardous areas
- Ongoing presence monitoring in work zones

[Read more about Geofence Triggers](https://meshmonitor.org/features/automation#geofence-triggers)
