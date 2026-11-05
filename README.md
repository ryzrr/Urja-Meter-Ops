# Urja Meter API

A read-only REST API in front of the Urja Meter Ops portal. The portal is a web UI with no public API; this service logs into it, pulls its data, cleans it up, and serves it as documented JSON.

What you can do with it:

- search and filter meters by ID, serial, status, make, phase, network position or distance from a point
- get one meter with its full network path and coordinates
- get cleaned register readings and derived consumption (per interval or per day)
- browse the network hierarchy (zone down to transformer) and the transformer list
- see every data problem found in the portal data and how it was handled

Other documents:

| File | What it is |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | How the portal works: endpoints, auth, export signing, rate limits, quirks |
| [openapi.json](openapi.json) | OpenAPI 3.0 spec of this API (generated from the code) |
| [REFLECTION.md](REFLECTION.md) | Answers to the reflection questions |
| `http://localhost:3000/docs` | Interactive API docs (Scalar) while the server runs |

## Quick start

Requires Node.js 22 or newer.

```bash
git clone https://github.com/ryzrr/Urja-Meter-Ops.git
cd Urja-Meter-Ops
npm install
cp .env.example .env        # then set PORTAL_PASSWORD
npm run dev
```

The server starts on `http://localhost:3000` and loads the meter catalog from the portal in the background (about a second). Open `http://localhost:3000/docs` to explore the API.

For a production style run:

```bash
npm run build
npm start
```

Other scripts:

```bash
npm test            # unit and HTTP tests, no network needed
npm run typecheck
npm run openapi     # regenerate openapi.json from the route schemas
```

## Sample requests

Faulty three phase meters:

```bash
curl "http://localhost:3000/v1/meters?status=faulty&phase=three&pageSize=2"
```

One meter:

```bash
curl "http://localhost:3000/v1/meters/J100001"
```

```json
{
  "data": {
    "meterId": "J100001",
    "serialNumber": "GE84132",
    "make": "L&T",
    "phase": "single",
    "status": "installed",
    "installationType": "ct_operated",
    "build": "legacy",
    "transformerCode": "DT-002",
    "location": { "latitude": 26.822136543835608, "longitude": 75.90718190602279 },
    "network": {
      "zone": { "code": "Z-02", "name": "Jaipur Zone 2" },
      "circle": { "code": "C-02", "name": "Circle 2" },
      "division": { "code": "D-02", "name": "Division 2" },
      "subdivision": { "code": "SD-02", "name": "Subdivision 2" },
      "substation": { "code": "SS-02", "name": "Substation 2" },
      "feeder": { "code": "F-002", "name": "Feeder 2" },
      "transformer": { "code": "DT-002", "name": "Mansarovar DT 2" },
      "nodeId": "Z-02/C-02/D-02/SD-02/SS-02/F-002/DT-002"
    },
    "dataIssues": []
  },
  "meta": { "dataAsOf": "2026-11-05T17:46:55.083Z" }
}
```

Daily consumption:

```bash
curl "http://localhost:3000/v1/meters/J100001/consumption?from=2026-06-01&to=2026-06-02"
```

```json
{
  "data": {
    "meterId": "J100001",
    "from": "2026-06-01",
    "to": "2026-06-02",
    "interval": "PT30M",
    "granularity": "day",
    "totalKwh": 39.66,
    "totalKvah": 42.83,
    "points": [
      { "start": "2026-06-01T00:00:00+05:30", "end": "2026-06-02T00:00:00+05:30", "kwh": 19.83, "kvah": 21.41 },
      { "start": "2026-06-02T00:00:00+05:30", "end": "2026-06-03T00:00:00+05:30", "kwh": 19.83, "kvah": 21.42 }
    ]
  },
  "dataIssues": []
}
```

More examples:

```bash
# meters within 1.5 km of a point, nearest first
curl "http://localhost:3000/v1/meters?near=26.9124,75.7873&radiusKm=1.5"

# everything under one circle
curl "http://localhost:3000/v1/meters?nodeId=Z-01/C-01"

# children of a zone
curl "http://localhost:3000/v1/network?parentId=Z-01"

# what was wrong with the data
curl "http://localhost:3000/v1/data-quality"
```

Note: the portal only holds readings for June 2026, so use dates in that month. Without `from` and `to`, readings use the portal's default window: the last 7 days of data it holds.

## Endpoints

| Method and path | Description | Hits the portal? |
|---|---|---|
| `GET /v1/meters` | Search and filter, paginated | No (catalog) |
| `GET /v1/meters/{meterId}` | One meter | No (catalog) |
| `GET /v1/meters/{meterId}/readings?from&to` | Cleaned register readings | Yes, cached 15 min |
| `GET /v1/meters/{meterId}/consumption?from&to&granularity` | Usage per interval or day | Yes, cached 15 min |
| `GET /v1/transformers` | Transformer list with meter counts | No (catalog) |
| `GET /v1/transformers/{code}` | One transformer | No (catalog) |
| `GET /v1/network?level&parentId` | Hierarchy nodes with `parentId` links | No (catalog) |
| `GET /v1/data-quality?type` | Problems found and how they were handled | No (catalog) |
| `GET /health` | Catalog age and last refresh error | No |
| `GET /openapi.json`, `GET /docs` | Spec and interactive docs | No |

