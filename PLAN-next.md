# Next: archived events, an All chart, and the vanishing running span

Three changes. The third has no confirmed root cause yet — that is stated
plainly below rather than papered over with a fix that might miss.

---

## 1. Hide archived trackers' events from the Timeline

Archiving a tracker removes it from the Log grid but its events still fill the
Timeline, so a tracker you deliberately put away keeps taking up the screen.

**Change.** `client/src/screens/Timeline.tsx` already builds a `trackerById`
map. Filter the day's events to those whose tracker is not archived. Below the
list, when any were hidden, a quiet button: **"Show 4 archived"** — toggling
reveals them for that session, styled dimmed so they read as set-aside rather
than current.

**Details that matter**

- The day's entry count in the header must describe what is *shown*, or the
  count and the list disagree. When something is hidden, say so: `3 entries ·
  4 archived`.
- The toggle is view state, not a preference — it resets when you leave the
  screen. A hidden-data switch that silently persists is how you end up
  mistrusting the log.
- An event whose tracker was *deleted* cannot appear here; deletion cascades
  the events away. Only archived ones are affected.
- Empty-day copy needs a third case: nothing logged, versus everything logged
  that day was archived. "Nothing on this day" would be a lie in the second.

**Files**: `Timeline.tsx` only.

---

## 2. Dashboard: an "All" chart

Today the Dashboard charts exactly one tracker, and `Dashboard.tsx`'s own
header comment argues that overlaying trackers "turns a legible raster into
confetti". You have asked for the overlay anyway, so this deliberately
overrides that — and the comment gets rewritten rather than left contradicting
the code.

**Change.** Add **All** at the top of the tracker picker. It draws every
non-archived tracker's events on one 24-hour raster, each mark in its own
tracker's colour, with the legend listing trackers and their counts.

**The honest problem, and what I will do about it**

The Personal profile has 14 trackers; the palette has 8 colours that stay
apart for every reader. Some trackers *will* share a hue. Rather than pretend
otherwise:

- The legend is the key, and it lists every tracker with its colour and count —
  so a shared colour is at least visible there.
- Where two trackers in view share a colour, say so in one quiet line under the
  legend. Same principle as the Choice-options overflow already added: declining
  to imply a distinction the colours cannot carry.
- Marks get slight transparency so overlaps read as denser rather than hiding
  each other. On a busy day, density is the signal.
- Archived trackers are excluded — consistent with change 1.

**Reuse, do not rebuild.** `lib/stats.ts`'s `splitAcrossDays` / `columnsFor`
already handle midnight-crossing and zero-length marks; `Actogram.tsx` already
renders a `Map<day, DayMark[]>`. "All" is a different *selection* feeding the
same pipeline, plus a colour function keyed on `event.trackerId` rather than on
a field value. `lib/series.ts` gains an all-trackers scheme beside the existing
per-field one.

**Files**: `screens/Dashboard.tsx`, `lib/series.ts`, `lib/chartTracker.ts`
(remember "All" as a selection), `components/Actogram.tsx` (legend only).

---

## 3. The running span that disappears from the Log

**I have not reproduced your case and will not pretend otherwise.** You
confirmed the phone was connected, which rules out the mechanism I did
reproduce. What I have ruled out, by testing rather than reading:

| Hypothesis | Result |
|---|---|
| Cold reload with a synced running span | Works — Log shows "1 running" and the card |
| Archived tracker hides the running card | Not filtered; the card would still render |
| The app cannot open offline | It opens; it shows the honest "no connection" splash |
| Started offline, restarted before sync | **Reproduced** — but needs a disconnected phone |

**What I will change, and why each stands on its own merit**

1. **The running strip has no loading state.** `running = runningQuery.data ??
   []` renders "nothing running" while the fetch is in flight, and the header
   says `ready`. Over a tailnet on a cold start that window is visible, and it
   is indistinguishable from "your span is gone". A pending running query
   should say so. *This is my leading candidate for what you saw.*
2. **Rebuild running spans from the outbox on startup.** A span whose create
   has not yet reached the server exists only in the queue; its optimistic pin
   dies with the page. This is the case I did reproduce.
3. **Refetch running on `visibilitychange`, not only on `focus`.** An installed
   PWA resumed from background does not reliably fire `focus` on iOS, so a
   resumed app can sit on stale data until the 60s interval fires.

Together these cover every mechanism I can construct for the symptom. If it
recurs after this, the next step is instrumentation rather than more guessing:
log what `/events/running` returned and when, so the next occurrence is
evidence instead of a description.

**Files**: `lib/queries.ts` (`useRunning`), `screens/Home.tsx` (loading state),
`lib/outbox.ts` (expose queued running spans).

---

## Verification

- **Archived**: archive a tracker with events; its rows leave the Timeline and
  the count matches the list; the toggle reveals them dimmed; the toggle resets
  on navigation; a day containing only archived events says so.
- **All**: renders every non-archived tracker on one raster; the legend counts
  match the per-tracker charts; a midnight-crossing span still splits; picking a
  single tracker still behaves exactly as today; the shared-colour notice
  appears only when two visible trackers collide.
- **Running**: with the API artificially slowed, the Log says it is loading
  rather than showing an empty strip; a span started offline still pins after a
  restart and syncs on reconnect; a backgrounded PWA resumed after several
  minutes shows the running span without waiting for the 60s poll.
- `npm run typecheck`, `npm run build`, and 390×844 with zero console errors on
  Log, Timeline and Dashboard.
