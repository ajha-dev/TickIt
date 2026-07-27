import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { previewProfileDelete } from '../api.ts'
import { ColourPicker, TextField } from '../components/Form.tsx'
import { Sheet, SheetButton } from '../components/Sheet.tsx'
import { nextColour, safeColour } from '../lib/colours.ts'
import { hapticLog, hapticUndo } from '../lib/haptics.ts'
import {
  useCreateProfile,
  useDeleteProfile,
  useProfiles,
  useUpdateProfile,
} from '../lib/queries.ts'
import type { Profile } from '../types.ts'

type SheetState =
  | { kind: 'form'; profile: Profile | null }
  | { kind: 'actions'; profile: Profile }
  | { kind: 'delete'; profile: Profile }
  | null

/**
 * Profiles are contexts, not accounts: "Pregnancy", "Feeding", "Training".
 * They share nothing, so switching one changes the whole of Home.
 *
 * Archiving hides a profile from the switcher and leaves every row it owns
 * intact. Deleting takes the trackers and the events with it, which is why the
 * confirm here counts both before it will let you through.
 */
export function ProfilesScreen({
  selectedId,
  onSelectProfile,
}: {
  selectedId: string | null
  onSelectProfile: (id: string) => void
}) {
  const profilesQuery = useProfiles()
  const createProfile = useCreateProfile()
  const updateProfile = useUpdateProfile()
  const deleteProfile = useDeleteProfile()

  const [sheet, setSheet] = useState<SheetState>(null)
  const [name, setName] = useState('')
  const [colour, setColour] = useState(nextColour([]))

  const all = profilesQuery.data ?? []
  const active = all.filter((p) => p.archivedAt === null)
  const archived = all.filter((p) => p.archivedAt !== null)

  const target = sheet && sheet.kind !== 'form' ? sheet.profile : null
  const editing = sheet?.kind === 'form' ? sheet.profile : null

  const preview = useQuery({
    queryKey: ['profile-delete-preview', target?.id],
    queryFn: () => previewProfileDelete(target?.id as string),
    enabled: sheet?.kind === 'delete' && Boolean(target),
    gcTime: 0,
    staleTime: 0,
  })

  const openCreate = () => {
    setName('')
    setColour(nextColour(all.map((p) => p.colour)))
    setSheet({ kind: 'form', profile: null })
  }

  const openEdit = (profile: Profile) => {
    setName(profile.name)
    setColour(safeColour(profile.colour))
    setSheet({ kind: 'form', profile })
  }

  const submitForm = () => {
    const trimmed = name.trim()
    if (!trimmed) return

    if (editing) {
      updateProfile.mutate({ id: editing.id, patch: { name: trimmed, colour } })
    } else {
      hapticLog()
      createProfile.mutate(
        { name: trimmed, colour },
        // A profile you just made is a profile you want to be in.
        { onSuccess: (created) => onSelectProfile(created.id) },
      )
    }
    setSheet(null)
  }

  const toggleArchive = () => {
    if (!target) return
    updateProfile.mutate({
      id: target.id,
      patch: { archivedAt: target.archivedAt === null ? Date.now() : null },
    })
    setSheet(null)
  }

  const confirmDelete = () => {
    if (!target) return
    hapticUndo()
    deleteProfile.mutate(target.id)
    setSheet(null)
  }

  const trackers = preview.data?.trackers ?? 0
  const events = preview.data?.events ?? 0

  return (
    <div className="relative z-10 flex min-h-dvh flex-col">
      <header className="pad-safe-top pad-safe-x pb-4">
        <h1 className="lockup text-[15px] font-semibold tracking-[-0.02em]">Profiles</h1>
        <p className="stencil mt-1.5">
          {active.length} active{archived.length > 0 ? ` · ${archived.length} archived` : ''}
        </p>
      </header>

      <main className="pad-safe-x flex-1 pb-44">
        {profilesQuery.isPending ? (
          <p className="stencil">loading</p>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                showing={profile.id === selectedId}
                onOpen={() => setSheet({ kind: 'actions', profile })}
              />
            ))}

            {archived.length > 0 ? (
              <>
                <p className="stencil mt-7 mb-1">archived · hidden from the switcher</p>
                {archived.map((profile) => (
                  <ProfileRow
                    key={profile.id}
                    profile={profile}
                    showing={false}
                    onOpen={() => setSheet({ kind: 'actions', profile })}
                  />
                ))}
              </>
            ) : null}
          </div>
        )}
      </main>

      <div className="pad-safe-x pointer-events-none fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-ink-900 via-ink-900/92 to-transparent pt-12 pb-[calc(var(--safe-b)+var(--tabbar-h)+14px)]">
        <button
          type="button"
          onClick={openCreate}
          className="tap pointer-events-auto flex h-[60px] w-full items-center justify-center gap-2 rounded-2xl bg-periwinkle text-[17px] font-semibold tracking-[-0.01em] text-ink-900 active:bg-wisteria"
        >
          <span aria-hidden className="text-[20px] leading-none">
            +
          </span>
          New profile
        </button>
      </div>

      {/* ----------------------------------------------------- create/edit -- */}
      <Sheet
        open={sheet?.kind === 'form'}
        onClose={() => setSheet(null)}
        eyebrow={editing ? 'edit profile' : 'new profile'}
        title={editing ? editing.name : 'A new context'}
        body={editing ? undefined : 'Its own trackers, its own events. Nothing rolls up between them.'}
      >
        <TextField
          ariaLabel="Profile name"
          autoFocus
          value={name}
          onChange={setName}
          onSubmit={submitForm}
          placeholder="Pregnancy, Feeding, Training…"
        />
        <ColourPicker value={colour} onChange={setColour} />
        <SheetButton tone="primary" onClick={submitForm} disabled={name.trim().length === 0}>
          {editing ? 'Save' : 'Create'}
        </SheetButton>
      </Sheet>

      {/* --------------------------------------------------------- actions -- */}
      <Sheet
        open={sheet?.kind === 'actions'}
        onClose={() => setSheet(null)}
        eyebrow={target?.archivedAt === null ? 'profile' : 'archived profile'}
        title={target?.name ?? ''}
      >
        {target && target.archivedAt === null && target.id !== selectedId ? (
          <SheetButton
            tone="primary"
            onClick={() => {
              onSelectProfile(target.id)
              setSheet(null)
            }}
          >
            Show this on Home
          </SheetButton>
        ) : null}

        <SheetButton
          tone="quiet"
          onClick={() => {
            if (target) openEdit(target)
          }}
        >
          Rename or recolour
        </SheetButton>
        <SheetButton tone="quiet" onClick={toggleArchive}>
          {target?.archivedAt === null
            ? 'Archive — hide from the switcher'
            : 'Restore to the switcher'}
        </SheetButton>
        <SheetButton
          tone="quiet"
          onClick={() => {
            if (target) setSheet({ kind: 'delete', profile: target })
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
            'Counting what goes with it…'
          ) : preview.isError ? (
            'Could not count its trackers and events. Not deleting until those numbers are known.'
          ) : (
            <>
              This permanently deletes{' '}
              <strong className="digits font-medium text-text">{trackers}</strong>{' '}
              {trackers === 1 ? 'tracker' : 'trackers'} and{' '}
              <strong className="digits font-medium text-text">{events}</strong>{' '}
              {events === 1 ? 'event' : 'events'}. There is no undo.
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
            : `Delete ${target?.name ?? ''}, ${trackers} ${
                trackers === 1 ? 'tracker' : 'trackers'
              } and ${events} ${events === 1 ? 'event' : 'events'}`}
        </SheetButton>
        <SheetButton tone="quiet" onClick={() => setSheet(null)}>
          Keep it
        </SheetButton>
      </Sheet>
    </div>
  )
}

function ProfileRow({
  profile,
  showing,
  onOpen,
}: {
  profile: Profile
  showing: boolean
  onOpen: () => void
}) {
  const colour = safeColour(profile.colour)
  const isArchived = profile.archivedAt !== null

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`tap flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl border px-4 py-3 text-left active:bg-ink-800 ${
        showing ? 'border-mauve/45 bg-ink-850' : 'border-ink-700 bg-ink-850'
      } ${isArchived ? 'opacity-55' : ''}`}
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ background: colour, boxShadow: isArchived ? 'none' : `0 0 12px ${colour}` }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[18px] leading-tight font-medium tracking-[-0.02em]">
          {profile.name}
        </span>
        <span className="stencil mt-1.5 block">
          {isArchived ? 'archived' : showing ? 'showing on home' : 'profile'}
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
