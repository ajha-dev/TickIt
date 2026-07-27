import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { hapticUndo } from '../lib/haptics.ts'
import { enablePush, fetchVapidKey, notificationPermission, type PushOutcome, type VapidKey } from '../lib/push.ts'
import {
  deviceTimeZone,
  draftTimesMin,
  draftToCreate,
  draftToPatch,
  formatAfter,
  formatSchedule,
  minutesToTime,
  timeToMinutes,
  useCreateReminder,
  useDeleteReminder,
  useUpdateReminder,
  validateDraft,
  EVERY_DAY,
  ReminderApiError,
  type Reminder,
  type ReminderDraft,
  type ReminderKind,
} from '../lib/remindersApi.ts'
import { NumberBox, Section, TimeBox, Toggle } from './ReminderBits.tsx'
import { ScheduleFields } from './ScheduleFields.tsx'
import { Sheet, SheetButton } from './Sheet.tsx'
import type { Tracker } from '../types.ts'

/**
 * Set, edit, pause or remove a tracker's reminder.
 *
 * The contract has two kinds and they answer different questions, so the sheet
 * opens on a choice between them: **when it goes quiet** (`IDLE` — reactive,
 * the clock is reset by logging) or **at set times** (`SCHEDULE` — absolute,
 * fires whether or not anything was logged). One tracker holds one reminder of
 * one kind; they are alternatives, not layers, and switching kind here replaces
 * the reminder rather than adding to it.
 *
 * Everything it says about *when* a notification arrives is checked against
 * CONTRACT.md's firing rules. In particular quiet hours **hold** an idle period
 * rather than consuming it, and the copy says so — and quiet hours are absent
 * from the schedule kind entirely, not disabled, because a time you picked
 * yourself is not one the app gets to override.
 */

const PRESETS_MS = [
  30 * 60_000,
  60 * 60_000,
  2 * 3_600_000,
  3 * 3_600_000,
  4 * 3_600_000,
  6 * 3_600_000,
  8 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
]

const DEFAULT_AFTER_MS = 3 * 3_600_000
/** A first schedule that is already valid: every day, one morning dose. */
const DEFAULT_TIMES = ['09:00']

interface Props {
  open: boolean
  profileId: string
  tracker: Tracker | null
  reminder: Reminder | undefined
  onClose: () => void
}

