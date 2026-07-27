import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'wouter'

import { previewTrackerDelete } from '../api.ts'
import { Sheet, SheetButton } from '../components/Sheet.tsx'
import { nextColour, safeColour } from '../lib/colours.ts'
import { hapticLog, hapticUndo } from '../lib/haptics.ts'
import { useCreateTracker, useDeleteTracker, useTrackers, useUpdateTracker } from '../lib/queries.ts'
import type { Tracker, TrackerType } from '../types.ts'

type SheetState =
  | { kind: 'create' }
  | { kind: 'actions'; tracker: Tracker }
  | { kind: 'rename'; tracker: Tracker }
  | { kind: 'delete'; tracker: Tracker }
  | null

export function TrackersScreen({ profileId }: { profileId: string }) {
  const trackersQuery = useTrackers(profileId)
  const createTracker = useCreateTracker(profileId)
  const updateTracker = useUpdateTracker(profileId)
  const deleteTracker = useDeleteTracker(profileId)

  const [sheet, setSheet] = useState<SheetState>(null)
  const [draftName, setDraftName] = useState('')
  const [draftType, setDraftType] = useState<TrackerType>('INSTANT')

  const all = trackersQuery.data ?? []
  const active = all.filter((t) => t.archivedAt === null)
  const archived = all.filter((t) => t.archivedAt !== null)

  const target = sheet && sheet.kind !== 'create' ? sheet.tracker : null

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
    setDraftName('')
    setDraftType('INSTANT')
    setSheet({ kind: 'create' })
  }

  const submitCreate = () => {
    const name = draftName.trim()
    if (!name) return
    hapticLog()
    createTracker.mutate({ name, type: draftType, colour: nextColour(all.length) })
    setSheet(null)
  }

  const submitRename = () => {
    const name = draftName.trim()
    if (!name || !target) return
    updateTracker.mutate({ id: target.id, patch: { name } })
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
      <header className="pad-safe-top pad-safe-x flex items-center gap-1 pb-4">
        <Link
          href="/"
          aria-label="Back to home"
          className="tap -ml-2 flex size-11 items-center justify-center rounded-full text-bone-dim active:bg-white/5"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
        <h1 className="text-[15px] font-semibold tracking-[-0.02em]">Trackers</h1>
      </header>

      <main className="pad-safe-x flex-1 pb-40">
        {trackersQuery.isPending ? (
          <p className="stencil">loading</p>
        ) : all.length === 0 ? (
          <p className="mt-4 text-[19px] leading-snug tracking-[-0.02em] text-bone-dim text-balance">
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

      {/* Primary action pinned to the thumb, not to the header. */}
      <div className="pad-safe-x pad-safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-ink-950 via-ink-950/92 to-transparent pt-12">
        <button
          type="button"
          onClick={openCreate}
          className="tap pointer-events-auto flex h-[60px] w-full items-center justify-center gap-2 rounded-2xl bg-amber text-[17px] font-semibold tracking-[-0.01em] text-ink-950"
        >
          <span aria-hidden className="text-[20px] leading-none">
            +
          </span>
          New tracker
        </button>
      </div>

      {/* ---------------------------------------------------------- create -- */}
      <Sheet
        open={sheet?.kind === 'create'}
        onClose={() => setSheet(null)}
        eyebrow="new tracker"
        title="What are you logging?"
      >
        <NameField value={draftName} onChange={setDraftName} onSubmit={submitCreate} />
        <TypePicker value={draftType} onChange={setDraftType} />
        <SheetButton tone="primary" onClick={submitCreate} disabled={draftName.trim().length === 0}>
          Create
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
            if (!target) return
            setDraftName(target.name)
            setSheet({ kind: 'rename', tracker: target })
          }}
        >
          Rename
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

      {/* ---------------------------------------------------------- rename -- */}
      <Sheet
        open={sheet?.kind === 'rename'}
        onClose={() => setSheet(null)}
        eyebrow="rename"
        title={target?.name ?? ''}
      >
        <NameField value={draftName} onChange={setDraftName} onSubmit={submitRename} />
        <SheetButton tone="primary" onClick={submitRename} disabled={draftName.trim().length === 0}>
          Save
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
              <strong className="digits font-medium text-bone">{count ?? 0}</strong>{' '}
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

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`tap flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl border border-white/6 bg-ink-900 px-4 py-3 text-left active:bg-ink-850 ${
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
          {isArchived ? ' · archived' : ''}
        </span>
      </span>
      <span aria-hidden className="text-bone-faint">
        <svg viewBox="0 0 24 24" className="size-5" fill="none">
          <circle cx="12" cy="5.5" r="1.4" fill="currentColor" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" />
          <circle cx="12" cy="18.5" r="1.4" fill="currentColor" />
        </svg>
      </span>
    </button>
  )
}

function NameField({
  value,
  onChange,
  onSubmit,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit()
      }}
      placeholder="Feeding, Nap, Contraction…"
      enterKeyHint="done"
      autoCapitalize="sentences"
      autoCorrect="off"
      spellCheck={false}
      maxLength={64}
      className="h-[60px] w-full rounded-2xl border border-white/8 bg-ink-800 px-4 text-[18px] tracking-[-0.01em] outline-none placeholder:text-bone-faint focus:border-amber/50"
    />
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
              selected
                ? 'border-amber/55 bg-amber/10'
                : 'border-white/8 bg-ink-800 text-bone-dim'
            }`}
          >
            <span aria-hidden className="flex items-center gap-[3px]">
              <span
                className={`size-[7px] rounded-full ${selected ? 'bg-amber' : 'bg-bone-faint'}`}
              />
              {type === 'INTERVAL' ? (
                <span
                  className={`h-[3px] w-4 rounded-full ${selected ? 'bg-amber/60' : 'bg-bone-faint/60'}`}
                />
              ) : null}
            </span>
            <span className="mt-3 block">
              <span
                className={`block text-[17px] font-semibold tracking-[-0.02em] ${selected ? 'text-bone' : ''}`}
              >
                {copy.label}
              </span>
              <span className="mt-0.5 block text-[12px] leading-tight text-bone-faint">
                {copy.hint}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
