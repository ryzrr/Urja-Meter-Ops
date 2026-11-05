# Urja Meter Ops portal: how it works

Notes from exploring `https://urja-ops.flockenergy.tech` as the provided operator account, using a browser, DevTools, curl and small Node scripts. Everything here was observed on 2026-11-05. Nothing was obtained beyond what a logged-in user's browser already does.

## Summary

- SvelteKit app. The HTML pages are thin; data comes from a small set of JSON endpoints under `/portal/*`.
- Auth is a better-auth session cookie that lasts 1 hour. Login is a SvelteKit form action.
- There is a bulk export (`/portal/export`) that returns every meter with its hierarchy and coordinates in one response. It needs an HMAC signature, and the signing secret is handed to any logged-in user by `/portal/keys`.
- `/portal/*` is rate limited to roughly 120 requests per 30 seconds, with no `Retry-After` header.
- Readings exist for June 2026 only. Some meters report every 30 minutes, others once a day.
- The hierarchy data is inconsistent: missing codes and names, a stale transformer name, and codes that appear under several parents.

## How I found it

1. `GET /` redirects to `/login`. Response headers include `x-sveltekit-page: true` and preload links to `/_app/immutable/...`, so it is SvelteKit.
2. `/_app/immutable/entry/app.*.js` contains the route manifest:
   `/login`, `/(portal)/meters`, `/(portal)/meters/[id]`, `/(portal)/transformers`.
3. Each page bundle (`/_app/immutable/nodes/*.js`) shows its `fetch` calls. That gave every JSON endpoint below, plus the export signing code.
4. Each endpoint was then called directly with the session cookie to confirm the shapes, parameters and error behaviour.

## Authentication

### Login

```
POST /login
content-type: application/x-www-form-urlencoded
origin: https://urja-ops.flockenergy.tech
accept: application/json
x-sveltekit-action: true

email=operator%40urja.local&password=...
```

Success:

```
HTTP 200
set-cookie: __Secure-better-auth.session_token=<token>; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax

{"type":"redirect","status":303,"location":"/meters"}
```

Notes:

- A wrong password also returns **HTTP 200**: `{"type":"failure","status":401,"data":"..."}`. You have to read the body to know whether login worked.
- Without an `Origin` header that matches the site, the response is `403 Cross-site POST form submissions are forbidden` (SvelteKit CSRF check).
- Without `x-sveltekit-action: true` the action still runs and sets the cookie, but the response body is HTML.
- Logging in again creates a second session; the first one stays valid.

### Session

- Cookie: `__Secure-better-auth.session_token`, `Max-Age=3600`.
- `GET /api/auth/get-session` returns the session (`expiresAt` 1 hour after creation) and user (`Ops Desk`, `operator@urja.local`). The expiry did not slide while I used the session.
- `POST /api/auth/sign-out` is what the Sign out button calls.
- Without a valid cookie:
  - `/portal/*` returns `401 {"error":"unauthorized","message":"A valid session is required."}`
  - pages return `302 Location: /login`
  - `/meters/{id}/__data.json` returns `200 {"type":"redirect","location":"/login"}`

## Endpoints

All responses are JSON. Paths are relative to the portal root.

| Endpoint | Used by | Returns |
|---|---|---|
| `GET /portal/meters/search?q=&page=` | Meters page | 20 meters per page, basic fields |
| `GET /portal/meters/{id}/geo` | Meter page | latitude and longitude |
| `GET /portal/meters/{id}/energy?from=&to=` | Meter page | register readings |
| `GET /portal/dts?page=` | Transformers page | 20 transformers per page |
| `GET /portal/keys` | Export button | signing secret |
| `GET /portal/export?page=` | Export button | all meters, full detail (signed) |
| `GET /meters/{id}/__data.json` | Meter page (SvelteKit server load) | nameplate and hierarchy |

### Meter search

