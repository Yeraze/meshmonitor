# TODOs

## In Progress

## Completed
- Implement mesh packet monitor feature (issue #285)
  - [x] Add packet_log database table and configuration settings
  - [x] Create PacketLogService for logging and cleanup
  - [x] Hook packet logging into processMeshPacket
  - [x] Create API routes for packet operations (/api/packets)
  - [x] Create frontend components (PacketMonitorPanel, PacketTable, etc.)
  - [x] Add packet monitor settings section to Settings tab
  - [x] Modify NodesTab to include packet monitor panel with split view
  - [x] Add responsive CSS to hide packet monitor on mobile
  - [x] Fix settings persistence bug (hasChanges tracking)
  - [x] Fix permission middleware (add optionalAuth() to packet routes)
  - [x] Fix settings save bug (add packet monitor settings to validKeys whitelist)
  - [x] Hide "Show Packet Monitor" checkbox when packet logging is disabled
  - [x] Make To/From node IDs clickable to select and center on nodes
  - [x] Test packet logging with encryption and permissions
- Fix update notification banner dismiss button overflow (issue #269)
- Implement reply button auto-focus feature (issue #280)
  - Added auto-focus to message input when clicking reply button
  - Added reply state clearing when switching channels or DM nodes
- Version 2.8.8
- Fix TRUST_PROXY environment variable to support all Express values (true/false/number/IP)
- Created GitHub release v2.8.8
- Version 2.8.9
- Reverted mobile node popup dimension changes from PR #279
- Created GitHub release v2.8.9
- Add paho-mqtt<2.0 dependency for Apprise MQTT support (issue #276, PR #287)
- Packet monitor enhancements (issue #285 continued)
  - [x] Fix packet detail modal background transparency (increased opacity and z-index)
  - [x] Move packet monitor to bottom of screen instead of right side
  - [x] Show telemetry type in Content column (Device, Environment, Power, etc.)
  - [x] Improve Position packet content to show coordinates in degrees
  - [x] Improve NodeInfo packet content to show node name
  - [x] Enhance modal popup styling (stronger shadow, larger border, higher z-index)
  - [x] Fix map tile loading issue when packet monitor is toggled (added MapResizeHandler)
  - [x] Add blue border and glow effect to packet detail modal for better visibility
  - [x] Fix packet detail modal dark mode colors to use --ctp-surface0 background
  - [x] Import full list of port numbers from official Meshtastic protobuf definitions
  - [x] Add color coding for 15+ packet types in PacketMonitorPanel
  - [x] Remove page footer (duplicate info in sidebar)
  - [x] Fix filter dropdown white background for dark mode readability
