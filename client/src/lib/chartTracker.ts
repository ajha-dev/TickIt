/**
 * What the Dashboard opens on: one tracker, or all of them.
 *
 * Same reasoning as `profile.ts`, one level down: you come back to the chart to
 * watch the same thing you were watching yesterday. Re-picking it on every
 * visit is friction on the one screen whose whole job is to be glanced at.
 *
 * Remembered **per profile**, because trackers belong to a profile — carrying a
 * Pregnancy tracker id into the Training profile would resolve to nothing and
 * silently reset. Stored as one small map rather than a key per profile so
 * removing a profile never leaves orphaned keys behind.
 *
 * "All" is a remembered choice like any other, stored under a sentinel that no
 * id can collide with (`ALL` contains a `*`; every id is a uuidv7). It is the
 * one selection that cannot dangle: there is no row behind it to delete, so it
 * survives the tracker list changing underneath it entirely.
 *
 * Every access is wrapped: localStorage throws in private mode on some
 * browsers, and a storage failure must never break a screen.
 */

import { useCallback, useState } from 'react'

import type { Tracker } from '../types.ts'

const KEY = 'tickit.chartTrackerByProfile'

/** The stored value meaning "every non-archived tracker at once". */
export const ALL = '*all'

type Remembered = Record<string, string>

function readAll(): Remembered {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    // Anything but a flat object is treated as absent rather than trusted —
    // this is user-writable storage and a bad shape must not throw on read.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Remembered
  } catch {
    return {}
  }
}

function writeAll(next: Remembered): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* remembering the chart is a nicety, never a failure path */
  }
}

export interface ChartTrackerSelection {
  /** The overlay is selected: chart `active`, not `tracker`. */
  all: boolean
  /** The tracker to chart. Null under "All", and when the profile has none. */
  tracker: Tracker | null
  /**
   * The non-archived trackers — what "All" draws, and what the picker offers
   * below it. Archiving hides a tracker from the home grid and now also from
   * the overlay; it does not erase its history, which is why `selectable` still
   * includes a remembered archived tracker so a chart left open on one stays
   * open.
   */
  active: Tracker[]
  /** What the picker lists: `active`, plus the remembered tracker if archived. */
  selectable: Tracker[]
  /** Pass a tracker id, or `ALL`. */
  select: (id: string) => void
}

/**
 * Resolves the remembered choice against the trackers that actually exist. A
 * tracker that has since been deleted falls back to the first available rather
 * than leaving the screen blank; `ALL` never needs that fallback.
 */
export function useChartTracker(profileId: string, trackers: Tracker[]): ChartTrackerSelection {
  const [remembered, setRemembered] = useState<Remembered>(readAll)

  const rememberedId = remembered[profileId]
  const active = trackers.filter((t) => t.archivedAt === null)
  const selectable = trackers.filter((t) => t.archivedAt === null || t.id === rememberedId)

  // "All" over an empty profile is not a chart, it is an empty grid with a
  // legend of nothing — so it resolves to the same "no trackers" state a
  // dangling id does, and the screen says so.
  const all = rememberedId === ALL && selectable.length > 0
  const tracker = all
    ? null
    : (selectable.find((t) => t.id === rememberedId) ?? selectable[0] ?? null)

  // Only an explicit choice is persisted. The fallback above is resolved fresh
  // each render rather than written back, so a tracker list that is momentarily
  // empty — refetching right after an edit — cannot overwrite the real choice.
  const select = useCallback(
    (id: string) => {
      setRemembered((current) => {
        const next = { ...current, [profileId]: id }
        writeAll(next)
        return next
      })
    },
    [profileId],
  )

  return { all, tracker, active, selectable, select }
}
