# Ad Auction Profile Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ad` builds a visitor profile at one of four levels (distinct function names per level and stage), auctions the ad spot to an uninstrumented `bidder` service, and records cost vs winning bid, deployed live on the Tsuga demo cluster.

**Architecture:** Two new Java units in `ad` (`oteldemo.profile.ProfileBuilder`, `oteldemo.auction.Auction`) wired into `AdService.getAds`. A new Go `bidder` service with no OpenTelemetry, reachable under three hostnames. Flags in flagd. Kubernetes rollout through `~/tsuga/demo-gitops`.

**Tech Stack:** Java 21 + OTel Java agent (ad), JUnit 5 (new, test only), Go 1.26 stdlib (bidder), flagd, Docker Compose, Helm chart `opentelemetry-demo` 0.41.0 + Argo CD + kustomize (demo-gitops), Weaver.

**Spec:** `docs/superpowers/specs/2026-11-04-ad-auction-profile-cost-design.md`

## Global Constraints

- Fork only (`tsuga-dev`), never upstream.
- `bidder`: no OTel SDK, no agent, no `OTEL_*` env, ignores `traceparent`.
- Bidder hostnames: `bidder-astro`, `bidder-optics`, `bidder-generic`, port `8080`.
- Auction deadline `100` ms. First-price. Unsold = winner `""`, bid `0`.
- Bid: `base × bidder_factor × ln(1 + w) × noise`, `base` = `0.0021`, noise uniform ±20%.
- Levels / wrappers / stages / richness: low `profileLevelLow` `matchSessionHistory` 1; medium `profileLevelMedium` + `scoreCategoryAffinity` 4; high `profileLevelHigh` + `computeLookalikeAudience` 10; extreme `profileLevelExtreme` + `runPurchaseIntentModel` 25. Target ~2 ms CPU per unit of `w`.
- Rate env `AD_PROFILE_COST_PER_CPU_SECOND`, default `0.15`.
- No bidder URLs configured → `ad` behaves exactly as today (no profile, no auction).
- Attributes: `demo.ad.profile.level`, `demo.ad.profile.cpu_time`, `demo.ad.profile.cost`, `demo.ad.auction.bidders.count`, `demo.ad.auction.bids.count`, `demo.ad.auction.winner`, `demo.ad.auction.winning_bid`, `demo.ad.auction.loss`. Declared in `telemetry-schema/` before use.
- Flags: `adProfileLevel` (strings `low`/`medium`/`high`/`extreme`, fractional 25% each on targeting key, default `low`), `bidderSlow` (boolean, default off).
- Commits: `Assisted-by: Claude Opus 5.5` trailer, never `Co-authored-by`. Minimal comments (AGENTS.md).
- **Ask Antonin before:** creating a release, pushing to `demo-gitops` main, creating Tsuga assets.

## Review Focus

1. **No baggage / no session ID** (direct gRPC call, load-generator edge cases): flag evaluation has no targeting key. Expect level `low`, auction still runs, `GetAds` succeeds. Test in Task 5.
2. **Any auction failure** (DNS failure, connection refused, bidder 500, garbage body): `GetAds` must still return ads; the spot is recorded as unsold. Tests in Task 4 (bidder errors) and Task 5 (exception isolation).
3. **Slow bidder**: `Auction.run` must return within deadline + small margin, not wait for the slow bidder. Test in Task 4.
4. **Malformed bid requests to `bidder`** (missing/negative/non-numeric `w`): 400, not a panic or a bid. Test in Task 2.
5. **Function names vanish from profiles** (JIT inlining): the `dontinline` directive must parse at JVM start. Check in Task 3; confirmed on cluster in Task 7.

---

### Task 1: Telemetry schema

**Files:**
- Modify: `telemetry-schema/attributes/ad.yaml`
- Modify: `telemetry-schema/services/ad.yaml`

**Interfaces:**
- Produces: the 8 attribute keys in Global Constraints. Types: `level` string (examples `low`, `extreme`), `cpu_time` double (seconds), `cost` double (USD), `bidders.count` int, `bids.count` int, `winner` string (examples `bidder-astro`, `""`), `winning_bid` double (USD), `loss` boolean.

