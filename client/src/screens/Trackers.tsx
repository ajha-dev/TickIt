import { useQuery } from '@tanstack/react-query'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { previewTrackerDelete } from '../api.ts'
import { FieldEditor } from '../components/FieldEditor.tsx'
import { ColourPicker, TextField } from '../components/Form.tsx'
import { ReminderEditor } from '../components/ReminderEditor.tsx'
import { Sheet, SheetButton } from '../components/Sheet.tsx'
import { nextColour, safeColour } from '../lib/colours.ts'
import { draftsAreValid, toDrafts, toPayload, type FieldDraft } from '../lib/fields.ts'
import { hapticLog, hapticUndo } from '../lib/haptics.ts'
import { useCreateTracker, useDeleteTracker, useTrackers, useUpdateTracker } from '../lib/queries.ts'
import { formatAfter, useReminders, type Reminder } from '../lib/remindersApi.ts'
import { arrayMove, useReorderTrackers } from '../lib/trackerOrder.ts'
import type { Profile, Tracker, TrackerType } from '../types.ts'

type SheetState =
  | { kind: 'form'; tracker: Tracker | null }
  | { kind: 'actions'; tracker: Tracker }
  | { kind: 'reminder'; tracker: Tracker }
  | { kind: 'delete'; tracker: Tracker }
  | null

interface Draft {
  name: string
  type: TrackerType
  colour: string
  fields: FieldDraft[]
}

/**
 * A live drag.
 *
 * The DOM order does not change while a finger is down — the dragged row is
 * translated by `dy` and every row it has passed is translated by one `step`
 * the other way. Reordering the array only happens on release, which is also
 * the only moment anything is written to the server.
 */
interface DragState {
  pointerId: number
  from: number
  to: number
  dy: number
  /** Row pitch: height plus the gap. Rows are a fixed height, names truncate. */
  step: number
  count: number
  startY: number
}

const FALLBACK_STEP = 76

