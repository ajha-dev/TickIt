import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { hapticUndo } from '../lib/haptics.ts'
import { enablePush, fetchVapidKey, notificationPermission, type PushOutcome, type VapidKey } from '../lib/push.ts'
import {
  deviceTimeZone,
  formatAfter,
  minutesToTime,
  timeToMinutes,
  useCreateReminder,
  useDeleteReminder,
  useUpdateReminder,
  validateDraft,
  ReminderApiError,
  type Reminder,
} from '../lib/remindersApi.ts'
import { Sheet, SheetButton } from './Sheet.tsx'
import type { Tracker } from '../types.ts'

/**
 * Set, edit, pause or remove a tracker's idle reminder.
 *
 * The contract has exactly one kind — "nothing logged on this tracker for N
 * hours", at most one per tracker — so this sheet has exactly one shape and no
 * type picker. Everything it says about *when* a notification arrives is
 * checked against CONTRACT.md's firing rules; in particular quiet hours **hold**
 * an idle period rather than consuming it, and the copy says so.
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

  const [hours, setHours] = useState('3')
  const [minutes, setMinutes] = useState('0')
  const [quietOn, setQuietOn] = useState(false)
  const [quietFrom, setQuietFrom] = useState('22:00')
  const [quietTo, setQuietTo] = useState('07:00')
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

    const after = reminder?.afterMs ?? DEFAULT_AFTER_MS
    const total = Math.round(after / 60_000)
    setHours(String(Math.floor(total / 60)))
    setMinutes(String(total % 60))
    const hasQuiet = reminder?.quietFromMin !== null && reminder?.quietFromMin !== undefined
    setQuietOn(Boolean(hasQuiet))
    setQuietFrom(minutesToTime(reminder?.quietFromMin ?? 22 * 60))
    setQuietTo(minutesToTime(reminder?.quietToMin ?? 7 * 60))
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

  const validation = validateDraft({
    afterMs,
    quietOn,
    quietFromMin: fromMin,
    quietToMin: toMin,
  })
  const problem = saveError ?? validation

  const setPreset = (ms: number) => {
    const total = Math.round(ms / 60_000)
    setHours(String(Math.floor(total / 60)))
    setMinutes(String(total % 60))
    setSaveError(null)
  }

  const onSave = () => {
    if (validation || busy || !tracker || afterMs === null) return
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
        const timeZone = deviceTimeZone()
        const quietFromMin = quietOn ? fromMin : null
        const quietToMin = quietOn ? toMin : null

        if (reminder) {
          // timeZone is refreshed on every edit — a phone that crossed a border
          // must not keep evaluating quiet hours in the old zone.
          await update.mutateAsync({
            id: reminder.id,
            patch: { afterMs, quietFromMin, quietToMin, timeZone, enabled },
          })
        } else {
          await create.mutateAsync({
            trackerId: tracker.id,
            afterMs,
            quietFromMin,
            quietToMin,
            timeZone,
          })
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
  const preview = afterMs !== null && !validation ? formatAfter(afterMs) : null

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
        <>
          Notifies you when nothing has been logged on {name || 'this tracker'} for the time below.
          Logging resets the clock, and you get <strong className="text-text">one</strong>{' '}
          notification per quiet stretch — it will not repeat until you log again.
        </>
      }
    >
      <PushBanner state={pushKey} loading={keyQuery.isPending && open} />

      {/* ------------------------------------------------------ threshold -- */}
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

      {/* ---------------------------------------------------- quiet hours -- */}
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
              <TimeBox label="from" value={quietFrom} onChange={setQuietFrom} />
              <span aria-hidden className="pb-4 text-text-dim">
                →
              </span>
              <TimeBox label="to" value={quietTo} onChange={setQuietTo} />
            </div>
            <p className="mt-3 text-[13px] leading-snug text-text-dim">
              A reminder that comes due inside this window is{' '}
              <strong className="font-medium text-text">held, not cancelled</strong>. It arrives
              once at {displayTime(quietTo)}, and says how long it has actually been by then.
            </p>
          </>
        ) : null}
      </Section>

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
              ? `Save — quiet for ${preview ?? '…'}`
              : `Remind me after ${preview ?? '…'}`}
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

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-ink-600 bg-ink-700/45 p-3.5">
      <p className="stencil mb-3">{label}</p>
      {children}
    </div>
  )
}

function NumberBox({
  label,
  value,
  onChange,
  max,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  max: number
}) {
  return (
    <label className="flex h-[52px] shrink-0 items-center gap-1.5 rounded-xl border border-ink-600 bg-ink-800 px-2.5 focus-within:border-periwinkle">
      <input
        aria-label={label}
        value={value}
        inputMode="numeric"
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, max))}
        className="digits w-[3.2ch] bg-transparent text-center text-[17px] outline-none"
      />
      <span className="stencil">{label === 'hours' ? 'h' : 'm'}</span>
    </label>
  )
}

function TimeBox({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (next: string) => void
}) {
  // The label sits above rather than inside: a native time control renders
  // "10:00 PM" plus a picker glyph in the user's locale, and sharing one row
  // with a label clips it at 390px.
  return (
    <label className="min-w-0 flex-1">
      <span className="stencil mb-1.5 block">{label}</span>
      <span className="flex h-[52px] items-center rounded-xl border border-ink-600 bg-ink-800 px-3 focus-within:border-periwinkle">
        <input
          type="time"
          aria-label={`Quiet hours ${label}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full min-w-0 bg-transparent text-[16px] tracking-[-0.01em] outline-none"
        />
      </span>
    </label>
  )
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

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="tap flex min-h-[44px] w-full items-center gap-3 text-left"
    >
      <span
        aria-hidden
        className={`flex h-[28px] w-[48px] shrink-0 items-center rounded-full border p-[3px] transition-colors ${
          checked ? 'justify-end border-mauve/60 bg-mauve/25' : 'justify-start border-ink-600 bg-ink-800'
        }`}
      >
        <span
          className={`block size-[20px] rounded-full ${checked ? 'bg-mauve' : 'bg-text-dim'}`}
        />
      </span>
      <span className="min-w-0 flex-1 text-[15px] leading-snug text-text-dim">{label}</span>
    </button>
  )
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
}

function messageForError(err: unknown): string {
  if (err instanceof ReminderApiError) {
    return CODE_COPY[err.code] ?? `The server refused that (${err.code}).`
  }
  return 'That could not be saved.'
}
