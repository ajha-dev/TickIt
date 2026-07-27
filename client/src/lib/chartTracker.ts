/**
 * Which tracker the Dashboard opens on.
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
 * Every access is wrapped: localStorage throws in private mode on some
 * browsers, and a storage failure must never break a screen.
 */

import { useCallback, useState } from 'react'

import type { Tracker } from '../types.ts'

const KEY = 'tickit.chartTrackerByProfile'

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
  /** The tracker to chart, or null when the profile has none. */
  tracker: Tracker | null
  /**
   * What the picker offers: the active trackers, plus the remembered one even
   * if archived. Archiving hides a tracker from the home grid, it does not
   * erase its history, so a chart left open on one stays open.
   */
  selectable: Tracker[]
  select: (id: string) => void
}

/**
 * Resolves the remembered id against the trackers that actually exist. One that
 * has since been deleted falls back to the first available rather than leaving
 * the screen blank.
 */
export function useChartTracker(profileId: string, trackers: Tracker[]): ChartTrackerSelection {
  const [remembered, setRemembered] = useState<Remembered>(readAll)

  const rememberedId = remembered[profileId]
  const selectable = trackers.filter((t) => t.archivedAt === null || t.id === rememberedId)
  const tracker = selectable.find((t) => t.id === rememberedId) ?? selectable[0] ?? null

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

  return { tracker, selectable, select }
}