- [ ] **Step 1:** Add the 8 attributes to `attributes/ad.yaml` in the existing style (`stability: development` is fine; match the file if Weaver requires `stable`). Add `- ref:` lines for each to `services/ad.yaml`.
- [ ] **Step 2: Run Weaver check**

Run:
```bash
WEAVER_IMAGE=$(sed -n 's/^FROM \([^ ]*otel\/weaver[^ ]*\).*/\1/p' src/telemetry-docs/Dockerfile | head -1)
docker run --rm --mount "type=bind,source=$PWD/telemetry-schema,target=/home/weaver/source,readonly" "$WEAVER_IMAGE" registry check -r source
```
Expected: exits 0, no errors.
- [ ] **Step 3: Commit** `feat(telemetry-schema): add ad profile and auction attributes`

---

### Task 2: `bidder` service

**Files:**
- Create: `src/bidder/go.mod` (module `github.com/open-telemetry/opentelemetry-demo/src/bidder`, `go 1.26.0`, no requires)
- Create: `src/bidder/main.go`, `src/bidder/main_test.go`, `src/bidder/Dockerfile`, `src/bidder/README.md` (3 lines: what it is, that it is deliberately uninstrumented)
- Modify: `compose.yaml` (new service after `ad`), `.env` (`BIDDER_PORT=8080`, `BIDDER_DOCKERFILE=./src/bidder/Dockerfile`)
- Modify: `.github/workflows/tsuga-component-build-images.yml` (matrix entry `file: ./src/bidder/Dockerfile`, `tag_suffix: bidder`, `context: ./`, `setup-qemu: true`, alphabetical after `ad`)

**Interfaces:**
- Produces: HTTP `GET /bid?w=<int ≥ 0>&keys=<comma-separated>` with optional header `X-Bidder-Slow: true`. Response `200 text/plain`, body the bid formatted `%.6f`. Bad `w` → `400`. Bidder identity = `Host` header hostname without port.
- Go functions:
  - `func bidAmount(base, factor float64, w int, noise float64) float64`
  - `func factorFor(host string, keys []string) float64`: `bidder-astro` 1.2 if any key is `telescopes` or `binoculars`, else 1.0; `bidder-optics` 1.0; `bidder-generic` 0.8; unknown host 1.0.
  - `func newHandler(base float64, rnd *rand.Rand, sleep func(time.Duration)) http.Handler`
- Latency: normal uniform 5–30 ms. Slow (header true AND host `bidder-astro`): uniform 80–250 ms.

- [ ] **Step 1: Write failing tests** in `main_test.go`:
  - `TestBidAmount`: `bidAmount(0.0021, 1, 1, 1)` ≈ `0.001456` and `bidAmount(0.0021, 1, 25, 1)` ≈ `0.006842` (±1e-6); marginal gain per unit from w=1→4 is greater than from w=10→25.
  - `TestFactorFor`: `("bidder-astro:8080", ["telescopes"])`→1.2, `("bidder-astro", ["books"])`→1.0, `("bidder-generic", nil)`→0.8, `("localhost", nil)`→1.0.
  - `TestHandlerRejectsBadW`: `w` missing, `-1`, `abc` → 400.
  - `TestHandlerBids`: `GET /bid?w=10&keys=telescopes` with Host `bidder-astro` → 200, body parses as float within `[0.8, 1.2] × bidAmount(0.0021, 1.2, 10, 1)`.
  - `TestHandlerSlow`: recording `sleep` stub; Host `bidder-astro` + `X-Bidder-Slow: true` → slept ≥ 80 ms; same header on `bidder-optics` → slept ≤ 30 ms.
- [ ] **Step 2:** `cd src/bidder && go test ./...` → FAIL (undefined).
- [ ] **Step 3:** Implement in `main.go`. `main` reads `BIDDER_PORT` (default `8080`), serves `/bid` and `/healthz` (200). stdlib only.
- [ ] **Step 4:** `go test ./... && go vet ./...` → PASS.
- [ ] **Step 5:** Dockerfile: builder `golang:1.27.2-bookworm` with the same digest pin as `src/checkout/Dockerfile`, `CGO_ENABLED=0` build, runtime `gcr.io/distroless/static-debian12:nonroot` with the same digest pin as checkout. Compose service:

