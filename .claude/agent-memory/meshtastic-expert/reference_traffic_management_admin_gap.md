---
name: traffic-management-admin-gap
description: traffic_management module config (proto field 15) present in v2.7.25 protobufs but NO admin set-handler case in any released firmware through 2.7.25; statusmessage (field 14) handler first shipped in 2.7.20
metadata:
  type: reference
---

`ModuleConfig.traffic_management = 15` and `ModuleConfig.statusmessage = 14` (oneof payload_variant). Generated tags: `meshtastic_ModuleConfig_traffic_management_tag 15`, `meshtastic_ModuleConfig_statusmessage_tag 14`. NOTE the firmware C identifier is `statusmessage` (no underscore), not `status_message`.

VERIFIED at firmware tags (commits): v2.7.18.fb3bf78, v2.7.19.bb3d6d5, v2.7.20.6658ec2, v2.7.22.96dd647, v2.7.23.b246bcd, v2.7.24.472b14c, v2.7.25.104df5f. Releases tagged `vMAJOR.MINOR.PATCH.<shorthash>`, NOT bare `v2.7.25`. Default branch is `develop`.

== AdminModule::handleSetModuleConfig structure (src/modules/AdminModule.cpp) ==
- `bool shouldReboot = true;` is the FIRST line.
- NO early-return guard for unknown variants. switch(c.which_payload_variant) has NO `default:` case.
- An UNMATCHED variant falls past the switch and STILL reaches `saveChanges(SEGMENT_MODULECONFIG, shouldReboot)` at the end with shouldReboot==true.
- `saveChanges(saveWhat, shouldReboot)`: calls service->reloadConfig(saveWhat); if `shouldReboot && !hasOpenEditTransaction` -> `reboot(DEFAULT_REBOOT_SECONDS)` which sets `rebootAtMsec`.
- IMPLICATION: a stock 2.7.25 node receiving set_module_config(traffic_management) does NOT persist (has_traffic_management/assignment never executed) BUT DOES still schedule a reboot (shouldReboot stays true). So "no persist" is reliable; "no reboot" is NOT what the source predicts -> if a user reports no reboot, the variant likely never reached handleSetModuleConfig (encoder using stale proto where field 15 isn't traffic_management, or admin passkey/channel rejection upstream in handleAdminMessage), or the empty/zeroed decode hit a different path.

== statusmessage (field 14) set-handler release history ==
- 2.7.18: NO case.  2.7.19: NO case.  2.7.20: YES (FIRST release with the case). 2.7.22/23/24/25: YES.
- The case sets has_statusmessage=true, assigns config, and `shouldReboot = false` (so status-message set intentionally does NOT reboot). Also excluded from the early disableBluetooth() IS_ONE_OF list (alongside mqtt/serial).
- => MeshMonitor's >=2.7.19 threshold for StatusMessage is WRONG by one; correct minimum is >=2.7.20.

== traffic_management (field 15) set-handler ==
- Absent (no case, no default) in ALL tags through 2.7.25 (RE-VERIFIED 2026-06-16 by content, not just ancestry).
- Added on `develop` via PR #9358 "Traffic Management Module for packet forwarding logic", merged 2026-03-11T11:12 UTC, merge commit 016e68ec53fca8a9074fa8abf20210e379a0db6b, base=develop head=traffic_module. PR also adds src/modules/TrafficManagementModule.{cpp,h}. On develop the case: has_traffic_management=true; assign.
- RE-VERIFIED 2026-06-16: `git merge-base --is-ancestor 016e68ec... <tag>` is FALSE for v2.7.20/21/22/23/24/25. AND content check: `git grep -i traffic_management <tag> -- src/modules/AdminModule.cpp` returns 0 hits and `src/modules/TrafficManagementModule.cpp` does NOT exist at any of these tags. The handleSetModuleConfig switch (line ~923 at 2.7.25) ENDS at the statusmessage case — no traffic_management case after it.
- RELEASE LANDSCAPE (gh release list + git ls-remote, 2026-06-16): NO v2.7.26.*, NO v2.8.*, NO *.alpha/*.beta/rc tags exist anywhere. Highest tag = v2.7.25.104df5f (PRERELEASE, published 2026-06-10). Latest FULL release flagged isLatest = v2.7.15.567b8ea (2025-11-19). The whole 2.7.16+ line is GitHub-prerelease.
- => The maintainer's belief that Traffic Management shipped in a pre-release is INCORRECT as of 2026-06-16. It is develop-only. supportsTrafficManagement() should return false for ALL existing firmware; do NOT gate it to any 2.7.x. Earliest shipping version is unknown until a post-2.7.25 tag is cut from a develop snapshot that includes PR #9358.
- CAUTION re v2.7.20: it was published 2026-03-11T11:43 UTC, only 31 min AFTER PR#9358 merged at 11:12 — tempting to assume inclusion, but verified it does NOT include TM (release line forked before, or feature not on that snapshot). 2.7.20 is the statusmessage debut, NOT traffic_management.

PRACTICAL: client sending set_module_config(traffic_management) to stock 2.7.25 is ACKed at transport level, no persist, but firmware would still schedule a reboot. statusmessage works on >=2.7.20.
