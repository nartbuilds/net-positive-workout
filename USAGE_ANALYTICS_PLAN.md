# Plan: App Usage Data Capture

## Context
There's currently no visibility into how the 4-person group uses the app — how
often each person opens it, at what time of day, and how long they stay. We want
to **capture** that data per-person into Firestore so it's available later for
the monthly/quarterly summaries the user produces at period end.

**Scope (confirmed with user): data capture only.** No live admin dashboard, no
report/export integration in this pass — those can be built later against the
captured data. This plan delivers just the tracking layer + storage.

Design constraints:
- **Cost-conscious backend.** The app already scopes reads to 90 days and uses
  rolling aggregates. A naive "one doc per open" event log would balloon writes.
  → **Store a daily aggregate per person.**
- **Browsers can't reliably signal "closed."** `pagehide`/`beforeunload` are
  best-effort, often missed on mobile. → **Best-effort duration** via
  `visibilitychange` + a periodic heartbeat flush; opens/times stay 100% reliable.

## Data model — new `analytics` collection
One doc per person per local day. Doc id `${dateStr}_${name}` (mirrors the
`completions` id convention; `dateStr` = the person's own local `getTodayStr()`,
so "opens per day" is in their own timezone).

```js
{
  date: "2026-06-19",            // YYYY-MM-DD, person's local day
  person: "Alice",
  sessions: [                    // ONE entry per open: timestamp + that session's duration, together
    { at: "2026-06-19T07:12:03+08:00", activeMs: 240000 },
    { at: "2026-06-19T09:01:55+08:00", activeMs: 605000 },
    { at: "2026-06-19T21:40:11+08:00", activeMs: 0      }   // still open / not yet flushed
  ],
  tzOffset: -480,
  device: "Mozilla/5.0 ...",     // navigator.userAgent.slice(0,80), like tokens
  updatedAt: "2026-06-19T21:40:11+08:00"
}
```

Each open is one `{ at, activeMs }` object — the open timestamp and how long that
specific session stayed active, kept together (not merged into a single total).
Opens count = `sessions.length`; total active time = sum of `activeMs`; first/last
open = `sessions[0].at` / `sessions.at(-1).at` — all derive from the array.

**Write strategy — in-memory array, seeded once per day.** Because each session's
`activeMs` grows over the session, `arrayUnion` can't be used (the object keeps
changing). Instead keep the day's array authoritative in memory and overwrite it:
- On the **first open of the day** (or first track after an app load), do a
  one-time `getDoc(doc(db,"analytics",docId))` to seed `_todaySessions` from any
  existing `sessions` (so an app reload mid-day doesn't clobber earlier opens).
  1 read/person/day — negligible.
- Mutate `_todaySessions` in memory (push new session / accrue `activeMs` on the
  current one), then `setDoc(doc(db,"analytics",docId), { sessions: _todaySessions,
  tzOffset, device, date, person, updatedAt }, { merge: true })` — same merge
  pattern as `settings`/`decrees` (`app.js:3625`, `app.js:1083`).
- **Caveat (accepted):** if one person uses two devices the same day, last-writer
  wins on the array (a device could overwrite the other's sessions). For this
  4-person, ~one-device-each group that's acceptable; noted rather than solved.

## Tracking logic (new self-contained block in `app.js`)
Module-scope state: `_todaySessions` (array, seeded from Firestore), `_todayDocId`,
`_currentSession` (ref to the open entry), `_sessionStartMs`, `_lastActivityMs`.

- **`recordOpen()`** (async) — called from:
  - `showApp()` (`app.js:4571`) on app entry after PIN verified.
  - the `visibilitychange` handler (`app.js:4701`) when becoming `visible`.

  If today's doc id changed (new day / first call this load) → `getDoc` to seed
  `_todaySessions`. Then if `Date.now() - _lastActivityMs > 30*60_000` (or no
  current session) → **new session**: push `_currentSession =
  { at: localISOString(new Date()), activeMs: 0 }` onto `_todaySessions` and write.
  Otherwise just resume the current session. Always reset `_sessionStartMs =
  Date.now()` and update `_lastActivityMs`.

- **`flushActiveTime()`** — `_currentSession.activeMs += Date.now() - _sessionStartMs`,
  `_sessionStartMs = Date.now()`, then write the full `_todaySessions` array.
  Called from:
  - `visibilitychange` becoming **hidden** (extend handler at `app.js:4701`,
    which today only handles the `visible` case).
  - new `window.addEventListener("pagehide", flushActiveTime)` (best-effort).
  - the existing **60s rollover `setInterval`** (`app.js:5098`) as a heartbeat —
    flush while visible so data survives a missed `pagehide`. **Reuse this loop;
    no new timer.**

- **Reuse:** `getTodayStr()` (`app.js:166`), `localISOString(new Date())`
  (`app.js:156`), `state.currentUser.name`/`.timezoneOffset`, `navigator.userAgent`.
- **Guards:** every fn early-returns if `!state.currentUser` (don't track
  auth/setup screens). Writes are fire-and-forget with `.catch(() => {})`, like
  `syncTimezoneOffset`.

## Firestore rules
Add to `firestore.rules` a block mirroring `settings`/`decrees`:
```
match /analytics/{docId} {
  allow read, write: if true;
}
```
**Must be published manually** (Firebase Console → Rules, or CLI) — repo has no
`firebase.json`; the file is a checked-in copy only. Until published, analytics
writes fail with "missing or insufficient permissions" (same caveat as `decrees`).

## Service worker
Bump cache in `sw.js:1`: `"netpve-v206"` → `"netpve-v207"` (required on any
frontend change, per project convention). Firestore URLs already bypass cache
(`sw.js:38–45`), so writes are unaffected.

## Free-tier cost check
Well within Firestore free tier (50k reads / 20k writes / day):
- **Reads:** one seed `getDoc` per person per day (≈4/day). Negligible.
- **Writes:** ~1 per open + 60s heartbeat flush *only while foregrounded with
  accumulated time*. Worst case a few hundred writes/day across 4 users — orders
  of magnitude under 20k. No paid APIs/deps/services.

## Files touched
- `app.js` — new tracking block + hooks in `showApp()`, the `visibilitychange`
  handler, the 60s `setInterval`, and a new `pagehide` listener. `getDoc`,
  `setDoc`, `doc` are already imported (`app.js:7–26`); no new imports needed.
- `firestore.rules` — `analytics` collection block (publish manually).
- `sw.js` — cache version bump.
- (post-impl) `memory/project_usage_analytics.md` + `MEMORY.md` pointer + bump
  the SW Cache memory line to v207.

## Verification
1. **Run locally**, log in as a participant. In Firebase console confirm
   `analytics/${today}_${name}` is created on open with one `sessions` entry
   `{ at, activeMs: 0 }`.
2. **New session:** hide the tab, reopen after 30+ min (or temporarily lower the
   gap constant) → a second `{ at, activeMs }` entry is appended to `sessions`.
3. **Duration:** keep foregrounded a few minutes, then hide → the current
   entry's `activeMs` grows; confirm the 60s heartbeat advances it without a
   clean close.
4. **Reload mid-day:** refresh the page, open again → confirm earlier `sessions`
   entries survive (seed `getDoc` worked) and a new entry is appended rather than
   the array being reset.
5. **Rules:** before publishing, confirm writes fail (permission error); after
   publishing, confirm they succeed.
6. Confirm no tracking writes occur on the auth/setup screens (logged out).