Errors always look like `{"error": {"code": "...", "message": "...", "details": ...}}`. Codes:

| Status | Codes |
|---|---|
| 400 | `invalid_request` (with per-field `details`) |
| 404 | `meter_not_found`, `transformer_not_found`, `route_not_found` |
| 500 | `internal_error` |
| 502 | `upstream_unavailable`, `upstream_auth_failed`, `upstream_contract_changed` |
| 503 | `upstream_rate_limited` (with `Retry-After`) |

## How it works

```
                 ┌──────────────────────────── this service ───────────────────────────┐
 client ──HTTP──▶│ Express routes ──▶ CatalogService (snapshot, refreshed every 10 min)│
                 │  (Zod validated)   ReadingsService (per meter+range, 15 min cache)  │
                 │                          │                                          │
                 │                    PortalClient: login, re-login, HMAC signing,     │
                 │                    throttle (90 req/30s), retry with backoff        │
                 └──────────────────────────┼──────────────────────────────────────────┘
                                            ▼
                                   Urja Meter Ops portal
```

Two kinds of data, handled differently:

- **Catalog (meters, hierarchy, transformers).** Loaded with 4 portal calls: the signing key, the signed bulk export (all 403 meters in one response) and the 2 pages of the transformer list. It is cleaned, indexed and kept in memory. Every metadata query is answered from memory.
- **Readings.** Fetched per meter and date range when asked for, then cached. There is no bulk path for readings, and fetching all of them would cost 403 requests against a limit of about 120 per 30 seconds.

### Project layout

```
src/
  server.ts                 wiring and startup
  config.ts                 env parsing and validation
  portal/                   everything that talks to the portal
    client.ts               login, session reuse, signing, retries
    rate-limiter.ts         shared sliding window throttle
    signing.ts              export HMAC
    schemas.ts              runtime checks on portal responses
  domain/                   pure functions, no I/O
    catalog.ts              raw export -> clean meters, hierarchy repair
    network.ts              hierarchy tree, distance
    readings.ts             timestamp parsing, dedupe, consumption
    search.ts               meter filters
    models.ts               API models (Zod: types and OpenAPI from one place)
  services/                 caching and freshness
    catalog-service.ts
    readings-service.ts
  api/                      HTTP layer
    app.ts, errors.ts, schemas.ts, routes/
test/                       Vitest + Supertest, fixtures are recorded portal responses
scripts/generate-openapi.ts
```

## Configuration

All settings are environment variables (a `.env` file is loaded if present). See [.env.example](.env.example).

| Variable | Default | Notes |
|---|---|---|
| `PORTAL_EMAIL`, `PORTAL_PASSWORD` | required | Portal login |
| `PORTAL_BASE_URL` | `https://urja-ops.flockenergy.tech` | |
| `PORT` | `3000` | |
| `SNAPSHOT_TTL_SECONDS` | `600` | Catalog age before a background refresh |
| `READINGS_TTL_SECONDS` | `900` | Readings cache lifetime |
| `PORTAL_MAX_REQUESTS`, `PORTAL_WINDOW_SECONDS` | `90`, `30` | Client-side throttle |
| `PORTAL_TIMEOUT_SECONDS` | `15` | Per request |
| `PORTAL_UTC_OFFSET` | `+05:30` | Applied to the portal's zone-less timestamps |

## Assumptions

- **Timestamps are IST.** The portal sends `24/06/2026 00:30` with no zone. The network is in Jaipur, so I assume +05:30. It is configurable.
- **`kwh` and `kvah` are cumulative registers.** They only increase within a meter, so usage is the difference between readings.
- **The export is the source of truth for meter metadata.** It matched the search and geo endpoints on every meter I compared, and it has more fields.
- **The transformer list (`/portal/dts`) is the source of truth for transformer names.** It is clean, and it disagrees with only 3 meter records.
- **`build` (legacy or v2) describes the portal record, not the meter.** Its only visible effect is the format of the detail page data.
- **Metadata changes slowly.** A 10 minute old catalog is acceptable for an operations lookup tool.
- **One service account is fine.** API clients are not individually authenticated against the portal.

## Design decisions and trade-offs

**Snapshot the catalog instead of proxying each request.** Forwarding every API call to the portal would spend its rate budget (about 120 requests per 30 seconds) on every lookup, and the portal's search cannot filter by status, make or location anyway. One export call gives the full dataset. The trade-off is staleness, bounded by the 10 minute TTL.

**Stale-while-revalidate.** When the catalog is older than its TTL, the next request triggers a background refresh and is answered from the old snapshot. If the portal is down, the API keeps serving the last good snapshot, and `/health` reports `degraded` with the error. Reads never block on a refresh after the first load.

**Readings are cached for 15 minutes.** The fastest meters report every 30 minutes, so a client sees at most one reading less than the portal has. Repeated requests for the same meter and range (a dashboard refreshing, for example) cost no portal calls. The June data is historical, so in practice nothing changes underneath.

