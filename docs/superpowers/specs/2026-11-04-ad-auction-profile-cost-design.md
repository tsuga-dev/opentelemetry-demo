# Ad auction: profile cost vs winning bid

Date: 2026-11-04
Status: draft, awaiting approval

## Intent

On a real e-commerce site, ad spots are sold to third parties who bid based on
a visitor profile the site computes. Site owners want to know whether computing
that profile costs more than the ad spot earns. This adds that scenario to the
Tsuga fork of the OpenTelemetry demo so a prospect can see, on one dashboard,
**profile compute cost vs winning bid**, per profile level, per ad spot and per
visitor session, with the cost derived from real telemetry rather than a made-up
number.

Two further stories come with it:

- **Profiling.** The headline cost comes from Tsuga's eBPF CPU profiles
  (`profile.samples.ad`), measured from outside the process. The flame graph shows
  which profile level and which profiling stage burns the CPU.
- **Third-party monitoring.** The bidders are third parties we don't instrument,
  so the demo shows monitoring a third-party dependency's response time purely
  from our own outgoing calls.

## Goals

- `ad` builds a visitor profile with real CPU work, at one of four levels, using
  distinct function names per level and per stage so the profiler can attribute
  cost to both.
- All four levels run concurrently by default (sessions split across levels), so
  levels can be compared side by side in one time window.
- `ad` runs an auction against several bidders and records the winning bid.
- A new `bidder` service plays the third-party bidders. It emits no telemetry of
  its own; it is visible only through `ad`'s outgoing call spans.
- Story: a deeper profile earns higher bids, but bid gains flatten while compute
  cost keeps rising, so the most expensive level sells spots at a loss, and there
  is an optimal level in between.
- Feature flags drive the stories live: profile level (cost) and bidder slowness
  (third-party latency).
- A Tsuga dashboard showing the numbers (layout below).
- Live on the Tsuga demo cluster at the end.

## Non-goals

- Upstreaming. This stays in `tsuga-dev`'s fork (AGENTS.md's "agree new services
  with maintainers" rule is for upstream).
- A realistic RTB protocol (OpenRTB etc.). A minimal JSON request/response is enough.
- Changing what ads the frontend displays. The auction decides the price, not the
  creative.
- Billing accuracy. Bids stay realistic ($0.001-0.01 per impression); the
  $/CPU-second rate is deliberately inflated and framed as the **fully loaded cost
  of profiling** (data stores, ML features, infra), not raw CPU price. Antonin's
  decision.

## Anti-goals

- A cost that is hardcoded or computed from a formula. Cost must come from
  measured CPU: profiler samples or measured thread CPU time.
- Instrumenting `bidder`. If it ever shows up as its own service in traces, the
  "external third party" story is broken.
- Unhealthy-looking `ad` by default: latency and error rate must stay normal with
  `bidderSlow` off. (The extreme level losing money is the intended business
  finding, not a health problem.)
- Profile function names disappearing from the stacks (JIT inlining). If the
  profiler can't see them, the per-level and per-stage story is gone.

## Design

### Request flow (one `GetAds` call = one ad spot)

1. Frontend calls `ad.GetAds` as today (`session.id` arrives via baggage, already
   recorded on the span and already used as the flag targeting key).
2. `ad` evaluates `adProfileLevel` for the session and builds the profile in a
   child span `buildProfile`.
3. `ad` calls each bidder in parallel over HTTP with the profile richness, with a
   deadline.
4. Highest bid received before the deadline wins. Late or failed bidders are dropped.
5. `ad` returns ads as today and records the profile and auction results on the
   `GetAds` span.

### Profile build (`ad`, Java)

One wrapper method per level, each calling the stages cumulatively. Each stage is
its own method doing real CPU-bound work (e.g. hashing/scoring rounds over
synthetic signals from context keys, session, loyalty level). Names are part of
the design, since they are what shows up in the profiles:

| Level | Wrapper | Stages called (in order) | Richness `w` |
| --- | --- | --- | --- |
| low | `profileLevelLow` | `matchSessionHistory` | 1 |
| medium | `profileLevelMedium` | + `scoreCategoryAffinity` | 4 |
| high | `profileLevelHigh` | + `computeLookalikeAudience` | 10 |
| extreme | `profileLevelExtreme` | + `runPurchaseIntentModel` | 25 |

So a sample's stack reads e.g. `getAds -> ... -> profileLevelHigh -> computeLookalikeAudience`,
and can be filtered by level frame or by stage frame.

