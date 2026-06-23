#!/usr/bin/env bash
# Automation Engine — trigger coverage (simulated, no hardware). See proposal §2.1.
source "$(dirname "$0")/lib.sh"
ae_login
echo "Automation triggers (simulated):"

# T1 message textContains match / no-match
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.message","params":{"textContains":"ping"}},{"id":"a","type":"action.tapback","params":{"emoji":"👍"}}],"edges":[{"from":"t","to":"a"}]}'
out=$(ae_sim "$CFG" '{"kind":"message","text":"ping me","packetId":42}')
assert_json "$out" '.matched' 'true' 'T1 message contains "ping" → matches'
assert_json "$out" '.actions[0].type' 'action.tapback' 'T1 tapback action runs'
assert_json "$out" '.actions[0].resolvedParams.replyId' '42' 'T1 tapback replies to trigger packet'
out=$(ae_sim "$CFG" '{"kind":"message","text":"hello"}')
assert_json "$out" '.matched' 'false' 'T1 non-matching text → filtered'
assert_json "$out" '.status' 'skipped' 'T1 non-match → skipped'

# T7/T8 telemetry metric filter
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.telemetry","params":{"telemetryType":"batteryLevel"}},{"id":"a","type":"action.notify","params":{"body":"x"}}],"edges":[{"from":"t","to":"a"}]}'
out=$(ae_sim "$CFG" '{"kind":"telemetry","nodeNum":5,"telemetryType":"batteryLevel","value":10}')
assert_json "$out" '.matched' 'true' 'T7 telemetry metric matches filter'
out=$(ae_sim "$CFG" '{"kind":"telemetry","nodeNum":5,"telemetryType":"voltage","value":3}')
assert_json "$out" '.matched' 'false' 'T7 wrong metric → filtered'

# T10/T12 system event prefilter + upgrade-available fields
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.system","params":{"event":"upgrade-available"}},{"id":"a","type":"action.notify","params":{"body":"{{ trigger.latestVersion }}"}}],"edges":[{"from":"t","to":"a"}]}'
out=$(ae_sim "$CFG" '{"kind":"system","event":"upgrade-available","latestVersion":"9.9.9","currentVersion":"1.0.0"}')
assert_json "$out" '.matched' 'true' 'T12 upgrade-available matches'
assert_json "$out" '.actions[0].resolvedParams.body' '9.9.9' 'T12 latestVersion interpolated into notify'
out=$(ae_sim "$CFG" '{"kind":"system","event":"bootup"}')
assert_json "$out" '.matched' 'false' 'T10 bootup does NOT fire an upgrade-available rule (prefilter)'

# T13 geofence inside/outside via supplied position
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.geofence","params":{"event":"enter","lat":0,"lon":0,"radiusKm":5}},{"id":"c","type":"condition.distance","params":{"op":"<","km":5,"lat":0,"lon":0}},{"id":"a","type":"action.notify","params":{"body":"in"}}],"edges":[{"from":"t","to":"c"},{"from":"c","to":"a","port":"true"}]}'
out=$(ae_sim "$CFG" '{"kind":"geofence","nodeNum":7}' '{"latitude":0.01,"longitude":0}')
assert_json "$out" '.conditionResults.c' 'true' 'T13 node ~1.1km from center is within 5km'
out=$(ae_sim "$CFG" '{"kind":"geofence","nodeNum":7}' '{"latitude":1,"longitude":0}')
assert_json "$out" '.conditionResults.c' 'false' 'T13 node ~111km from center is NOT within 5km'

ae_summary