```yaml
  bidder:
    image: ${IMAGE_NAME}:${DEMO_VERSION}-bidder
    container_name: bidder
    build:
      context: ./
      dockerfile: ${BIDDER_DOCKERFILE}
      cache_from:
        - ${IMAGE_NAME}:${IMAGE_VERSION}-bidder
    deploy:
      resources:
        limits:
          memory: 20M
    restart: unless-stopped
    environment:
      - BIDDER_PORT
    networks:
      default:
        aliases: [bidder-astro, bidder-optics, bidder-generic]
    logging: *logging
```
- [ ] **Step 6: Verify container**

Run: `docker compose build bidder && docker compose run -d --name bidder-check bidder && docker run --rm --network opentelemetry-demo curlimages/curl -s -H 'Host: bidder-astro' 'http://bidder-check:8080/bid?w=10&keys=telescopes'; docker rm -f bidder-check`
Expected: a number around `0.006`.
- [ ] **Step 7: Commit** `feat(bidder): add uninstrumented third-party bidder service`

---

### Task 3: Profile builder in `ad`

**Files:**
- Create: `src/ad/src/main/java/oteldemo/profile/ProfileLevel.java`, `Profile.java`, `ProfileBuilder.java`
- Create: `src/ad/src/test/java/oteldemo/profile/ProfileBuilderTest.java`
- Modify: `src/ad/build.gradle` (add `testImplementation platform("org.junit:junit-bom:5.11.4")`, `testImplementation "org.junit.jupiter:junit-jupiter"`, `testRuntimeOnly "org.junit.platform:junit-platform-launcher"`, and `test { useJUnitPlatform() }`; keep it outside the `speed` branch's effect on `implementation`)
- Modify: `src/ad/Dockerfile` (append `-XX:CompileCommand=dontinline,oteldemo.profile.ProfileBuilder::*` to `JAVA_TOOL_OPTIONS`)

**Interfaces:**
- Produces:
  - `public enum ProfileLevel { LOW(1), MEDIUM(4), HIGH(10), EXTREME(25); public final int richness; public static ProfileLevel parse(String value); public String attributeValue(); }`: `parse` is case-insensitive, null/unknown → `LOW`; `attributeValue` returns lowercase name.
  - `public record Profile(ProfileLevel level, long cpuNanos) { public double cpuSeconds(); }`
  - `public final class ProfileBuilder { public static Profile build(ProfileLevel level, String seed); }`
  - Package-private static methods with these exact names: `profileLevelLow`, `profileLevelMedium`, `profileLevelHigh`, `profileLevelExtreme` (each calls the stages for its level, in order) and stages `matchSessionHistory` (1 unit), `scoreCategoryAffinity` (3), `computeLookalikeAudience` (6), `runPurchaseIntentModel` (15).
- Work per unit: `ROUNDS_PER_UNIT` SHA-256 rounds chained over a 32-byte state seeded from `seed` (reuse one `MessageDigest` per call; write the final state to a `static volatile` sink so it isn't eliminated). Start value `ROUNDS_PER_UNIT = 2000`, recalibrated in Task 5.
- `build` measures with `ManagementFactory.getThreadMXBean().getCurrentThreadCpuTime()` before/after and dispatches with a `switch` on level.

- [ ] **Step 1: Failing tests:**
  - `parseIsLenient`: `parse("HIGH")`→HIGH, `parse("extreme")`→EXTREME, `parse(null)`→LOW, `parse("bogus")`→LOW.
  - `richnessMatchesSpec`: 1, 4, 10, 25.
  - `extremeCostsMoreThanLow`: warm up 50 builds per level, then median `cpuNanos` of 20 EXTREME builds > 10 × median of 20 LOW builds.
- [ ] **Step 2:** `cd src/ad && ./gradlew test` → FAIL (compile).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `./gradlew test` → PASS. `./gradlew verifyGoogleJavaFormat` if the task exists (`./gradlew tasks --all | grep -i format`), else skip and say so.
- [ ] **Step 5: Verify the dontinline directive parses**

Run: `./gradlew installDist -PprotoSourceDir=../../pb && java -XX:CompileCommand=dontinline,oteldemo.profile.ProfileBuilder::* -cp "build/install/opentelemetry-demo-ad/lib/*" oteldemo.profile.ProfileLevel 2>&1 | head -3`
Expected: a line starting `CompileCommand: dontinline oteldemo/profile/ProfileBuilder.*` (the class has no `main`, so a `Main method not found` error after it is fine).
- [ ] **Step 6: Commit** `feat(ad): add tiered profile builder with profiler-visible stages`

---

### Task 4: Auction client in `ad`

**Files:**
- Create: `src/ad/src/main/java/oteldemo/auction/Auction.java`, `AuctionResult.java`
- Create: `src/ad/src/test/java/oteldemo/auction/AuctionTest.java`

**Interfaces:**
- Produces:
  - `public record AuctionResult(String winner, double winningBid, int biddersCalled, int bidsReceived)`
  - `public final class Auction { public Auction(List<URI> bidders, Duration deadline, HttpClient client); public static Auction fromEnv(String bidderUrls, String deadlineMs); public AuctionResult run(int richness, List<String> contextKeys, boolean bidderSlow); }`
  - `fromEnv`: returns `null` when `bidderUrls` is null/blank; URLs comma-separated; deadline default 100 ms when null/blank.
- `run`: `sendAsync` `GET <bidder>/bid?w=<richness>&keys=<url-encoded comma-joined>` with `X-Bidder-Slow: <bidderSlow>` to all bidders in parallel, each future `.orTimeout(deadline)`; wait for all to settle (bounded by deadline), cancel stragglers. A bid counts only if status 200 and body parses as a finite double ≥ 0. Winner = highest bid's `URI.getHost()`. Never throws for bidder failures.

- [ ] **Step 1: Failing tests** using `com.sun.net.httpserver.HttpServer` stubs on ephemeral ports (one server per fake bidder; tests use `http://localhost:<port>` so winner is `localhost`, so distinguish bidders by asserting `winningBid`):
  - `highestBidWins`: bids `0.002`, `0.005`, `0.003` → `winningBid == 0.005`, `bidsReceived == 3`, `biddersCalled == 3`.
  - `slowBidderIsDropped`: one stub sleeps 300 ms with bid `0.009`, another answers `0.002`; deadline 100 ms → `winningBid == 0.002`, `bidsReceived == 1`, and `run` returns in < 200 ms.
  - `badBiddersIgnored`: one returns 500, one returns `"abc"`, one returns `0.001` → `winningBid == 0.001`, `bidsReceived == 1`.
  - `allFailIsUnsold`: two URLs to closed ports → `winner == ""`, `winningBid == 0`, `bidsReceived == 0`, no exception.
  - `sendsRichnessKeysAndSlowHeader`: stub captures the request; assert query has `w=10` and `keys=telescopes%2Cbinoculars` (or equivalent decoded `telescopes,binoculars`) and header `X-Bidder-Slow: true`.
  - `fromEnvBlankIsNull`: `fromEnv("", null) == null`, `fromEnv(null, null) == null`.
- [ ] **Step 2:** `./gradlew test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `./gradlew test` → PASS.
- [ ] **Step 5: Commit** `feat(ad): add parallel first-price auction client`

---

### Task 5: Wire into `GetAds`, flags, compose, local end-to-end

**Files:**
- Modify: `src/ad/src/main/java/oteldemo/AdService.java`
- Modify: `src/flagd/demo.flagd.json`
- Modify: `compose.yaml` (`ad` env + `depends_on: bidder: condition: service_started`), `.env`

**Interfaces:**
- Consumes: `ProfileLevel`, `ProfileBuilder.build`, `Profile`, `Auction.fromEnv`, `Auction.run`, `AuctionResult`.
- New `AdService` statics: `AUCTION = Auction.fromEnv(System.getenv("AD_BIDDER_URLS"), System.getenv("AD_AUCTION_DEADLINE_MS"))`, `COST_PER_CPU_SECOND` from `AD_PROFILE_COST_PER_CPU_SECOND` (default `0.15`), flag keys `AD_PROFILE_LEVEL_FLAG = "adProfileLevel"`, `BIDDER_SLOW_FLAG = "bidderSlow"`.
- New package-private static method in `AdService`: `static Attributes auctionAdSpot(Auction auction, Client flags, double costPerCpuSecond, List<String> contextKeys, String sessionId, EvaluationContext ctx)`. `getAds` calls it after the ads are selected and before the `adFailure` check, only when `AUCTION != null`, and does `span.setAllAttributes(result)`.

Behaviour of `auctionAdSpot`:
1. `level = ProfileLevel.parse(flags.getStringValue(AD_PROFILE_LEVEL_FLAG, "low", ctx))`.
2. Child span `buildProfile` (via `tracer.spanBuilder`, made current): `Profile p = ProfileBuilder.build(level, sessionId + contextKeys)`; set `demo.ad.profile.level`, `demo.ad.profile.cpu_time` on the child.
3. `AuctionResult r = auction.run(level.richness, contextKeys, flags.getBooleanValue(BIDDER_SLOW_FLAG, false, ctx))`.
4. Return all 8 attributes; `cost = p.cpuSeconds() * costPerCpuSecond`; `loss = cost > r.winningBid()`.
5. Wrap the body in `try/catch (RuntimeException e)`: log at WARN, return `Attributes.empty()`, never rethrow (GetAds must still succeed).

Flags to add to `demo.flagd.json`:
```json
"adProfileLevel": {
  "description": "Visitor profile depth built by the ad service before each auction",
  "state": "ENABLED",
  "variants": {"low": "low", "medium": "medium", "high": "high", "extreme": "extreme"},
  "defaultVariant": "low",
  "targeting": {"fractional": [["low", 25], ["medium", 25], ["high", 25], ["extreme", 25]]}
},
"bidderSlow": {
  "description": "Makes the bidder-astro third-party bidder slow enough to miss the auction deadline",
  "state": "ENABLED",
  "variants": {"on": true, "off": false},
  "defaultVariant": "off"
}
```

`.env`: `AD_BIDDER_URLS=http://bidder-astro:8080,http://bidder-optics:8080,http://bidder-generic:8080`, `AD_AUCTION_DEADLINE_MS=100`, `AD_PROFILE_COST_PER_CPU_SECOND=0.15`. `ad` compose env: add those three names.

- [ ] **Step 1: Failing tests** `src/ad/src/test/java/oteldemo/AdServiceAuctionTest.java`, using `OpenFeatureAPI.getInstance().getClient()` with no provider set (returns defaults, i.e. no session targeting) and an `HttpServer` stub bidder returning `0.004`:
  - `noSessionDefaultsToLowAndStillAuctions`: `auctionAdSpot(auction, client, 0.15, List.of("telescopes"), null, new MutableContext())` → `demo.ad.profile.level == "low"`, `demo.ad.auction.winning_bid == 0.004`, `demo.ad.auction.bids.count == 1`, `demo.ad.profile.cost > 0`.
  - `auctionFailureDoesNotThrow`: pass an `Auction` whose `HttpClient` is a subclass/stub throwing `RuntimeException` on `sendAsync` → returns `Attributes.empty()`, no exception.
- [ ] **Step 2:** `./gradlew test` → FAIL, then implement, then PASS.
- [ ] **Step 3: Validate flags JSON**: `python3 -m json.tool src/flagd/demo.flagd.json > /dev/null` → exit 0.
- [ ] **Step 4: Local end-to-end**

Run: `make start` (or `docker compose -f compose.yaml -f compose.full.yaml -f compose.observability.yaml up -d --build ad bidder flagd frontend load-generator` plus their deps), wait 3 min, then:
`curl -s 'http://localhost:8080/jaeger/ui/api/traces?service=ad&operation=oteldemo.AdService/GetAds&limit=50' | python3 -c "import json,sys,collections; t=json.load(sys.stdin)['data']; c=collections.defaultdict(list); [c[{x['key']:x['value'] for x in s['tags']}.get('demo.ad.profile.level')].append({x['key']:x['value'] for x in s['tags']}) for tr in t for s in tr['spans'] if s['operationName'].endswith('GetAds')]; [print(k, len(v), sum(a.get('demo.ad.profile.cpu_time',0) for a in v)/len(v), sum(a.get('demo.ad.auction.winning_bid',0) for a in v)/len(v)) for k,v in c.items()]"`
Expected: all 4 levels present; mean CPU roughly 2/8/20/50 ms; mean bid roughly 0.0015/0.0034/0.005/0.0068 × bidder factors; GetAds client spans to `bidder-*` hosts visible; no `bidder` service in Jaeger's service list.
- [ ] **Step 5: Calibrate**: adjust `ROUNDS_PER_UNIT` so mean CPU per unit of `w` is ~2 ms locally. Note the value in the commit message; the cluster may need a different value (Task 7).
- [ ] **Step 6: Flags break as designed**: set `adProfileLevel` default to `extreme` and remove targeting in the flagd UI (`http://localhost:8080/feature`) → most spans `demo.ad.auction.loss=true`. Turn on `bidderSlow` → `bidder-astro` client spans > 100 ms or cancelled, `bids.count` drops to ≤ 2. Revert both.
- [ ] **Step 7: Commit** `feat(ad): auction each ad spot with tiered visitor profiles`

---

### Task 6: Release and demo-gitops rollout

All in `~/tsuga/demo-gitops` except the release. **Ask Antonin before Step 1 and before Step 7.**

**Files (demo-gitops):**
- Create: `services/bidder/deployment.yaml`, `services/bidder/service.yaml`, `services/bidder/kustomization.yaml`, `apps/bidder.application.yaml` (copy the `custom-frontend-proxy` pattern; no Image Updater)
- Create: `services/flagd-config/kustomization.yaml`, `services/flagd-config/demo.flagd.json`, `apps/flagd-config.application.yaml`
- Modify: `overlays/baseline/app-values.yaml` (`components.ad.envOverrides`, `components.flagd.additionalVolumes`)
- Regenerate: `overlays/fault/overlay.yaml`

- [ ] **Step 1: Release the fork**: after the branch is merged to `main` (PR flow per Antonin's rules), `gh release create 3.0.0.<N+1> --target main --generate-notes` in the fork; confirm the `tsuga-release` workflow pushes `otel-demo:3.0.0.<N+1>-bidder` and `-ad` to ECR.
- [ ] **Step 2: bidder manifests**: Deployment `bidder` (1 replica, image `259033777210.dkr.ecr.eu-central-1.amazonaws.com/tsuga-dev/otel-demo:3.0.0.<N+1>-bidder`, port 8080, `BIDDER_PORT=8080`, requests cpu 10m / limits memory 32Mi, readiness `httpGet /healthz`, label `app.kubernetes.io/name: bidder`, **no** OTel env or annotations). Three Services `bidder-astro`, `bidder-optics`, `bidder-generic`, port 8080, all selecting that label.
- [ ] **Step 3: flagd ConfigMap**: copy the fork's `src/flagd/demo.flagd.json` into `services/flagd-config/`; kustomization `configMapGenerator: [{name: flagd-config-tsuga, files: [demo.flagd.json]}]` with `generatorOptions: {disableNameSuffixHash: true}`. Before copying, `diff` the fork file against the chart's `flagd/demo.flagd.json` (`helm pull opentelemetry-demo --repo https://open-telemetry.github.io/opentelemetry-helm-charts --version 0.41.0 --untar`) and report any differences other than the two new flags to Antonin.
- [ ] **Step 4: app-values**:
  - `components.flagd.additionalVolumes: [{name: config-ro, configMap: {name: flagd-config-tsuga}}]`
  - `components.ad.envOverrides`: keep `_JAVA_OPTIONS`, append `AD_BIDDER_URLS=http://bidder-astro:8080,http://bidder-optics:8080,http://bidder-generic:8080`, `AD_AUCTION_DEADLINE_MS=100`, `AD_PROFILE_COST_PER_CPU_SECOND=0.15`.
  - Bump `default.image.tag` and the `service.version` in `default.envOverrides` to `3.0.0.<N+1>`.
- [ ] **Step 5: Regenerate fault overlay** with a one-off `tsx` script in `tools/rotation` that loads `fault/state.yaml`, `fault/services.yaml` (criticality), `proxy/state.yaml` (default `{active:false}`) and `overlays/baseline/app-values.yaml` exactly as `src/run.ts` does, calls `buildOverlay` with no decide step, and writes `overlays/fault/overlay.yaml`. Never run `run.ts`. Don't commit the script.
- [ ] **Step 6: Render check**: `helm template t opentelemetry-demo --repo https://open-telemetry.github.io/opentelemetry-helm-charts --version 0.41.0 -f overlays/baseline/app-values.yaml -f overlays/baseline/images.yaml -f overlays/fault/overlay.yaml | grep -n "flagd-config-tsuga\|AD_BIDDER_URLS\|PreserveFramePointer"` → configmap ref, bidder env and `_JAVA_OPTIONS` all present (the `dontinline` flag lives in the image, not the chart). `kubectl kustomize services/bidder` and `services/flagd-config` render without error.
- [ ] **Step 7: Push** (after Antonin's go) as a direct commit to `demo-gitops` main.
- [ ] **Step 8: Check pods**: `kubectl --context demo -n demo get pods` → `bidder`, `ad`, `flagd` Running, no CrashLoopBackOff. `kubectl --context demo -n demo logs deploy/ad | grep -i "CompileCommand"` shows the dontinline line.

---

### Task 7: Verify on the demo cluster

Use `tsugactx use demo`, restore the previous context at the end.

- [ ] **Step 1: Function names in profiles**: scalar sum of `profile.samples.ad` over the last 30 min with filters `stack_trace:*profileLevelLow*`, `*profileLevelExtreme*`, `*runPurchaseIntentModel*` → all > 0, and extreme ≫ low. If zero: stop and report (spec's first risk).
- [ ] **Step 2: Spans**: aggregation on traces, `context.service.name:ad` GetAds spans grouped by `demo.ad.profile.level`: avg `demo.ad.profile.cpu_time`, avg `demo.ad.auction.winning_bid`, count of `demo.ad.auction.loss:true`. Expected: low/medium/high profitable, extreme mostly loss.
- [ ] **Step 3: Cross-check**: profiler CPU seconds for `*profileLevel*` frames (samples / 20) vs sum of `demo.ad.profile.cpu_time` over the same window → within ~30%.
- [ ] **Step 4: Recalibrate if needed**: if per-unit CPU on the cluster is far from 2 ms, change `AD_PROFILE_COST_PER_CPU_SECOND` in app-values (regenerate overlay, ask before pushing) rather than rebuilding the image.
- [ ] **Step 5:** Report numbers to Antonin. The Tsuga dashboard (spec's 7 widgets) is built next via `tsuga-build-assets`, with his confirmation per asset.

---

### Task 5b: Load generator — rotate sessions, more ad traffic (added after final review)

Why: k6 keeps one `sessionId` per VU forever (~6 sessions on the cluster), so the 25% fractional split on the session key often leaves a level that never runs; and GetAds runs only ~5–6 times/min, too few for profiler samples per level.

**Files:**
- Modify: `src/load-generator/script.js`

**Interfaces:**
- Consumes: `onStart()`, `sessionId`, `getAds()`, `browseProduct()`, `categories` in `script.js`.
- Produces: a module constant `SESSION_ITERATIONS = 20` and an extracted `fetchAds(category, traceParent)` helper used by both `getAds()` and `browseProduct()`.

- [ ] **Step 1:** In `httpScenario`, count iterations per VU; after every `SESSION_ITERATIONS` iterations set `sessionId = null` so the next iteration calls `onStart()` (new session ID, new person). ~2 minutes per session at the current 1–10 s sleep.
- [ ] **Step 2:** Extract the ads request from `getAds()` into `fetchAds(category, traceParent)` (same URL logic, including `contextKeys=None` for null). `browseProduct()` also calls `fetchAds(randomChoice(categories), span.traceParent())` after the product request, like the real product page loading its ad slot. Leave task weights and sleeps unchanged.
- [ ] **Step 3: Verify:** `docker compose ... up -d --build load-generator` with the stack (or a k6 `inspect`/short run if the full stack is not needed: `docker compose run --rm load-generator` for ~2 min) and confirm in Jaeger (`/jaeger/ui/api/v3/traces`) or ad logs: GetAds rate roughly 3–4× before, more than 6 distinct `session.id` values over 5 minutes, and all four `demo.ad.profile.level` values present. Stop what you started.
- [ ] **Step 4: Commit** `feat(load-generator): rotate sessions and fetch ads on product views`
