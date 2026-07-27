import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { previewTrackerDelete } from '../api.ts'
import { FieldEditor } from '../components/FieldEditor.tsx'
import { ColourPicker, TextField } from '../components/Form.tsx'
import { Sheet, SheetButton } from '../components/Sheet.tsx'
import { nextColour, safeColour } from '../lib/colours.ts'
import { draftsAreValid, toDrafts, toPayload, type FieldDraft } from '../lib/fields.ts'
import { hapticLog, hapticUndo } from '../lib/haptics.ts'
import { useCreateTracker, useDeleteTracker, useTrackers, useUpdateTracker } from '../lib/queries.ts'
import type { Profile, Tracker, TrackerType } from '../types.ts'

type SheetState =
  | { kind: 'form'; tracker: Tracker | null }
  | { kind: 'actions'; tracker: Tracker }
  | { kind: 'delete'; tracker: Tracker }
  | null

interface Draft {
  name: string
  type: TrackerType
  colour: string
  fields: FieldDraft[]
}

export function TrackersScreen({ profile }: { profile: Profile }) {
  const profileId = profile.id
  const trackersQuery = useTrackers(profileId)
  const createTracker = useCreateTracker(profileId)
  const updateTracker = useUpdateTracker(profileId)
  const deleteTracker = useDeleteTracker(profileId)

  const [sheet, setSheet] = useState<SheetState>(null)
  const [draft, setDraft] = useState<Draft>({
    name: '',
    type: 'INSTANT',
    colour: nextColour([]),
    fields: [],
  })

  const all = trackersQuery.data ?? []
  const active = all.filter((t) => t.archivedAt === null)
  const archived = all.filter((t) => t.archivedAt !== null)

  const target = sheet && sheet.kind !== 'form' ? sheet.tracker : null
  const editing = sheet?.kind === 'form' ? sheet.tracker : null

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
          <div className="flex flex-col gap-2">
            {active.map((tracker) => (
              <TrackerRow
                key={tracker.id}
                tracker={tracker}
                onOpen={() => setSheet({ kind: 'actions', tracker })}
              />
            ))}

            {archived.length > 0 ? (
              <>
                <p className="stencil mt-7 mb-1">archived · hidden from home</p>
                {archived.map((tracker) => (
                  <TrackerRow
                    key={tracker.id}
                    tracker={tracker}
                    onOpen={() => setSheet({ kind: 'actions', tracker })}
                  />
                ))}
              </>
            ) : null}
          </div>
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

function TrackerRow({ tracker, onOpen }: { tracker: Tracker; onOpen: () => void }) {
  const colour = safeColour(tracker.colour)
  const isArchived = tracker.archivedAt !== null
  const fieldCount = tracker.fields?.length ?? 0

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`tap flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl border border-ink-700 bg-ink-850 px-4 py-3 text-left active:bg-ink-800 ${
        isArchived ? 'opacity-55' : ''
      }`}
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
        <span className="stencil mt-1.5 block">
          {tracker.type === 'INTERVAL' ? 'span' : 'moment'}
          {fieldCount > 0 ? ` · ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}` : ''}
          {isArchived ? ' · archived' : ''}
        </span>
      </span>
      <span aria-hidden className="text-text-dim">
        <svg viewBox="0 0 24 24" className="size-5" fill="none">
          <circle cx="12" cy="5.5" r="1.4" fill="currentColor" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" />
          <circle cx="12" cy="18.5" r="1.4" fill="currentColor" />
        </svg>
      </span>
    </button>
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
