# Usage Analytics — App Open Capture (as built)

## Context
There was no visibility into how the group uses the app. This captures **when
each person opens the app**, per person per local day, into Firestore for the
monthly/quarterly summaries produced at period end.

**Scope: capture only.** No dashboard/export, and — per the final decision —
**no duration tracking**. Just the timestamp of every open. Reporting can be
built later against the captured data.

## Data model — `analytics` collection
One doc per person per local day. Doc id `${dateStr}_${name}` (`dateStr` = the
person's own local `getTodayStr()`, like `completions`).

```js
{
  date: "2026-06-19",                 // person's local day
  person: "Alice",
  tzOffset: -480,
  device: "Mozilla/5.0 ...",          // navigator.userAgent.slice(0,80)
  updatedAt: "2026-06-19T21:40:11+08:00",
  openTimes: [                        // one local-ISO timestamp per open
    "2026-06-19T07:12:03+08:00",
    "2026-06-19T09:01:55+08:00",
    "2026-06-19T21:40:11+08:00"
  ]
}
```
Opens count = `openTimes.length`; first/last open = `openTimes[0]` /
`openTimes.at(-1)`.

**Write strategy:** append-only via `arrayUnion(localISOString(new Date()))` —
**no read, no read-modify-write**. (Possible because we no longer track a value
that mutates over the session.) `setDoc(..., { merge: true })`, fire-and-forget.

## Tracking logic (`app.js`)
- `recordUsageOpen()` (just above `showApp()`): early-returns if `!db ||
  !state.currentUser`. De-dupes via `_lastUsageOpenMs` / `_lastUsageDay` — a
  re-focus within 30 min on the same day is one session and isn't re-logged.
- Called from `showApp()` (app entry) and the `visibilitychange`→visible handler.
- `arrayUnion` added to the firestore import block.

## Firestore rules
`firestore.rules` has an open `analytics/{docId}` read/write block (mirrors
`decrees`/`settings`). **Must be published manually** (Firebase Console → Rules,
or CLI) — repo has no `firebase.json`, so the file is a checked-in copy only.
Until published, analytics writes fail with "missing or insufficient
permissions"; the rest of the app is unaffected.

## Service worker
SW cache bumped to `netpve-v208`.

## Cost
0 reads, ~1 write per open (de-duped to one per 30-min session). Trivially under
the free tier (20k writes/day).

## Not done (future)
- Duration / session-length tracking (deliberately skipped).
- Dashboard / recap-report / CSV export against the captured data.

## Verification
1. Run locally, log in. Confirm `analytics/${today}_${name}` is created on open
   with one `openTimes` timestamp.
2. Hide the tab and re-focus within 30 min → no new entry (same session). After
   30+ min (or lower the gap constant) → a second timestamp appends.
3. Reload mid-day → a new open appends to the existing array (arrayUnion merge),
   earlier entries preserved.
4. Rules: before publishing, writes fail (permission error); after publishing,
   they succeed.
5. Confirm no writes occur while logged out (auth/setup screens).