export function ReminderEditor({ open, profileId, tracker, reminder, onClose }: Props) {
  const create = useCreateReminder(profileId)
  const update = useUpdateReminder(profileId)
  const remove = useDeleteReminder(profileId)

  const [kind, setKind] = useState<ReminderKind>('IDLE')
  const [hours, setHours] = useState('3')
  const [minutes, setMinutes] = useState('0')
  const [quietOn, setQuietOn] = useState(false)
  const [quietFrom, setQuietFrom] = useState('22:00')
  const [quietTo, setQuietTo] = useState('07:00')
  const [days, setDays] = useState<number[]>(EVERY_DAY)
  const [times, setTimes] = useState<string[]>(DEFAULT_TIMES)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState<'saving' | 'registering' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  /**
   * The VAPID key is fetched when the sheet *opens*, never on app load — and
   * fetching it prompts for nothing. It is in hand before Save is tapped so
   * `enablePush` can call `requestPermission()` as its first await, while the
   * tap's user activation is still live.
   */
  const keyQuery = useQuery({
    queryKey: ['push-key'],
    queryFn: fetchVapidKey,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  })
  const pushKey = keyQuery.data

  const trackerId = tracker?.id
  const reminderId = reminder?.id

  /**
   * Seed the form once per opening, not on every render of the reminders
   * query. Re-seeding on the query would clobber half-typed edits when the
   * list refetched, and — worse — would wipe the "saved, but it cannot be
   * delivered" message the instant the create it is reporting on landed.
   */
  const seededFor = useRef<string | null>(null)

  useEffect(() => {
    if (!open) {
      seededFor.current = null
      return
    }
    if (saved !== null) return
    const stamp = `${trackerId ?? ''}:${reminderId ?? ''}`
    if (seededFor.current === stamp) return
    seededFor.current = stamp

    setKind(reminder?.kind ?? 'IDLE')

    const after = reminder?.afterMs ?? DEFAULT_AFTER_MS
    const total = Math.round(after / 60_000)
    setHours(String(Math.floor(total / 60)))
    setMinutes(String(total % 60))
    const hasQuiet = reminder?.quietFromMin !== null && reminder?.quietFromMin !== undefined
    setQuietOn(Boolean(hasQuiet))
    setQuietFrom(minutesToTime(reminder?.quietFromMin ?? 22 * 60))
    setQuietTo(minutesToTime(reminder?.quietToMin ?? 7 * 60))

    // A reminder of the other kind carries no schedule, so the defaults stand
    // in — an empty day list would open on an unsaveable form.
    setDays(reminder?.days?.length ? [...reminder.days] : EVERY_DAY)
    setTimes(reminder?.timesMin?.length ? reminder.timesMin.map(minutesToTime) : DEFAULT_TIMES)

    setEnabled(reminder?.enabled ?? true)
    setBusy(null)
    setSaveError(null)
    setSaved(null)
  }, [open, trackerId, reminderId, reminder, saved])

  const afterMs = useMemo(() => {
    const h = Number(hours === '' ? '0' : hours)
    const m = Number(minutes === '' ? '0' : minutes)
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null
    if (hours === '' && minutes === '') return null
    return Math.round(h * 3_600_000 + m * 60_000)
  }, [hours, minutes])

  const fromMin = timeToMinutes(quietFrom)
  const toMin = timeToMinutes(quietTo)

  /**
   * One draft, discriminated on the kind that is actually selected. The fields
   * of the *other* kind stay in React state so a mis-tap on the switch does not
   * lose a half-typed threshold, but they are unreachable from here — which is
   * what guarantees a stale `afterMs` can never be sent alongside a schedule.
   */
  const draft: ReminderDraft =
    kind === 'SCHEDULE'
      ? { kind: 'SCHEDULE', days, times }
      : { kind: 'IDLE', afterMs, quietOn, quietFromMin: fromMin, quietToMin: toMin }

  const validation = validateDraft(draft)
  const problem = saveError ?? validation

  const setPreset = (ms: number) => {
    const total = Math.round(ms / 60_000)
    setHours(String(Math.floor(total / 60)))
    setMinutes(String(total % 60))
    setSaveError(null)
  }

  const onSave = () => {
    if (validation || busy || !tracker) return
    setBusy('saving')
    setSaveError(null)

    // Started synchronously inside the tap, so `requestPermission()` still has
    // the gesture's activation — but deliberately NOT awaited before the save.
    // Negotiating a subscription with the push service takes seconds; the
    // reminder must not wait on it, and nothing here can fail the save. Push is
    // delivery, the reminder is the record.
    const pushAttempt: Promise<PushOutcome | null> =
      pushKey?.kind === 'ok' ? enablePush(pushKey.publicKey) : Promise.resolve(null)

    void (async () => {
      try {
        // timeZone is refreshed on every edit — a phone that crossed a border
        // must not keep resolving 09:00 in the old zone.
        const timeZone = deviceTimeZone()

        if (reminder) {
          // The patch carries the kind and only that kind's fields. On a switch
          // the server clears the other half and resets `lastFiredAt`; the
          // client's job is simply never to send the half it is leaving.
          await update.mutateAsync({
            id: reminder.id,
            patch: draftToPatch(draft, timeZone, enabled),
          })
        } else {
          await create.mutateAsync(draftToCreate(tracker.id, draft, timeZone))
        }
      } catch (err) {
        setBusy(null)
        setSaveError(messageForError(err))
        void pushAttempt
        return
      }

      // Saved. What is left is finding out whether it can actually be
      // delivered to this device, which is worth a second of "registering".
      setBusy('registering')
      const outcome = await pushAttempt
      setBusy(null)
      const warning = deliveryWarning(pushKey, outcome)
      if (warning) setSaved(warning)
      else onClose()
    })()
  }

  const onRemove = () => {
    if (!reminder || busy) return
    hapticUndo()
    setBusy('saving')
    void remove
      .mutateAsync(reminder.id)
      .then(() => onClose())
      .catch((err: unknown) => setSaveError(messageForError(err)))
      .finally(() => setBusy(null))
  }

  const name = tracker?.name ?? ''
  const preview = summarise(draft, validation)

  /* -------------------------------------------------------------- saved -- */

  if (saved) {
    return (
      <Sheet open={open} onClose={onClose} eyebrow="saved" title={name} body={saved}>
        <SheetButton tone="primary" onClick={onClose}>
          Done
        </SheetButton>
      </Sheet>
    )
  }

  /* --------------------------------------------------------------- edit -- */

  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow={reminder ? 'edit reminder' : 'new reminder'}
      title={name}
      body={
        kind === 'SCHEDULE' ? (
          <>
            Notifies you at the times below, on the days you pick — whether or not{' '}
            {name || 'this tracker'} has been logged. Logging changes nothing:{' '}
            <strong className="text-text">the clock is the calendar</strong>, not the last entry.
          </>
        ) : (
          <>
            Notifies you when nothing has been logged on {name || 'this tracker'} for the time
            below. Logging resets the clock, and you get{' '}
            <strong className="text-text">one</strong> notification per quiet stretch — it will not
            repeat until you log again.
          </>
        )
      }
    >
      <PushBanner state={pushKey} loading={keyQuery.isPending && open} />

      <KindPicker
        value={kind}
        onChange={(next) => {
          setKind(next)
          setSaveError(null)
        }}
      />

      {kind === 'SCHEDULE' ? (
        /* Quiet hours are deliberately not rendered at all here. */
        <ScheduleFields
          days={days}
          onDays={(next) => {
            setDays(next)
            setSaveError(null)
          }}
          times={times}
          onTimes={(next) => {
            setTimes(next)
            setSaveError(null)
          }}
        />
      ) : (
        <>
          {/* -------------------------------------------------- threshold -- */}
          <Section label="quiet for">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS_MS.map((ms) => {
                const selected = afterMs === ms
                return (
                  <button
                    key={ms}
                    type="button"
                    onClick={() => setPreset(ms)}
                    aria-pressed={selected}
                    className={`tap digits h-10 min-w-[52px] rounded-xl border px-3 text-[14px] ${
                      selected
                        ? 'border-mauve/55 bg-mauve/12 text-text'
                        : 'border-ink-600 bg-ink-700 text-text-dim'
                    }`}
                  >
                    {formatAfter(ms)}
                  </button>
                )
              })}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <NumberBox label="hours" value={hours} onChange={setHours} max={2} />
              <NumberBox label="minutes" value={minutes} onChange={setMinutes} max={2} />
              <p className="min-w-0 flex-1 text-[13px] leading-tight text-text-dim">
                5 minutes to 48 hours.
              </p>
            </div>
          </Section>

          {/* ------------------------------------------------ quiet hours -- */}
          <Section label="quiet hours">
            <Toggle
              checked={quietOn}
              onChange={(next) => {
                // Both ends or neither — the toggle is what makes a half-window
                // impossible to express in the first place.
                setQuietOn(next)
                setSaveError(null)
              }}
              label={quietOn ? 'Holding overnight' : 'Off — can arrive at any hour'}
            />

            {quietOn ? (
              <>
                <div className="mt-3 flex items-end gap-2.5">
                  <TimeBox
                    label="from"
                    ariaLabel="Quiet hours from"
                    value={quietFrom}
                    onChange={setQuietFrom}
                  />
                  <span aria-hidden className="pb-4 text-text-dim">
                    →
                  </span>
                  <TimeBox
                    label="to"
                    ariaLabel="Quiet hours to"
                    value={quietTo}
                    onChange={setQuietTo}
                  />
                </div>
                <p className="mt-3 text-[13px] leading-snug text-text-dim">
                  A reminder that comes due inside this window is{' '}
                  <strong className="font-medium text-text">held, not cancelled</strong>. It arrives
                  once at {displayTime(quietTo)}, and says how long it has actually been by then.
                </p>
              </>
            ) : null}
          </Section>
        </>
      )}

      {/* --------------------------------------------------------- paused -- */}
      {reminder ? (
        <Section label="status">
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label={enabled ? 'On' : 'Paused — nothing is sent while this is off'}
          />
          {reminder.lastFiredAt !== null ? (
            <p className="mt-3 text-[13px] leading-snug text-text-dim">
              Last notified {new Date(reminder.lastFiredAt).toLocaleString()}.
            </p>
          ) : null}
          {reminder.kind !== kind ? (
            <p className="mt-3 text-[13px] leading-snug text-text-dim">
              Saving replaces the{' '}
              {reminder.kind === 'SCHEDULE' ? 'schedule' : 'idle threshold'} with this — a reminder
              is one kind or the other.
            </p>
          ) : null}
        </Section>
      ) : null}

      {problem ? (
        <p role="alert" className="text-[14px] leading-snug text-ember">
          {problem}
        </p>
      ) : null}

      <SheetButton
        tone="primary"
        onClick={onSave}
        disabled={Boolean(validation) || busy !== null}
      >
        {busy === 'saving'
          ? 'Saving…'
          : busy === 'registering'
            ? 'Saved — registering this device…'
            : reminder
              ? `Save — ${preview}`
              : kind === 'SCHEDULE'
                ? `Remind me at ${preview}`
                : `Remind me after ${preview}`}
      </SheetButton>

      {reminder ? (
        <SheetButton tone="quiet" onClick={onRemove} disabled={busy !== null}>
          <span className="text-ember">Remove reminder</span>
        </SheetButton>
      ) : null}
    </Sheet>
  )
}

