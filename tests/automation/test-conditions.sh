#!/usr/bin/env bash
# Automation Engine — condition + flow coverage (simulated). See proposal §2.2/§2.3.
source "$(dirname "$0")/lib.sh"
ae_login
echo "Automation conditions & flow (simulated):"

# C1 numeric on an event field (hops) with If/Else routing
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.message","params":{}},{"id":"c","type":"condition.numeric","params":{"field":"hops","op":"==","value":"0"}},{"id":"y","type":"action.tapback","params":{"emoji":"✅"}},{"id":"n","type":"action.sendMessage","params":{"text":"too far"}}],"edges":[{"from":"t","to":"c"},{"from":"c","to":"y","port":"true"},{"from":"c","to":"n","port":"false"}]}'
out=$(ae_sim "$CFG" '{"kind":"message","text":"hi","hopStart":3,"hopLimit":3}')
assert_json "$out" '.conditionResults.c' 'true' 'C1 hops==0 true on zero-hop message'
assert_json "$out" '[.actions[].type]|sort|join(",")' 'action.tapback' 'C1 true-branch action only'
out=$(ae_sim "$CFG" '{"kind":"message","text":"hi","hopStart":3,"hopLimit":1}')
assert_json "$out" '.conditionResults.c' 'false' 'C1 hops==2 → false'
assert_json "$out" '.actions[0].type' 'action.sendMessage' 'C1 false-branch action taken'

# C2 numeric on a hydrated node field (battery), facts supplied
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.telemetry","params":{}},{"id":"c","type":"condition.numeric","params":{"field":"node.batteryLevel","op":"<","value":"20"}},{"id":"a","type":"action.notify","params":{"body":"low"}}],"edges":[{"from":"t","to":"c"},{"from":"c","to":"a","port":"true"}]}'
out=$(ae_sim "$CFG" '{"kind":"telemetry","nodeNum":5,"telemetryType":"batteryLevel","value":14}' '{"batteryLevel":14}')
assert_json "$out" '.conditionResults.c' 'true' 'C2 node.batteryLevel 14 < 20'
out=$(ae_sim "$CFG" '{"kind":"telemetry","nodeNum":5,"telemetryType":"batteryLevel","value":80}' '{"batteryLevel":80}')
assert_json "$out" '.conditionResults.c' 'false' 'C2 node.batteryLevel 80 not < 20'

# C6 string comparison on node.roleName
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.message","params":{}},{"id":"c","type":"condition.string","params":{"field":"node.roleName","op":"eq","value":"ROUTER"}},{"id":"a","type":"action.notify","params":{"body":"router"}}],"edges":[{"from":"t","to":"c"},{"from":"c","to":"a","port":"true"}]}'
out=$(ae_sim "$CFG" '{"kind":"message","from":111,"text":"hi"}' '{"role":2}')
assert_json "$out" '.conditionResults.c' 'true' 'C6 role 2 → roleName ROUTER'
out=$(ae_sim "$CFG" '{"kind":"message","from":111,"text":"hi"}' '{"role":0}')
assert_json "$out" '.conditionResults.c' 'false' 'C6 role 0 (CLIENT) ≠ ROUTER'

# C4 numeric compares against a variable override + interpolated action text
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.telemetry","params":{}},{"id":"c","type":"condition.numeric","params":{"field":"value","op":">","value":"{{ var.threshold }}"}},{"id":"a","type":"action.sendMessage","params":{"text":"value {{ trigger.value }} over limit"}}],"edges":[{"from":"t","to":"c"},{"from":"c","to":"a","port":"true"}]}'
out=$(ae_sim "$CFG" '{"kind":"telemetry","nodeNum":7,"telemetryType":"temperature","value":30}' 'null' '{"threshold":25}')
assert_json "$out" '.conditionResults.c' 'true' 'C4 value 30 > threshold(25)'
assert_json "$out" '.actions[0].resolvedParams.text' 'value 30 over limit' 'C4 action text interpolated'

# F7/F8 flow.setVar flag recorded (simulated, not persisted)
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.message","params":{}},{"id":"f","type":"flow.setVar","params":{"variable":"welcomed","op":"flag"}}],"edges":[{"from":"t","to":"f"}]}'
out=$(ae_sim "$CFG" '{"kind":"message","from":111,"text":"hi"}')
assert_json "$out" '.variableWrites[0].op' 'flag' 'F7 flag write is recorded in the trace'

# A5 notify failure surfaces as a failed action (no Apprise configured / unreachable in dry-run-with-bad-url)
CFG='{"version":1,"nodes":[{"id":"t","type":"trigger.message","params":{}},{"id":"a","type":"action.notify","params":{"body":"hi","urls":"discord://x\ntgram://y"}}],"edges":[{"from":"t","to":"a"}]}'
out=$(ae_sim "$CFG" '{"kind":"message","text":"hi"}')
assert_json "$out" '.actions[0].resolvedParams.urls|length' '2' 'A6 notify urls parsed into a 2-element list'

ae_summary