- Each stage's CPU work is sized so CPU time grows roughly in proportion to `w`
  (target about 2 ms of CPU per unit of `w`, so 2 / 8 / 20 / 50 ms). The stages
  must be heavy enough not to get inlined; also add
  `-XX:CompileCommand=dontinline,<profile package>.*::*` to `ad`'s JVM options.
  **First implementation step: confirm locally (or on the demo cluster) that the
  wrapper and stage names appear in `profile.samples.ad` stack traces.** If not,
  stop and rethink before building further.
- Measure the thread CPU time around the build with
  `ThreadMXBean.getCurrentThreadCpuTime()` (CPU, not wall clock).
- Methods live in a dedicated class/package (e.g. `oteldemo.profile`) so the
  `dontinline` rule targets only them.

### Cost: two sources

- **Profiler (headline numbers, per level, per stage).** In Tsuga:
  `cpu_seconds = sum(profile.samples.ad where stack_trace:*<frame>*) / 20`
  (the profiler samples at 20 Hz; Tsuga docs say to keep the default).
  `cost = cpu_seconds x rate`. Verified on the demo cluster on 2026-11-04 that
  `stack_trace:*<method>*` filters work on this metric (`*Logarithmizer*` isolates
  the `adHighCpu` load). The profile metric has no request/session dimension and
  ~20 Hz resolution, so it cannot drive per-spot or per-session numbers.
- **Span (per spot, per session, loss flag).** `ad` records the measured thread
  CPU time and the derived cost `cpu_time x rate` on the span, with the rate from
  an env var (`AD_PROFILE_COST_PER_CPU_SECOND`), and whether the spot was sold at
  a loss (`cost > winning_bid`). *(My call: we can't assume Tsuga does per-span
  arithmetic for the loss tile; computing it in `ad` removes the dependency.)*
- Both use the same rate value. The two cost figures should roughly agree over a
  window; that agreement is a demo moment in itself.

### Auction (`ad`, Java)

- `ad` calls 3 bidders in parallel via `java.net.http.HttpClient` (auto-instrumented
  by the Java agent, so client spans carry `server.address`, duration, status).
- Bidder hostnames are distinct (`bidder-astro`, `bidder-optics`, `bidder-generic`)
  so each looks like a separate third party.
- Deadline: 100 ms. Late bidders are excluded and their call cancelled.
- First-price auction: winner = highest bid, pays its bid. USD per impression.
- No bid in time: spot unsold, bid 0, recorded as such.
- No bidder hosts configured: `ad` skips the profile build and auction entirely and
  behaves as today. *(My call: an `ad` image deployed without `bidder` must not emit
  failed calls on every request.)*

### Bidder service (new, `src/bidder`)

- Go, stdlib HTTP only. *(My call.)* One container answering under the 3 hostnames;
  bidder identity from the `Host` header.
- **No OpenTelemetry SDK, no agent, no OTLP config.** Ignores incoming `traceparent`.
- Request: profile richness `w`, context keys. Response: bid in USD.
- Latency normally a few to tens of ms. When `bidderSlow` is on, one bidder
  (`bidder-astro`) becomes slow enough to miss the deadline often. `bidder` has no
  flagd client, so `ad` evaluates the flag and passes it as a request header, or
  `bidder` reads flagd over plain HTTP; builder's call, as long as `bidder` stays
  uninstrumented.

### The maths

```text
cost   = cpu_seconds x rate
bid    = base x bidder_factor x ln(1 + w) x noise
margin = winning_bid - cost         loss = cost > winning_bid
```

- `ln(1 + w)`: diminishing returns.
- `bidder_factor`: per-bidder valuation (e.g. `bidder-astro` 1.2x on astronomy
  categories).
- `noise`: +/-20% random.
- The optimal level is where one more unit of `w` adds as much bid as it costs:
  `base / (1 + w) = rate x cpu_per_unit`.

Starting values: `rate` = $0.15/CPU-s, `base` = $0.0021, ~2 ms CPU per unit of `w`. Default shipped rate is **$0.20/CPU-s**: the winning bid is the max of 3 noisy bids, so measured winning bids run ~20% above the table (extreme ~ $0.0082), and 0.15 left extreme at break-even.
Expected (before factor and noise):

| Level | w | CPU | Cost | Bid | Margin |
| --- | --- | --- | --- | --- | --- |
| low | 1 | 2 ms | $0.0003 | $0.0015 | +79% |
| medium | 4 | 8 ms | $0.0012 | $0.0034 | +65% |
| high | 10 | 20 ms | $0.0030 | $0.0050 | +40% |
| extreme | 25 | 50 ms | $0.0075 | $0.0068 | -10% |

Optimum at w ~ 6, between medium and high. Actual CPU per unit depends on the node
type and JVM, so these get recalibrated on the demo cluster; `rate` is the main knob.
$0.20/CPU-s is about $720/CPU-hour, roughly 10,000x raw cloud pricing: that's the
"fully loaded cost" framing.