```
GET /portal/meters/search?q=J10000&page=1
{"data":[{"meterId":"J100000","serialNo":"SE33962","make":"HPL","phaseType":"single",
          "installStatus":"Decommissioned","dtCode":"DT-001"}, ...],
 "total":10,"page":1,"pageSize":20}
```

- `q` matches a substring of meter ID or serial number, case-insensitive. It does not match make, status or DT.
- Page size is fixed at 20. `pageSize` and `limit` are ignored.
- `page=0`, `page=-1` and `page=abc` silently return page 1.

### Geo

```
GET /portal/meters/J100001/geo
{"data":{"latitude":"26.822136543835608","longitude":"75.90718190602279"}}
```

Coordinates are strings here but numbers (`lat`/`lng`) in the export. The values match.

### Energy

```
GET /portal/meters/J100001/energy?from=2026-06-01&to=2026-06-05
{"data":[{"timestamp":"01/06/2026 00:00","kwh":"42594.05","kvah":"46001.58","voltR":"231"}, ...]}
```

- `timestamp` is `DD/MM/YYYY HH:mm` with no time zone. I assume IST (+05:30), since the network is in Jaipur.
- `kwh` and `kvah` are **cumulative registers** (they only go up). Consumption is the difference between readings.
- All values are strings. A missing value is `""`.
- `from` and `to` are inclusive calendar dates in `YYYY-MM-DD`. They are the only parameters that work.
- **Invalid input is ignored rather than rejected.** `from=garbage`, `from=01/06/2026` and ISO datetimes all fall back to the default window, with HTTP 200.
- Default window (no params): the last 7 days of data the portal holds (`23/06/2026 23:30` to `30/06/2026 23:30`, 337 rows). It is not relative to today.
- `from` only: 7 days starting at `from`. `to` only: from the start of the data up to `to`. `from` after `to`: empty list.
- Data exists only for **1 to 30 June 2026**. Earlier or later ranges return an empty list.
- Unknown meter: `404 {"error":"not_found","message":"Meter not found"}`. IDs are case-sensitive (`j100001` is a 404).

### Transformers

```
GET /portal/dts?page=1
{"data":[{"code":"DT-001","name":"Malviya Nagar DT 1","feederCode":"F-001","capacityKva":100}, ...],
 "total":40,"page":1,"pageSize":20}
```

40 transformers over 2 pages. This list is clean and is the best source for transformer names and feeders.

### Bulk export (signed)

The Transformers page has an "Export all meters" button. Its code:

```js
const secret = (await (await fetch('/portal/keys')).json()).data.signingSecret;
const ts = String(Math.floor(Date.now() / 1000));
const msg = ['GET', '/portal/export', 'page=1', ts].join('\n');
const sig = hex(HMAC_SHA256(secret, msg));
fetch('/portal/export?page=1', { headers: { 'x-timestamp': ts, 'x-signature': sig } });
```

Response:

```json
{"data":[{"meterId":"J100000","serialNo":"SE33962","make":"HPL","phaseType":"single",
          "installStatus":"Decommissioned","installType":"Whole Current","build":"legacy",
          "dtCode":"DT-001",
          "hierarchy":{"zone":{"name":"Jaipur Zone 1","code":"Z-01"}, "circle":{...}, "division":{...},
                       "subdivision":{...}, "substation":{...}, "feeder":{...}, "dt":{...}},
          "geo":{"lat":26.9389,"lng":75.8309}}, ...],
 "total":403}
```

Notes:

- One call returns **all 403 meters**. `page` is ignored (page 2, no page, any page: same 403 rows). The UI only ever sends `page=1`.
- The signature covers method, path, raw query string and timestamp. A missing or wrong signature gives `401 {"error":"signature_invalid"}`.
- The timestamp is accepted within about 5 minutes either side of server time. -60s and +120s worked; -301s failed.
- The same signature can be replayed within that window.
- The secret is the same across calls and across sessions. Since any logged-in user can read it from `/portal/keys`, the signature acts as a speed bump, not access control.
- The export has everything the meter detail page has, plus `installType`, `build` and coordinates, and the data matched the search and geo endpoints for every meter I compared. **This is the endpoint the service uses for all meter metadata.**

