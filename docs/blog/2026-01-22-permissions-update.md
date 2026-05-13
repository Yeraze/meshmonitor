---
id: news-2026-01-22-permissions-update
title: 'Important: User Permissions Changes'
date: '2026-01-22T18:00:00Z'
category: feature
priority: important
minVersion: 3.1.0
---
MeshMonitor v3.1.0 introduced an updated **User Permissions** system to provide more granular control over channel access.

## What's Changed

Channel permissions now use a **tri-state system** with three separate controls:

- **View Map** - Can see node positions on the map
- **Read** - Can read messages from the channel
- **Write** - Can send messages to the channel

This allows configurations like "map-only" access where users can see nodes but not read messages.

## Action Required

Administrators should review their permission settings:

1. Navigate to **Settings > Users** and review each user's permissions
2. Pay special attention to the **Anonymous** user - this controls what unauthenticated visitors can see
3. For each channel, verify the appropriate **View Map** and **Read** permissions are assigned

## Common Issue: Blank Maps

If users report seeing blank maps, this is likely a permissions issue. The **View Map** permission must be enabled for a channel for users to see nodes on the map.

See our [FAQ: Why is my map blank?](https://meshmonitor.org/faq#the-map-is-blank-for-anonymous-not-logged-in-users) for troubleshooting steps.

For complete documentation on the new permission system, see [Understanding Channel Permissions](https://meshmonitor.org/faq#understanding-channel-permissions).