**Network nodes are identified by full path, not by code.** Below zone level the portal reuses codes under different parents (`SD-01` sits under `D-01`, `D-05` and `D-09`, with 10 meters each). It is systematic, not noise, so majority voting does not work. Keying by path (`Z-01/C-01/D-07`) keeps a proper tree and loses nothing. Each case is listed in `/v1/data-quality` as `code_reused_across_parents`. The network is returned as a flat list with `parentId`, which is simple to page and filter and easy to turn back into a tree.

**Repairs are data driven and visible.** A missing code is filled from another record with the same name (and the reverse), and transformer names come from the master list. Nothing is guessed from string patterns. Every repair is attached to the meter (`dataIssues`) and listed in `/v1/data-quality`, so consumers can see what was changed.

**Readings: raw and derived, nulls over zeros.** `/readings` returns what the meter reported, cleaned (ISO timestamps, numbers, duplicates dropped). `/consumption` derives usage from register deltas. A missing value or a register that goes down yields `null` and an issue rather than a made-up number. Day D's usage needs the reading at D+1 00:00, so the service fetches one extra day past `to`.

**Strict input validation.** The portal silently ignores bad dates and pages and returns HTTP 200 with default data. This API rejects them with 400 and says why. Ranges are limited to 92 days.

**Resilience lives in one place.** `PortalClient` handles session expiry (re-login once, shared across concurrent callers), signature rejection (refetch the secret once), 429 (pause the shared throttle, back off 2s to 16s), and 5xx, timeouts and network errors (retry with backoff). Portal responses are checked against Zod schemas, so a portal change surfaces as `upstream_contract_changed` instead of bad data.

**One schema definition per shape.** Zod schemas are used for request validation, for the TypeScript types and, through `zod-to-openapi`, for `openapi.json`. The spec cannot drift from the code, and `npm run openapi` regenerates it.

**Stack.** Express 5, Zod, Vitest and Supertest. Nothing else at runtime except the docs UI. Storage is in memory.

## Query layer and scale

Filters and the distance search are linear scans over an in-memory array. At 403 meters a status plus distance query takes about 0.1 ms, and building the catalog from the export takes about 16 ms. This approach is fine up to tens of thousands of meters.

Where it starts to struggle:

- **Around 50k to 100k meters**, the single export response becomes tens of MB and slow to fetch, parse and hold in memory on every refresh. Linear scans would still be acceptable, but distance search would want a spatial index.
- **Cross-meter readings questions** (for example total load per transformer, or meters with unusual usage) need one portal request per meter. At about 3 requests per second, 403 meters take over 2 minutes. That is why the API has no cross-meter consumption endpoints.

What I would change at that point: sync into SQLite or Postgres (with PostGIS for distance), refresh the catalog incrementally if the portal allowed it, and run a background job that ingests readings within the rate budget, so aggregates are answered from the local store.

## What I left out on purpose

- **Web client.** Optional, and I chose to spend the time on the API, the data cleaning and the write-up.
- **Persistent storage.** The dataset fits in memory, and a database would add setup for the reviewer with no benefit at this size.
- **Cross-meter consumption aggregates.** See the rate limit cost above.
- **Authentication on this API.** It would matter for deployment, but it is out of scope for a local service.
- **The meter detail endpoint (`__data.json`).** Its data is already in the export. Decoding SvelteKit's devalue format and the two detail shapes would add code for nothing new. The format is documented in PROTOCOL.md.
- **Proactive session refresh.** Re-login on the first 401 costs one extra request per hour, which is simpler than tracking expiry.
- **Docker.** `npm install && npm run dev` is enough for a single Node service.

## What I would do with more time

- Background ingestion of all readings into SQLite, to support per-transformer load, anomaly detection (for example decommissioned meters that are still consuming) and fast cross-meter queries.
- On a lookup miss, refresh the catalog (rate limited) so meters added since the last snapshot are found without waiting for the TTL.
- Structured logs and basic metrics: portal latency, 429 count, cache hit rate, snapshot age.
- A scheduled contract check against the live portal that fails loudly when a response shape changes.
- A small web client: map of meters coloured by status, hierarchy explorer, consumption charts.

## Testing

```bash
npm test
```

38 tests, all offline. They cover:

- **Portal client:** login reuse, re-login after expiry, HTTP 200 login failure, 429 backoff and give-up, signature refresh, contract errors. Uses a scripted fake `fetch` and a fake clock.
- **Signing:** checked against an HMAC computed independently with `openssl`.
- **Domain:** hierarchy repair, transformer name override, code reuse detection, network tree invariants, filters and distance search, timestamp parsing, duplicate handling, interval inference and consumption maths.
- **HTTP:** routes through Supertest, including validation errors, 404 without a portal call, caching, and mapping a portal 429 to 503.

Fixtures in `test/fixtures` are trimmed real portal responses, chosen to include the problem records.

## Reflection

See [REFLECTION.md](REFLECTION.md).
