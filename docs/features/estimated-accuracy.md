# Estimated Accuracy

When MeshMonitor draws a node at an **estimated** position, it also draws a
dashed **accuracy circle** around it. This page explains exactly how that circle
— the node's `uncertaintyKm` — is computed, so you can read it with confidence
and know when to trust an estimate.

::: tip In one sentence
The estimate is an **SNR- and time-weighted centroid** of every anchor that
heard the node; the circle radius is the **weighted spread of those anchors,
shrunk by how many *effective* observations you really have**. One anchor → a
big "somewhere within radio range" circle; many converging anchors → a small,
confident circle.
:::

For *what* position estimation is, how to turn it on, and the settings that
control it, see [Position Estimation](/features/position-estimation). This page
is the deep-dive on the accuracy math.

## The pipeline at a glance

```
 traceroutes ┐                 ┌─ weight each observation ─┐
             │   observations  │   w = time-decay × SNR     │   weighted
 neighbor ───┼──▶ (anchor pos, ├──────────────────────────▶├─▶ centroid  ─▶ (lat, lon)
   info     ┘     SNR, time)   │                            │      │
                               └────────────────────────────┘      ▼
                                                            uncertainty radius
                                                          (spread ÷ √effective-N,
                                                           blended w/ radio range)
```

Every estimate is a pure function of a node's **observations**. An observation
is "an *anchor* (a node whose position we already know) heard this node, at this
SNR, at this time." Two data sources produce them:

| Source | Observation it creates | SNR used |
| --- | --- | --- |
| **Traceroute** | each `A → X → B` hop anchors the middle node `X` toward its positioned path-neighbors | per-hop SNR (raw ÷ 4 → dB) |
| **NeighborInfo** | a direct-RF pair anchors the unpositioned side to the positioned side | link SNR (already dB) |

## Step 1 — Weight each observation

Every observation gets a single scalar weight, the product of two independent
factors:

```
weight = time_decay × snr_weight
```

### SNR weight — stronger signal pulls harder

SNR is converted to **linear signal power**:

```
snr_weight = 10 ^ (SNR_dB / 10)
```

This is the physically correct mapping: a higher (less-negative) SNR means the
anchor is more likely to be *near* the node, so it should pull the estimate
toward itself **harder**. Weak signals barely move the estimate.

```
 SNR (dB)   snr_weight = 10^(SNR/10)     relative pull
 ───────    ───────────────────────     ─────────────────────────
  +15            31.6                    ████████████████████████  very strong
  +10            10.0                    ████████████              strong
   +5             3.16                   ████                      good
    0             1.0                    █                         reference
   −6             0.251                  ▏                         weak
  −12             0.063                  ·                         very weak (poor link)
  −20             0.01                   ·                         near noise floor
```

::: warning A −12 dB anchor barely counts
At −12 dB an anchor carries **~0.06** of the weight of a 0 dB anchor and
**~1/160th** of a +10 dB anchor. That asymmetry is the heart of the accuracy
math below — and the reason a single weak anchor must never produce a confident
estimate.
:::

### Time-decay weight — newer observations count more

Observations lose **half their weight every 24 hours**:

```
time_decay = 0.5 ^ (age_hours / 24)     (exponential, half-life = 24h)
```

```
 age        time_decay
 ────       ──────────
 now        1.00
 12 h       0.71
 24 h       0.50
 48 h       0.25
 72 h       0.125
 7 days     0.008
```

