# Reflection

## What assumptions did you make?

The portal sends timestamps like `24/06/2026 00:30` with no time zone. Every location in the data is in Jaipur, so I assumed IST (+05:30) and made it configurable instead of baking it in. I treated `kwh` and `kvah` as cumulative registers, because they only ever go up; that means consumption has to be worked out as the gap between two readings.

For meter data I used the bulk export as the source of truth, but only after spot-checking it against the search and geo endpoints and finding zero differences. Transformer names come from the `/portal/dts` master list, since it was clean and only three meter records disagreed with it. I also assumed a meter list up to 10 minutes old is fine for an ops lookup tool, because installs and status changes don't happen by the second. The full list is in the README.

## Which part was the most difficult, and how did you get unstuck?

The network hierarchy. When I first profiled the export, I saw `D-01` sitting under three different circles. My first reaction was "this is the messy data they warned about, pick the most common parent and move on". Before writing that, I counted meters for every child and parent pair. The splits were close to even (often exactly 10/10/10), so there was no majority to vote for.

That changed the design. A node is now identified by its full code path rather than its code, and the reuse shows up in `/v1/data-quality` instead of being quietly "fixed". The genuinely broken records turned out to be a much smaller set: empty codes, empty names, and one stale transformer name. Those could be repaired from other records, because names and codes map 1:1 everywhere else.

The export signature also had me stuck for a bit. My first signed request, from a bash script, came back `401 signature_invalid`. Rather than keep guessing at the format, I went back to the Transformers page bundle, which has the signing code in about ten lines. I rewrote the request in Node exactly the same way, and it worked first time. I never fully pinned down why the shell version failed (most likely how the values were passed between commands), but moving to Node took the shell out of the picture.

## If you had another day, what would you improve?

Readings. Right now the API can only answer questions about one meter at a time. The portal has no bulk path for readings, and fetching all 403 meters burns more than two minutes of rate budget.

With another day, I'd run a background job that pulls every meter's readings into SQLite while staying under the limit, then answer the interesting questions from there:
- load per transformer and per feeder
- decommissioned meters that are still consuming
- meters whose usage suddenly jumps

After that, I'd build a small web client: a map coloured by status, a hierarchy browser, and consumption charts.

## What mistake did you make while solving this?

While exploring, I wrote a quick loop to pull June readings for all 403 meters, one after another, with no backoff. It hit the rate limit after about 120 requests, and the remaining 283 calls failed straight away with 429s.

Just before that, I had also misread what I was seeing. After the first few meters, every response had 30 rows instead of 1440, and I assumed the portal was throttling me with partial data. Re-fetching a meter that had already returned 1440 rows showed it still did. The 30-row meters simply report once a day.

So that was two mistakes back to back:
- I acted on a theory without checking it against something I already knew.
- I treated the rate limit as something to handle later, not from the first request.

Two smaller ones showed up while building:
- **Double wait on 429.** My first 429 handling slept inside the client and also paused the shared throttle, so two separate wait mechanisms were handling the same retry. A unit test caught it.
- **Silent startup failure.** Express 5 passes startup errors to the `listen` callback, and mine ignored them. When port 3000 was already taken, the server printed "listening" and then quietly exited. I only noticed because a smoke test returned data with an old timestamp, which meant it was coming from a previous run that was still alive.

## If you were reviewing your own submission, what would you criticise?

- **The hierarchy call is a judgment, not a fact.** If those codes are meant to be globally unique and the portal's data is simply wrong, then my path-based tree presents a data bug as structure. I'd want to check with someone at the utility before anyone builds on it.
- **Some things are sampled or assumed.**
  - The half-hourly versus daily split comes from a sample, since I didn't pull readings for every meter.
  - The IST time zone was never confirmed.
  - Numbers like the 92-day range cap and the 15-minute cache are reasonable picks, not values measured against real usage.
- **Tests run on recorded fixtures.** A change on the portal side would only show up at runtime as `upstream_contract_changed`, not in CI.
- **Status, phase and installation type are plain strings, not enums.** That keeps an unknown value from breaking anything, but gives client code generators less to work with.
- **No cross-meter analytics and no web client.** Both were deliberate cuts, but that's where most of the value for a product team would be.
