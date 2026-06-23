---
name: reference-lora-tx-power-clamping
description: LoRa config.lora.tx_power proto type, firmware clamping behavior, valid range, and negative-value handling
metadata:
  type: reference
---

`Config.LoRaConfig.tx_power` = `int32` field 10 in `meshtastic/config.proto`. Units dBm. `0` = sentinel "use default max legal power". int32 is signed so negatives are representable on the wire, but they are NOT a supported/meaningful Meshtastic setting.

Firmware (`src/mesh/RadioInterface.cpp`):
- Internal `power` var is `int8_t` (signed, -128..127), declared in `RadioInterface.h`.
- `applyModemConfig()`: `if (power == 0 || (power > region powerLimit && !is_licensed)) power = region powerLimit; if (power == 0) power = 17;`
- `limitPower(int8_t loraMaxPower)`: clamps only on UPPER bound (`> maxPower`, `> loraMaxPower`). **NO lower-bound clamp exists.**
- A negative tx_power is NOT caught by `== 0`, survives every `>` check, and passes straight into per-radio `setOutputPower()` (e.g. SX126xInterface.cpp calls `limitPower(SX126X_MAX_POWER=22)` then `lora.setOutputPower(power)`). RadioLib (not Meshtastic) decides behavior for out-of-range values.

Enforced range: 0 = use max legal; upper = min(region powerLimit, radio hardware max), bypassed only for is_licensed nodes (still hardware-capped). Region caps via RDEF macros: US 30, EU_868 27, JP 13, UA_433 10 dBm. Hardware: SX126X_MAX_POWER=22.

UI guidance: restrict input to non-negative (0..radio/region max). Do NOT allow negative tx_power — allowed by proto type but undefined firmware behavior, not a controlled low-power mode.