### Meter detail page data

`GET /meters/{id}/__data.json` is SvelteKit's server load output in its compact "devalue" format (values are stored in a flat array and referenced by index). Once decoded:

```
{ meterId, detail, hierarchy: { "Zone": "Jaipur Zone 2 (Z-02)", ..., "DT": "Mansarovar DT 2 (DT-002)" } }
```

`detail` comes in two shapes depending on the meter's `build`:

- `legacy`: `{"data":[{"parameterName":"Serial No","parameterValue":"GE84132"}, ...]}`
- `v2`: `{"classData":"{\"installed_meter\":{\"MeterId\":\"J100004\",\"SerialNo\":\"SE65293\",...}}"}`, a JSON document encoded as a string, with PascalCase keys.

Hierarchy values are `"Name (CODE)"` strings. The service does not use this endpoint because the export already has the same data in a cleaner form.

## Rate limiting

- All `/portal/*` endpoints share one limit. `/login` and `/api/auth/*` are not limited.
- Measured: 119 sequential requests succeeded in about 8 seconds, then `429 {"error":"rate_limited","message":"Rate limit exceeded; slow down."}`. Requests worked again about 33 seconds after the first one. That fits a budget of about 120 requests per 30 second window.
- There is no `Retry-After` header and no rate limit headers.

## The data

### Meters

- 403 meters, `J100000` to `J100402`. IDs and serial numbers are unique.
- make: HPL 90, Genus 88, Secure 85, Allied 76, L&T 64
- status: Installed 238, Faulty 90, Decommissioned 75
- phase: single 277, three 126
- installType: Whole Current 205, CT Operated 198
- build: legacy 238, v2 165
- All coordinates fall around Jaipur (lat 26.79 to 27.04, lng 75.66 to 75.91).

### Hierarchy

Zone > Circle > Division > Subdivision > Substation > Feeder > Distribution Transformer (DT). Distinct codes: 3 zones, 6 circles, 10 divisions, 14 subdivisions, 19 substations, 29 feeders, 40 DTs.

## Quirks and data problems

1. **Missing codes.** Some hierarchy entries have a name but an empty code: circle (6 meters), substation (3), feeder (5).
2. **Missing names.** Some have a code but an empty name: circle (5), feeder (3).
   For both, name and code map 1:1 everywhere else, so the gap can be filled from other records.
3. **Stale transformer name.** `J100400`, `J100401` and `J100402` call `DT-007` "Old Malviya Nagar Xfmr"; the master list and the other 10 meters on DT-007 say "Sanganer DT 7". These three also have a `GN` serial prefix that no other meter uses, so they look like later additions.
4. **Codes reused under different parents.** Below zone level, the same code appears under several parents with similar meter counts each. For example, `D-01` sits under `C-01` (20 meters), `C-03` (10) and `C-05` (9), and `SD-01` under `D-01`, `D-05` and `D-09` (10 each). Majority voting cannot resolve this, so the service identifies a node by its full code path.
5. **Mixed reading intervals.** `J100000` to `J100039` report every 30 minutes (48 a day). Every other meter I sampled reports once a day at 00:00. The response does not say which.
6. **Duplicate empty rows.** Some daily meters (seen on `J100089` and `J100330`) end with a second `30/06/2026 00:00` row that has empty values.
7. **Decommissioned meters keep reporting.** Their registers keep rising through June.
8. **Serial prefixes do not match make.** For example, `J100003` is a Genus meter with serial `L&84997`.
9. **Silent fallbacks everywhere.** Bad `page` values become page 1 and bad dates become the default window, all with HTTP 200. A client cannot tell a typo from a real answer, so the service validates input itself and returns 400.
10. **Inconsistent types and names for the same data**: `latitude`/`longitude` strings on `/geo` but `lat`/`lng` numbers in the export, and `Sub Station` vs `substation` vs `SS-` codes.