export function TrackersScreen({ profile }: { profile: Profile }) {
  const profileId = profile.id
  const trackersQuery = useTrackers(profileId)
  const createTracker = useCreateTracker(profileId)
  const updateTracker = useUpdateTracker(profileId)
  const deleteTracker = useDeleteTracker(profileId)
  const remindersQuery = useReminders(profileId)
  const reorder = useReorderTrackers(profileId)

  const [sheet, setSheet] = useState<SheetState>(null)
  const [draft, setDraft] = useState<Draft>({
    name: '',
    type: 'INSTANT',
    colour: nextColour([]),
    fields: [],
  })

  const listRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  const all = trackersQuery.data ?? []
  const active = all.filter((t) => t.archivedAt === null)
  const archived = all.filter((t) => t.archivedAt !== null)
  const activeIds = active.map((t) => t.id)

  const reminderByTracker = new Map<string, Reminder>()
  for (const r of remindersQuery.data ?? []) reminderByTracker.set(r.trackerId, r)

  const target = sheet && sheet.kind !== 'form' ? sheet.tracker : null
  const editing = sheet?.kind === 'form' ? sheet.tracker : null
  const targetReminder = target ? reminderByTracker.get(target.id) : undefined
  const targetIndex = target ? activeIds.indexOf(target.id) : -1

  // The count in the confirm dialog is the only thing between a mis-tap and
  // real data loss, so it is fetched before the dialog can be acted on.
  const preview = useQuery({
    queryKey: ['tracker-delete-preview', target?.id],
    queryFn: () => previewTrackerDelete(target?.id as string),
    enabled: sheet?.kind === 'delete' && Boolean(target),
    gcTime: 0,
    staleTime: 0,
  })

  const openCreate = () => {
    setDraft({
      name: '',
      type: 'INSTANT',
      // Cycle the palette, skipping every colour already in this profile.
      colour: nextColour(all.map((t) => t.colour)),
      fields: [],
    })
    setSheet({ kind: 'form', tracker: null })
  }

  const openEdit = (tracker: Tracker) => {
    setDraft({
      name: tracker.name,
      type: tracker.type,
      colour: safeColour(tracker.colour),
      // toDrafts keeps every existing field id — see lib/fields.ts.
      fields: toDrafts(tracker.fields),
    })
    setSheet({ kind: 'form', tracker })
  }

  const canSubmit = draft.name.trim().length > 0 && draftsAreValid(draft.fields)

  const submitForm = () => {
    if (!canSubmit) return
    const name = draft.name.trim()
    const fields = toPayload(draft.fields)

    if (editing) {
      updateTracker.mutate({ id: editing.id, patch: { name, colour: draft.colour, fields } })
    } else {
      hapticLog()
      createTracker.mutate({ name, type: draft.type, colour: draft.colour, fields })
    }
    setSheet(null)
  }

  const toggleArchive = () => {
    if (!target) return
    updateTracker.mutate({
      id: target.id,
      patch: { archivedAt: target.archivedAt === null ? Date.now() : null },
    })
    setSheet(null)
  }

  const confirmDelete = () => {
    if (!target) return
    hapticUndo()
    deleteTracker.mutate(target.id)
    setSheet(null)
  }

  /* --------------------------------------------------------- reordering -- */

  /** Drag *and* keyboard *and* the sheet's buttons all land here. */
  const moveBy = (index: number, delta: number) => {
    const to = index + delta
    if (index < 0 || to < 0 || to >= activeIds.length) return
    hapticLog()
    reorder(arrayMove(activeIds, index, to))
  }

  const beginDrag = (e: ReactPointerEvent<HTMLElement>, index: number) => {
    if (activeIds.length < 2) return
    const rows = listRef.current
      ? Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-tracker-row]'))
      : []
    const first = rows[0]
    const second = rows[1]
    const step =
      first && second
        ? second.getBoundingClientRect().top - first.getBoundingClientRect().top
        : FALLBACK_STEP

    e.currentTarget.setPointerCapture(e.pointerId)
    hapticLog()
    setDrag({
      pointerId: e.pointerId,
      from: index,
      to: index,
      dy: 0,
      step: step > 0 ? step : FALLBACK_STEP,
      count: activeIds.length,
      startY: e.clientY,
    })
  }

  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    setDrag((d) => {
      if (!d || d.pointerId !== e.pointerId) return d
      // Clamped to the list, so a row never floats off past either end.
      const dy = Math.max(
        -d.from * d.step,
        Math.min((d.count - 1 - d.from) * d.step, e.clientY - d.startY),
      )
      const to = Math.max(0, Math.min(d.count - 1, d.from + Math.round(dy / d.step)))
      if (dy === d.dy && to === d.to) return d
      return { ...d, dy, to }
    })
  }

  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag || drag.pointerId !== e.pointerId) return
    const { from, to } = drag
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* the capture is already gone on pointercancel */
    }
    setDrag(null)
    // One write per moved row, on release. Never one per pixel.
    if (to !== from) moveBy(from, to - from)
  }

  const offsetFor = (index: number): number => {
    if (!drag) return 0
    if (index === drag.from) return drag.dy
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.step
    if (drag.from > drag.to && index < drag.from && index >= drag.to) return drag.step
    return 0
  }

  const count = preview.data?.events

  return (
    <div className="relative z-10 flex min-h-dvh flex-col">
      <header className="pad-safe-top pad-safe-x pb-4">
        <h1 className="lockup text-[15px] font-semibold tracking-[-0.02em]">Trackers</h1>
        <p className="stencil mt-1.5">{profile.name}</p>
      </header>

      <main className="pad-safe-x flex-1 pb-44">
        {trackersQuery.isPending ? (
          <p className="stencil">loading</p>
        ) : all.length === 0 ? (
          <p className="mt-4 text-[19px] leading-snug tracking-[-0.02em] text-balance text-text-dim">
            Nothing defined yet. A tracker is just a name and a shape — a Moment or a Span.
          </p>
        ) : (
          <>
            <div ref={listRef} className="flex flex-col gap-2">
              {active.map((tracker, index) => (
                <TrackerRow
                  key={tracker.id}
                  tracker={tracker}
                  reminder={reminderByTracker.get(tracker.id)}
                  onOpen={() => setSheet({ kind: 'actions', tracker })}
                  offset={offsetFor(index)}
                  dragging={drag?.from === index}
                  handle={
                    active.length > 1
                      ? {
                          index,
                          count: active.length,
                          onPointerDown: (e) => beginDrag(e, index),
                          onPointerMove: onDragMove,
                          onPointerUp: endDrag,
                          onMove: (delta) => moveBy(index, delta),
                        }
                      : undefined
                  }
                />
              ))}
            </div>

            {active.length > 1 ? (
              <p className="stencil mt-3.5">drag the grip · this is the log grid order</p>
            ) : null}

            {archived.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="stencil mt-7 mb-1">archived · hidden from home</p>
                {archived.map((tracker) => (
                  <TrackerRow
                    key={tracker.id}
                    tracker={tracker}
                    reminder={reminderByTracker.get(tracker.id)}
                    onOpen={() => setSheet({ kind: 'actions', tracker })}
                    offset={0}
                    dragging={false}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </main>

      {/* Primary action pinned above the tab bar, never on top of it. */}
      <div className="pad-safe-x pointer-events-none fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-ink-900 via-ink-900/92 to-transparent pt-12 pb-[calc(var(--safe-b)+var(--tabbar-h)+14px)]">
        <button
          type="button"
          onClick={openCreate}
          className="tap pointer-events-auto flex h-[60px] w-full items-center justify-center gap-2 rounded-2xl bg-periwinkle text-[17px] font-semibold tracking-[-0.01em] text-ink-900 active:bg-wisteria"
        >
          <span aria-hidden className="text-[20px] leading-none">
            +
          </span>
          New tracker
        </button>
      </div>

      {/* ----------------------------------------------------- create/edit -- */}
      <Sheet
        open={sheet?.kind === 'form'}
        onClose={() => setSheet(null)}
        eyebrow={editing ? 'edit tracker' : 'new tracker'}
        title={editing ? editing.name : 'What are you logging?'}
      >
        <TextField
          ariaLabel="Tracker name"
          autoFocus={!editing}
          value={draft.name}
          onChange={(name) => setDraft((d) => ({ ...d, name }))}
          onSubmit={submitForm}
          placeholder="Feeding, Nap, Contraction…"
        />

        {editing ? (
          <p className="stencil">
            {editing.type === 'INTERVAL' ? 'span' : 'moment'} · type cannot change
          </p>
        ) : (
          <TypePicker value={draft.type} onChange={(type) => setDraft((d) => ({ ...d, type }))} />
        )}

        <ColourPicker
          value={draft.colour}
          onChange={(colour) => setDraft((d) => ({ ...d, colour }))}
        />

        <FieldEditor
          drafts={draft.fields}
          onChange={(fields) => setDraft((d) => ({ ...d, fields }))}
        />

        <SheetButton tone="primary" onClick={submitForm} disabled={!canSubmit}>
          {editing ? 'Save' : 'Create'}
        </SheetButton>
      </Sheet>

      {/* --------------------------------------------------------- actions -- */}
      <Sheet
        open={sheet?.kind === 'actions'}
        onClose={() => setSheet(null)}
        eyebrow={target?.type === 'INTERVAL' ? 'span' : 'moment'}
        title={target?.name ?? ''}
      >
        <SheetButton
          tone="quiet"
          onClick={() => {
            if (target) openEdit(target)
          }}
        >
          Edit name, colour and fields
        </SheetButton>

        <SheetButton
          tone="quiet"
          onClick={() => {
            if (target) setSheet({ kind: 'reminder', tracker: target })
          }}
        >
          {targetReminder
            ? `Reminder — after ${formatAfter(targetReminder.afterMs)}${targetReminder.enabled ? '' : ', paused'}`
            : 'Remind me if it goes quiet…'}
        </SheetButton>

        {/* The accessible half of reorder: operable with any input, and the
            only version of it that works without a pointer at all. */}
        {targetIndex >= 0 && activeIds.length > 1 ? (
          <div className="flex gap-2.5">
            <MoveButton
              label="Move up"
              disabled={targetIndex === 0}
              onClick={() => moveBy(targetIndex, -1)}
            />
            <MoveButton
              label="Move down"
              disabled={targetIndex === activeIds.length - 1}
              onClick={() => moveBy(targetIndex, 1)}
            />
          </div>
        ) : null}

        {targetIndex >= 0 && activeIds.length > 1 ? (
          <p className="stencil text-center">
            position {targetIndex + 1} of {activeIds.length} on the log grid
          </p>
        ) : null}

        <SheetButton tone="quiet" onClick={toggleArchive}>
          {target?.archivedAt === null ? 'Archive — hide from home' : 'Restore to home'}
        </SheetButton>
        <SheetButton
          tone="quiet"
          onClick={() => {
            if (target) setSheet({ kind: 'delete', tracker: target })
          }}
        >
          <span className="text-ember">Delete…</span>
        </SheetButton>
      </Sheet>

      {/* -------------------------------------------------------- reminder -- */}
      <ReminderEditor
        open={sheet?.kind === 'reminder'}
        profileId={profileId}
        tracker={sheet?.kind === 'reminder' ? sheet.tracker : null}
        reminder={sheet?.kind === 'reminder' ? reminderByTracker.get(sheet.tracker.id) : undefined}
        onClose={() => setSheet(null)}
      />

      {/* ---------------------------------------------------------- delete -- */}
      <Sheet
        open={sheet?.kind === 'delete'}
        onClose={() => setSheet(null)}
        eyebrow="permanent"
        title={`Delete ${target?.name ?? ''}?`}
        body={
          preview.isPending ? (
            'Counting its events…'
          ) : preview.isError ? (
            'Could not count its events. Not deleting until that number is known.'
          ) : (
            <>
              This permanently deletes{' '}
              <strong className="digits font-medium text-text">{count ?? 0}</strong>{' '}
              {count === 1 ? 'event' : 'events'}. There is no undo.
            </>
          )
        }
      >
        <SheetButton
          tone="danger"
          onClick={confirmDelete}
          disabled={preview.isPending || preview.isError}
        >
          {preview.isPending
            ? 'Counting…'
            : `Delete ${target?.name ?? ''} and ${count ?? 0} ${count === 1 ? 'event' : 'events'}`}
        </SheetButton>
        <SheetButton tone="quiet" onClick={() => setSheet(null)}>
          Keep it
        </SheetButton>
      </Sheet>
    </div>
  )
}

function MoveButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="tap flex h-[60px] flex-1 items-center justify-center gap-2 rounded-2xl border border-ink-600 bg-ink-700 text-[16px] tracking-[-0.01em] disabled:opacity-35"
    >
      <span aria-hidden className="text-[13px]">
        {label === 'Move up' ? '↑' : '↓'}
      </span>
      {label}
    </button>
  )
}

interface HandleProps {
  index: number
  count: number
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onMove: (delta: number) => void
}

function TrackerRow({
  tracker,
  reminder,
  onOpen,
  offset,
  dragging,
  handle,
}: {
  tracker: Tracker
  reminder: Reminder | undefined
  onOpen: () => void
  offset: number
  dragging: boolean
  handle?: HandleProps
}) {
  const colour = safeColour(tracker.colour)
  const isArchived = tracker.archivedAt !== null
  const fieldCount = tracker.fields?.length ?? 0

  return (
    <div
      data-tracker-row
      style={{
        transform: offset === 0 ? undefined : `translateY(${offset}px)`,
        // No transition on the row under the thumb — it must track the finger
        // exactly. Every other row eases into its new slot.
        transition: dragging ? 'none' : 'transform 170ms cubic-bezier(0.2, 0.9, 0.25, 1)',
        zIndex: dragging ? 20 : undefined,
      }}
      className={`relative flex min-h-[68px] items-center rounded-2xl border bg-ink-850 pr-1.5 ${
        dragging
          ? 'border-mauve/50 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.95)]'
          : 'border-ink-700'
      } ${isArchived ? 'opacity-55' : ''}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="tap flex min-h-[68px] min-w-0 flex-1 items-center gap-3.5 rounded-2xl py-3 pl-4 text-left"
      >
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{
            background: colour,
            boxShadow: isArchived ? 'none' : `0 0 12px ${colour}`,
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[18px] leading-tight font-medium tracking-[-0.02em]">
            {tracker.name}
          </span>
          <span className="stencil mt-1.5 block truncate">
            {tracker.type === 'INTERVAL' ? 'span' : 'moment'}
            {fieldCount > 0 ? ` · ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}` : ''}
            {reminder
              ? ` · ${reminder.enabled ? `reminds ${formatAfter(reminder.afterMs)}` : 'reminder paused'}`
              : ''}
            {isArchived ? ' · archived' : ''}
          </span>
        </span>
      </button>

      {handle ? (
        <button
          type="button"
          aria-label={`Reorder ${tracker.name}. Position ${handle.index + 1} of ${handle.count}. Drag, or press the up and down arrow keys.`}
          onPointerDown={handle.onPointerDown}
          onPointerMove={handle.onPointerMove}
          onPointerUp={handle.onPointerUp}
          onPointerCancel={handle.onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              handle.onMove(-1)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              handle.onMove(1)
            }
          }}
          // `touch-action: none` is confined to the 44px grip: everywhere else
          // on the row a drag still scrolls the page, which is what a phone
          // list has to keep doing.
          style={{ touchAction: 'none' }}
          className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${
            dragging ? 'bg-ink-700 text-mauve' : 'text-text-dim active:bg-ink-700'
          }`}
        >
          <svg viewBox="0 0 24 24" className="size-5" aria-hidden fill="none">
            <path
              d="M5 9h14M5 15h14"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : (
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center text-text-dim">
          <svg viewBox="0 0 24 24" className="size-5" fill="none">
            <circle cx="12" cy="5.5" r="1.4" fill="currentColor" />
            <circle cx="12" cy="12" r="1.4" fill="currentColor" />
            <circle cx="12" cy="18.5" r="1.4" fill="currentColor" />
          </svg>
        </span>
      )}
    </div>
  )
}

const TYPE_COPY: Record<TrackerType, { label: string; hint: string }> = {
  INSTANT: { label: 'Moment', hint: 'One tap, one timestamp' },
  INTERVAL: { label: 'Span', hint: 'Runs until you stop it' },
}

function TypePicker({
  value,
  onChange,
}: {
  value: TrackerType
  onChange: (next: TrackerType) => void
}) {
  return (
    <div role="radiogroup" aria-label="Tracker type" className="grid grid-cols-2 gap-2.5">
      {(['INSTANT', 'INTERVAL'] as const).map((type) => {
        const selected = value === type
        const copy = TYPE_COPY[type]
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(type)}
            className={`tap flex min-h-[86px] flex-col justify-between rounded-2xl border p-3.5 text-left ${
              selected ? 'border-mauve/55 bg-mauve/10' : 'border-ink-600 bg-ink-700 text-text-dim'
            }`}
          >
            <span aria-hidden className="flex items-center gap-[3px]">
              <span
                className={`size-[7px] rounded-full ${selected ? 'bg-mauve' : 'bg-text-dim'}`}
              />
              {type === 'INTERVAL' ? (
                <span
                  className={`h-[3px] w-4 rounded-full ${selected ? 'bg-mauve/60' : 'bg-text-dim/60'}`}
                />
              ) : null}
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
