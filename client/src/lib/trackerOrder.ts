/**
 * Persisting the tracker order.
 *
 * PLAN.md: "Reorder by drag; that order is the home grid order." The Log grid
 * renders `GET /api/trackers` in the order the server returns it, which is
 * `sortOrder` then `createdAt` — so the only thing that has to happen is for
 * `sortOrder` to end up as 0…n-1 in the order the user just arranged.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { keys } from './queries.ts'
import type { Tracker } from '../types.ts'

/** One PATCH, deliberately not routed through the log outbox — see remindersApi. */
async function patchSortOrder(id: string, sortOrder: number): Promise<void> {
  const res = await fetch(`/api/trackers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sortOrder }),
  })
  if (!res.ok) throw new Error(`PATCH /trackers/${id} → ${res.status}`)
  await res.json().catch(() => undefined)
}

/** Immutably move `from` to `to`. */
export function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return items
  next.splice(to, 0, moved)
  return next
}

export type ReorderTrackers = (activeIdsInNewOrder: string[]) => void

/**
 * Writes the new order to the cache immediately and to the server once.
 *
 * Two things this is careful about:
 *
 * - **One PATCH per moved row, on drop.** Not one per pointermove. Dragging a
 *   row down a list of eight is one gesture and at most eight writes, sent when
 *   the thumb lifts.
 * - **Only rows whose number actually changed.** Moving the last row up by one
 *   is two PATCHes, not eight.
 *
 * Archived trackers are numbered after the active ones. They are hidden from
 * the grid anyway, and giving the whole list a single contiguous range keeps
 * the server's `sortOrder, createdAt` sort from interleaving the two sections
 * on the next fetch.
 */
export function useReorderTrackers(profileId: string): ReorderTrackers {
  const qc = useQueryClient()

  return useCallback(
    (activeIds: string[]) => {
      const key = keys.trackers(profileId)
      const current = qc.getQueryData<Tracker[]>(key)
      if (!current) return

      const byId = new Map(current.map((t) => [t.id, t]))
      const active: Tracker[] = []
      for (const id of activeIds) {
        const tracker = byId.get(id)
        if (tracker) active.push(tracker)
      }
      const archived = current.filter((t) => t.archivedAt !== null)

      const changed: Array<{ id: string; sortOrder: number }> = []
      const ordered = [...active, ...archived].map((tracker, index) => {
        if (tracker.sortOrder !== index) changed.push({ id: tracker.id, sortOrder: index })
        return { ...tracker, sortOrder: index }
      })

      // The list must not snap back under the thumb while the writes land.
      qc.setQueryData<Tracker[]>(key, ordered)
      if (changed.length === 0) return

      void Promise.all(changed.map((c) => patchSortOrder(c.id, c.sortOrder)))
        .catch((err: unknown) => {
          console.warn('[tickit] could not save the tracker order', err)
        })
        .finally(() => {
          void qc.invalidateQueries({ queryKey: key })
        })
    },
    [profileId, qc],
  )
}
