import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { previewTrackerDelete } from '../api.ts'
import { nextColour, safeColour } from '../lib/colours.ts'
import { draftsAreValid, toDrafts, toPayload, type FieldDraft } from '../lib/fields.ts'
import { hapticLog, hapticUndo } from '../lib/haptics.ts'
import { useCreateTracker, useDeleteTracker, useUpdateTracker } from '../lib/queries.ts'
import { summariseReminder, useReminders } from '../lib/remindersApi.ts'
import { FieldEditor } from './FieldEditor.tsx'
import { ColourPicker, TextField } from './Form.tsx'
import { ReminderEditor } from './ReminderEditor.tsx'
import { Toggle } from './ReminderBits.tsx'
import { Sheet, SheetButton } from './Sheet.tsx'
import type { Tracker, TrackerType } from '../types.ts'

/**
 * Every sheet that manages a tracker: create/edit, the action drawer, the
 * reminder editor, and the counted delete confirm.
 *
 * This lives in one component because there is now one entry point. The
 * Trackers tab was folded into the Log screen's edit mode, and a second copy of
 * these sheets would be a second place for the delete-confirm's count to drift
 * out of sync with the one thing standing between a mis-tap and real data loss.
 */

export type TrackerSheetState =
  /** `tracker: null` is "create". */
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
  /** Span only. Configuration, not identity — editable after creation. */
  counter: boolean
}

export function TrackerSheets({
  profileId,
  trackers,
  state,
  onState,
}: {
  profileId: string
  /** Every tracker in the profile, archived included — used to cycle colours. */
  trackers: Tracker[]
  state: TrackerSheetState
  onState: (next: TrackerSheetState) => void
}) {
  const createTracker = useCreateTracker(profileId)
  const updateTracker = useUpdateTracker(profileId)
  const deleteTracker = useDeleteTracker(profileId)
  const remindersQuery = useReminders(profileId)

  const [draft, setDraft] = useState<Draft>({
    name: '',
    type: 'INSTANT',
    colour: nextColour([]),
    fields: [],
    counter: false,
  })

  const close = () => onState(null)

  const target = state && state.kind !== 'form' ? state.tracker : null
  const editing = state?.kind === 'form' ? state.tracker : null
  const formOpen = state?.kind === 'form'

  const reminder = target
    ? (remindersQuery.data ?? []).find((r) => r.trackerId === target.id)
    : undefined

  /**
   * Seed the form once per opening. Keyed on the target rather than run on
   * every render of the trackers query, so a background refetch cannot wipe a
   * half-typed name out from under the keyboard.
   */
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (!formOpen) {
      seeded.current = null
      return
    }
    const stamp = editing?.id ?? 'new'
    if (seeded.current === stamp) return
    seeded.current = stamp

    if (editing) {
      setDraft({
        name: editing.name,
        type: editing.type,
        colour: safeColour(editing.colour),
        // toDrafts keeps every existing field id — see lib/fields.ts.
        fields: toDrafts(editing.fields),
        counter: editing.counter,
      })
    } else {
      setDraft({
        name: '',
        type: 'INSTANT',
        // Cycle the palette, skipping every colour already in this profile.
        colour: nextColour(trackers.map((t) => t.colour)),
        fields: [],
        counter: false,
      })
    }
  }, [formOpen, editing, trackers])

  // The count in the confirm dialog is the only thing between a mis-tap and
  // real data loss, so it is fetched before the dialog can be acted on.
  const preview = useQuery({
    queryKey: ['tracker-delete-preview', target?.id],
    queryFn: () => previewTrackerDelete(target?.id as string),
    enabled: state?.kind === 'delete' && Boolean(target),
    gcTime: 0,
    staleTime: 0,
  })

  const canSubmit = draft.name.trim().length > 0 && draftsAreValid(draft.fields)

  const submitForm = () => {
    if (!canSubmit) return
    const name = draft.name.trim()
    const fields = toPayload(draft.fields)

    // A counter is meaningless on a Moment, and the server rejects it there
    // (COUNTER_NOT_ALLOWED), so the type decides what is sent — not the toggle,
    // which may hold a stale true from a type switch made before creating.
    const type = editing ? editing.type : draft.type
    const counter = type === 'INTERVAL' && draft.counter

    if (editing) {
      updateTracker.mutate({
        id: editing.id,
        patch: { name, colour: draft.colour, fields, counter },
      })
    } else {
      hapticLog()
      createTracker.mutate({ name, type: draft.type, colour: draft.colour, fields, counter })
    }
    close()
  }

  const toggleArchive = () => {
    if (!target) return
    updateTracker.mutate({
      id: target.id,
      patch: { archivedAt: target.archivedAt === null ? Date.now() : null },
    })
    close()
  }

  const confirmDelete = () => {
    if (!target) return
    hapticUndo()
    deleteTracker.mutate(target.id)
    close()
  }

  const count = preview.data?.events

  return (
    <>
      {/* ----------------------------------------------------- create/edit -- */}
      <Sheet
        open={formOpen}
        onClose={close}
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

        {/* Span only — a Moment has no session to count within. Shown while
            editing too: unlike `type` this is configuration, not identity, and
            turning it off leaves every count already logged intact. */}
        {(editing ? editing.type : draft.type) === 'INTERVAL' ? (
          <div className="rounded-2xl border border-ink-600 bg-ink-800/60 px-4 py-3">
            <p className="stencil mb-2">counter</p>
            <Toggle
              checked={draft.counter}
              onChange={(counter) => setDraft((d) => ({ ...d, counter }))}
              label="Count taps — the span runs from the first count to the last."
            />
          </div>
        ) : null}

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
        open={state?.kind === 'actions'}
        onClose={close}
        eyebrow={target?.type === 'INTERVAL' ? 'span' : 'moment'}
        title={target?.name ?? ''}
      >
        <SheetButton
          tone="quiet"
          onClick={() => {
            if (target) onState({ kind: 'form', tracker: target })
          }}
        >
          Edit name, colour and fields
        </SheetButton>

        <SheetButton
          tone="quiet"
          onClick={() => {
            if (target) onState({ kind: 'reminder', tracker: target })
          }}
        >
          {/* Which kind is set, not just that one is: "after 6h" and
              "9:00 AM, 9:00 PM · weekdays" mean entirely different things. */}
          {reminder
            ? `Reminder — ${summariseReminder(reminder)}${reminder.enabled ? '' : ', paused'}`
            : 'Remind me…'}
        </SheetButton>

        <SheetButton tone="quiet" onClick={toggleArchive}>
          {target?.archivedAt === null ? 'Archive — hide from the log' : 'Restore to the log'}
        </SheetButton>

        <SheetButton
          tone="quiet"
          onClick={() => {
            if (target) onState({ kind: 'delete', tracker: target })
          }}
        >
          <span className="text-ember">Delete…</span>
        </SheetButton>
      </Sheet>

      {/* -------------------------------------------------------- reminder -- */}
      <ReminderEditor
        open={state?.kind === 'reminder'}
        profileId={profileId}
        tracker={state?.kind === 'reminder' ? state.tracker : null}
        reminder={reminder}
        onClose={close}
      />

      {/* ---------------------------------------------------------- delete -- */}
      <Sheet
        open={state?.kind === 'delete'}
        onClose={close}
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
        <SheetButton tone="quiet" onClick={close}>
          Keep it
        </SheetButton>
      </Sheet>
    </>
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