### Telemetry

New attributes, declared in `telemetry-schema/attributes/ad.yaml` first and listed
in `telemetry-schema/services/ad.yaml`:

| Attribute | Span | Meaning |
| --- | --- | --- |
| `demo.ad.profile.level` | `buildProfile`, `GetAds` | `low` / `medium` / `high` / `extreme` |
| `demo.ad.profile.cpu_time` | `buildProfile`, `GetAds` | CPU seconds spent building the profile (double) |
| `demo.ad.profile.cost` | `GetAds` | CPU time x configured rate, USD (double) |
| `demo.ad.auction.bidders.count` | `GetAds` | bidders called |
| `demo.ad.auction.bids.count` | `GetAds` | valid bids received before deadline |
| `demo.ad.auction.winner` | `GetAds` | winning bidder hostname, empty if unsold |
| `demo.ad.auction.winning_bid` | `GetAds` | winning bid, USD (double), 0 if unsold |
| `demo.ad.auction.loss` | `GetAds` | true if profile cost > winning bid |

Bidder call spans come from the Java agent's HTTP client instrumentation, so
third-party latency needs no new attributes. Names follow existing `demo.ad.*`
conventions; `weaver registry check` must pass. No new metrics unless the Tsuga
dashboard needs one for a time series.

### Feature flags (`src/flagd/demo.flagd.json` and the chart's flagd config)

- `adProfileLevel`: string variants `low` / `medium` / `high` / `extreme`. Default
  targeting: flagd `fractional` on the session targeting key, 25% each, so all
  levels run concurrently. Pinning a single variant (e.g. all `extreme`) is the
  "break it" move.
- `bidderSlow`: boolean, default off.

### Dashboard (Tsuga, approved wireframe plus per-level comparison)

1. KPI row: bid revenue, profile compute cost, margin, % spots sold at a loss.
2. Time series: revenue vs cost per minute (cost from the profiler).
3. **Per level:** cost per level (profiler, by `profileLevel*` frame) next to
   average winning bid per level (spans, grouped by `demo.ad.profile.level`).
   This is where the optimum shows.
4. **Per stage:** CPU cost per stage (profiler, by stage frame).
5. Per ad spot table: time, session, level, CPU time, cost, winning bidder, bid, margin.
6. Per session table: spots, total cost, total revenue, margin.
7. Third party: bidder latency by `server.address` and timeouts, from `ad`'s client spans.

Built in the Tsuga demo account once the scenario is live. Not code in this repo.
Unverified: whether one Tsuga widget can combine a metric query with a span query
for a computed margin; if not, cost and revenue sit in adjacent widgets.

### Deployment

- `compose.yaml`: new `bidder` service with the 3 network aliases; `ad` gets bidder
  hosts, deadline and rate via env vars, the `dontinline` JVM option, and
  `depends_on: bidder`.
- `.github/workflows/tsuga-component-build-images.yml`: add `bidder` to the matrix.
- `demo-gitops` (`~/tsuga/demo-gitops`, separate repo), **in scope**:
  - `bidder` deployed, reachable under the 3 bidder hostnames (one Service per
    hostname, or equivalent).
  - `ad` gets the same env vars and JVM option.
  - `adProfileLevel` and `bidderSlow` added to the flagd config the chart supplies.
  - Release flow: fork release builds images, then bump tags in
    `overlays/baseline/app-values.yaml`. Gotcha: `overlays/fault/overlay.yaml` is a
    generated copy of the app-values components and must be regenerated after any
    edit there (via `buildOverlay`, never `run.ts`). Render with `helm template`
    using all 3 value files before pushing, then check pods.
  - Pushing to `demo-gitops` main affects the shared demo cluster: confirm with
    Antonin before pushing.

## Constraints

- Match existing patterns: flags like `adHighCpu`, spans/attributes like existing
  `AdService.java` code, compose entry like other services.
- `ad` memory limit is 300M; profile work must be CPU-bound, not allocation-heavy.
- Average profile CPU with the default 25% split is ~20 ms per request; check `ad`'s
  CPU limit on the demo cluster can absorb it at demo traffic (note `adHighCpu`
  was observed on there on 2026-11-04, using most of `ad`'s sampled CPU).

## Left to the builder

- The exact CPU work in each stage, the bid constants, per-bidder factors and the
  default rate, tuned so that low/medium/high are profitable, extreme loses money,
  bids stay realistic and the optimum falls between medium and high.
- The `bidderSlow` latency figure.
- How `bidder` learns `bidderSlow` (header from `ad` vs flagd over HTTP).
