/**
 * Which profile the app opens on.
 *
 * Profiles are contexts, and the context you were in yesterday is almost
 * always the one you want at 3am today — so the choice is remembered on the
 * device rather than on the server, which has no notion of "this phone".
 *
 * Every access is wrapped: localStorage throws in private mode on some
 * browsers, and a storage failure must never stop the app from logging.
 */

import { useCallback, useState } from 'react'

import type { Profile } from '../types.ts'

const KEY = 'tickit.profileId'

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function write(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, id)
  } catch {
    /* remembering the profile is a nicety, never a failure path */
  }
}

export interface ProfileSelection {
  /** The profile Home is showing, or null while profiles are still loading. */
  profile: Profile | null
  /** Selectable profiles: archived ones are hidden from the switcher. */
  selectable: Profile[]
  select: (id: string) => void
}

/**
 * Resolves the remembered id against the profiles that actually exist. A
 * remembered profile that has been deleted, or archived since, silently falls
 * back to the first active one rather than showing an empty screen.
 */
export function useProfileSelection(profiles: Profile[] | undefined): ProfileSelection {
  const [selectedId, setSelectedId] = useState<string | null>(read)

  const list = profiles ?? []
  const selectable = list.filter((p) => p.archivedAt === null)

  const remembered = selectable.find((p) => p.id === selectedId) ?? null
  const profile = remembered ?? selectable[0] ?? list[0] ?? null

  // Only an explicit choice is ever written. The fallback above is resolved
  // fresh on every render instead of being persisted, so a profile that is
  // momentarily absent — the list refetching right after a create, say — does
  // not overwrite the choice that is still in flight.
  const select = useCallback((id: string) => {
    setSelectedId(id)
    write(id)
  }, [])

  return { profile, selectable, select }
}