So a fresh −6 dB report can outweigh a three-day-old +0 dB report. The
[lookback window](/features/position-estimation#configuring-estimation) sets how
far back observations are even considered.

## Step 2 — Weighted centroid (the position)

The estimated location is the weight-weighted average of all anchor positions:

```
        Σ (wᵢ · latᵢ)              Σ (wᵢ · lonᵢ)
 lat =  ─────────────       lon =  ─────────────
            Σ wᵢ                       Σ wᵢ
```

For the simplest case — a single traceroute segment with two anchors — this
reduces **exactly** to the classic SNR-weighted midpoint. With many anchors
heard from many directions, the centroid converges on the node's true location:

```
   Anchor B (SNR +8, w≈6)
        ●
         \                      ★ = weighted centroid (the estimate)
          \                     ●  pulls toward the strong/near anchors,
     ★     \                       barely toward the weak/far ones
   ●────────●  Anchor A (SNR 0, w=1)
   │
   ● Anchor C (SNR −10, w≈0.1)   ← far + weak ⇒ almost no pull
```

## Step 3 — The accuracy radius (`uncertaintyKm`)

This is the circle you see. It is built from three ingredients.

### 3a. Weighted RMS spread

How far the anchors sit from the centroid, weighted:

```
            ┌─────────────────────────┐
 rms_km  =  │  Σ (wᵢ · distᵢ²)  /  Σ wᵢ
            └─────────────────────────┘   (square root of the weighted mean
                                            squared distance to the centroid)
```

### 3b. Effective sample size (Kish)

Counting anchors naively is misleading when one anchor dominates the weights, so
we use the **Kish effective sample size**:

```
          (Σ wᵢ)²
 n_eff =  ────────
           Σ wᵢ²
```

`n_eff` answers "how many *balanced* observations is this really worth?"

- Two equally-weighted anchors → `n_eff = 2`.
- One anchor at weight 10 plus one at weight 0.06 → `n_eff ≈ 1.01` — i.e.
  **effectively a single observation**, even though two anchors exist.

### 3c. Confidence blend

A raw "spread ÷ √n_eff" statistic looks dangerously confident when `n_eff` is
barely above 1 (the dominated case above). So the final radius **blends** a
conservative radio-range default toward the statistical estimate, using a
confidence factor derived from `n_eff`:

```
 statistical_km = rms_km / √n_eff          (clamped to ≥ 0.05 km)
 confidence     = clamp(n_eff − 1, 0, 1)   (0 at n_eff=1 … 1 at n_eff≥2)

 uncertainty_km = 5 km × (1 − confidence)  +  statistical_km × confidence
```

```
 n_eff   confidence   what the circle reflects
 ─────   ──────────   ────────────────────────────────────────────
  1.0       0.00      pure 5 km radio-range default (single / dominated)
  1.25      0.25      mostly default, a little statistics
  1.5       0.50      half-and-half
  1.75      0.75      mostly statistics
 ≥2.0       1.00      pure statistical radius (balanced multi-anchor)
```

- **A lone anchor** can only say "within radio range," so it gets the full
  **~5 km** default.
- **A balanced multi-anchor solve** (`n_eff ≥ 2`) trusts the geometry fully and
  can report a sub-kilometre radius.
- **Anything in between** is blended, so a near-single solve can never sneak out
  a falsely tight circle.

::: details Why the blend exists (issue #3616)
Before this refinement, the radius was just `rms_km / √n_eff`. With one strong
anchor and one weak/far anchor, the centroid collapses onto the strong anchor,
the weak anchor contributes almost nothing to `rms_km`, and `n_eff` lands at
~1.01 — *just* above the single-anchor cut-off. The result was a tiny,
**falsely confident** circle for what was effectively one observation (a node
heard once at −12 dB appearing pinned, with confidence, inside the one house
that heard it). Blending on `n_eff` closes that gap without changing the
correct weight model or any genuinely balanced estimate.
:::

## Worked examples

All three assume fresh observations (`time_decay ≈ 1`) so we can focus on SNR
and geometry.

### Example A — single anchor (one house heard it once)

```
 Observations: 1   ·   anchor at the listener, SNR −12 dB
 wSum = 0.063      w²Sum = 0.063²        n_eff = 0.063² / 0.063² = 1.00
 centroid = the anchor itself  ⇒  rms_km = 0
 confidence = clamp(1 − 1) = 0
 uncertainty = 5 km × 1  +  0.05 km × 0  =  5 km
```

➡ **Estimate sits at the anchor, circle = 5 km.** Correctly screams "I only
know it's within radio range of this one node."

### Example B — one strong + one weak/far anchor (the #3616 case)

```
 Anchor 1: SNR +10 (w = 10)   at the reporter's house
 Anchor 2: SNR −12 (w = 0.063) ~4 km away

 wSum = 10.063   w²Sum = 100.004   n_eff = 10.063² / 100.004 ≈ 1.013
 centroid ≈ 0.025 km from anchor 1 (the weak anchor barely tugs it)
 rms_km ≈ 0.32 km        statistical_km ≈ 0.31 km
 confidence = clamp(1.013 − 1) = 0.013

 uncertainty = 5 km × 0.987  +  0.31 km × 0.013  ≈  4.94 km
```

➡ **Estimate near the strong anchor, but circle ≈ 4.94 km** — honestly
unreliable. *(Before the blend fix this reported ≈ 0.31 km — confident and
wrong.)*

### Example C — balanced four-anchor solve

```
 Four anchors, comparable SNR (w ≈ 1 each), ~1 km from the node on four sides
 wSum = 4   w²Sum = 4   n_eff = 16 / 4 = 4   →  confidence = 1
 rms_km ≈ 1 km          statistical_km = 1 / √4 = 0.5 km
 uncertainty = 5 km × 0  +  0.5 km × 1  =  0.5 km
```

➡ **Tight 0.5 km circle** — the geometry is trusted because four independent
directions genuinely constrain the node.

## Reading the circle on the map

| Circle | Meaning | Typical cause |
| --- | --- | --- |
| **Large (~5 km)** | low confidence — "within radio range of one node" | single anchor, or one dominant anchor |
| **Medium (1–3 km)** | partial triangulation | a few anchors, uneven SNR |
| **Small (< 1 km)** | well-triangulated, trustworthy | several balanced anchors from different directions |

Show or hide circles with the **Show Accuracy** toggle in the **Map Features**
panel; the marker itself follows **Show Estimated Positions**. A circle is only
ever drawn together with its marker.

### Hiding the loose ones automatically

Because the biggest circles are the honest ~5 km single-anchor estimates, you
can keep the map clean with **Global Settings → Position Estimation → Maximum
acceptable accuracy**: any estimate whose `uncertaintyKm` exceeds your cutoff is
**discarded instead of stored**. A value of **2–3 km** keeps well-triangulated
nodes and drops the "somewhere out there" guesses. `0` means no limit. See
[Choosing a maximum accuracy](/features/position-estimation#choosing-a-maximum-accuracy).

## Properties worth knowing

- **Deterministic.** Same observations in the lookback window → same estimate
  and same circle, every run. There is no randomness.
- **Meshtastic-only, global.** Observations are pooled across **all** Meshtastic
  sources (including the embedded MQTT broker and bridges) into one estimate per
  physical node. MeshCore sources are excluded.
- **Self-correcting.** As soon as a node reports a real GPS position it leaves
  the estimate set and instead becomes an *anchor* for everyone else.
- **Floored, not zeroed.** The radius can never drop below **0.05 km**, so a
  multi-anchor estimate never claims absurd precision.

## Reference — the formulas

```
 weight          wᵢ      = 0.5^(age_h / 24) · 10^(SNR_dB / 10)
 position        lat,lon = Σ(wᵢ·posᵢ) / Σwᵢ            (weighted centroid)
 spread          rms     = √( Σ(wᵢ·distᵢ²) / Σwᵢ )
 effective N     n_eff   = (Σwᵢ)² / Σwᵢ²               (Kish)
 statistical     stat    = max(0.05, rms / √n_eff)
 confidence      c       = clamp(n_eff − 1, 0, 1)
 accuracy circle unc_km  = max(0.05, 5·(1−c) + stat·c)
```

Implementation: `observationWeight()` and `solveNodePosition()` in
`src/server/services/positionEstimationService.ts`.

## Related

- [Position Estimation](/features/position-estimation) — enabling it, settings, the map toggles
- [Interactive Maps](/features/maps)
- [Map Analysis](/features/map-analysis)
- [Link Quality & Smart Hops](/features/link-quality)