/* ------------------------------------------------------------------ bits -- */

const KIND_COPY: Record<ReminderKind, { label: string; hint: string }> = {
  // Named for what they do, not for the enum. Nobody sets an "IDLE reminder".
  IDLE: { label: 'When it goes quiet', hint: 'Nothing logged for a while' },
  SCHEDULE: { label: 'At set times', hint: 'Days and times you choose' },
}

function KindPicker({
  value,
  onChange,
}: {
  value: ReminderKind
  onChange: (next: ReminderKind) => void
}) {
  return (
    <div role="radiogroup" aria-label="Reminder kind" className="grid grid-cols-2 gap-2.5">
      {(['IDLE', 'SCHEDULE'] as const).map((kind) => {
        const selected = value === kind
        const copy = KIND_COPY[kind]
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(kind)}
            className={`tap flex min-h-[86px] flex-col justify-between rounded-2xl border p-3.5 text-left ${
              selected ? 'border-mauve/55 bg-mauve/10' : 'border-ink-600 bg-ink-700 text-text-dim'
            }`}
          >
            {/* A gap that grows, versus three beats at equal spacing. */}
            <span aria-hidden className="flex items-center gap-[5px]">
              {kind === 'IDLE' ? (
                <span
                  className={`h-[3px] w-5 rounded-full ${selected ? 'bg-mauve/60' : 'bg-text-dim/60'}`}
                />
              ) : null}
              {[0, 1, 2].slice(0, kind === 'IDLE' ? 1 : 3).map((i) => (
                <span
                  key={i}
                  className={`size-[7px] rounded-full ${selected ? 'bg-mauve' : 'bg-text-dim'}`}
                />
              ))}
            </span>
            <span className="mt-3 block">
              <span
                className={`block text-[17px] font-semibold tracking-[-0.02em] ${selected ? 'text-text' : ''}`}
              >
                {copy.label}
              </span>
              <span className="mt-0.5 block text-[12px] leading-tight text-text-dim">
                {copy.hint}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The save button's tail. Kept short — a full "9:00 AM, 12:00 PM, 3:00 PM…"
 * would wrap a 60px button into three lines on a 390px screen.
 */
function summarise(draft: ReminderDraft, invalid: string | null): string {
  if (invalid) return '…'
  if (draft.kind === 'SCHEDULE') {
    // The same collapsing the drawer row uses — a spelled-out "9:00 AM, 12:00
    // PM, 3:00 PM…" wraps a 60px button into three lines at 390px.
    return formatSchedule(draftTimesMin(draft.times), draft.days, ', ')
  }
  return formatAfter(draft.afterMs ?? 0)
}

/**
 * `HH:MM` in the user's own clock convention, so the sentence under the control
 * reads the same way the control does — 12-hour locales must not be told
 * "arrives at 07:00" next to a field showing "7:00 AM".
 */
function displayTime(value: string): string {
  const minutes = timeToMinutes(value)
  if (minutes === null) return value
  const d = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * What the server can and cannot do, said before the user commits to anything.
 * A 503 here is the operator not having set VAPID keys — an ordinary state, not
 * a bug, and never a reason to show a broken permission prompt.
 */
function PushBanner({ state, loading }: { state: VapidKey | undefined; loading: boolean }) {
  if (loading || !state) return null

  const permission = notificationPermission()

  let message: string | null = null
  if (state.kind === 'not-configured') {
    message =
      'Push is not set up on this server, so a reminder cannot be delivered yet. You can still save one — it will start working the moment the operator adds push keys.'
  } else if (state.kind === 'unsupported') {
    message =
      'This browser cannot receive push notifications. The reminder will be saved and stays visible here, but nothing can be delivered to this device.'
  } else if (state.kind === 'error') {
    message = 'Could not check whether push is set up on the server. The reminder will still save.'
  } else if (permission === 'denied') {
    message =
      'Notifications are blocked for this site, so nothing can be delivered to this device. Allow them in your browser settings to start receiving reminders.'
  }

  if (!message) return null

  return (
    <p className="rounded-2xl border border-ink-600 bg-ink-850 p-3.5 text-[14px] leading-snug text-text-dim">
      {message}
    </p>
  )
}

function deliveryWarning(key: VapidKey | undefined, outcome: PushOutcome | null): string | null {
  if (!key || key.kind === 'error') {
    return 'Saved. This device could not confirm push delivery with the server, so a notification is not guaranteed.'
  }
  if (key.kind === 'not-configured') {
    return 'Saved. Push is not set up on this server, so nothing can be delivered yet — the reminder starts working as soon as push keys are configured.'
  }
  if (key.kind === 'unsupported') {
    return 'Saved. This browser cannot receive push, so the reminder is recorded but cannot reach you here.'
  }

  switch (outcome?.kind) {
    case 'subscribed':
    case undefined:
      return null
    case 'denied':
      return 'Saved. Notifications are blocked for this site, so it cannot be delivered to this device. Allow notifications in your browser settings, then save again.'
    case 'dismissed':
      return 'Saved. The notification prompt was dismissed, so nothing can be delivered yet. Save again to be asked once more.'
    case 'no-service-worker':
      return 'Saved. This device has no active service worker, so push cannot be registered — that needs the installed app (Home Screen on iOS) over HTTPS or localhost.'
    case 'error':
      return `Saved. This device could not be registered for push: ${outcome.message}`
    default:
      return null
  }
}

const CODE_COPY: Record<string, string> = {
  NETWORK: 'Could not reach the server. Nothing was saved.',
  REMINDER_EXISTS: 'This tracker already has a reminder.',
  TRACKER_NOT_FOUND: 'That tracker no longer exists.',
  AFTER_MS_OUT_OF_RANGE: 'The idle time must be between 5 minutes and 48 hours.',
  BAD_QUIET_HOURS: 'Quiet hours must start and end at different times.',
  QUIET_HOURS_INCOMPLETE: 'Quiet hours need both a start and an end.',
  BAD_TIME_ZONE: "This device's time zone was not recognised by the server.",
  NOT_FOUND: 'That reminder no longer exists.',
  DAYS_REQUIRED: 'Pick at least one day.',
  TIMES_REQUIRED: 'Add at least one time.',
  TOO_MANY_TIMES: 'A schedule holds at most 8 times.',
  TOO_MANY_DAYS: 'A schedule holds at most 7 days.',
  DUPLICATE_TIMES: 'The same time is on the list twice.',
  DUPLICATE_DAYS: 'The same day is selected twice.',
  BAD_TIME: 'One of those times is not a real time of day.',
  BAD_DAY: 'One of those days is not a real day of the week.',
  // These four mean the client sent a field belonging to the other kind — a
  // bug here, not a user mistake, so the copy says what the user can do.
  QUIET_HOURS_NOT_ALLOWED: 'Quiet hours do not apply to a set-times reminder.',
  AFTER_MS_NOT_ALLOWED: 'An idle time does not apply to a set-times reminder.',
  DAYS_NOT_ALLOWED: 'Days do not apply to a goes-quiet reminder.',
  TIMES_NOT_ALLOWED: 'Times do not apply to a goes-quiet reminder.',
}

function messageForError(err: unknown): string {
  if (err instanceof ReminderApiError) {
    return CODE_COPY[err.code] ?? `The server refused that (${err.code}).`
  }
  return 'That could not be saved.'
}
