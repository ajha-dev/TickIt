import { db } from './client.js'
import { profiles } from './schema.js'
import { newId } from '../lib/ids.js'

/** Insert the default profile when the profiles table is empty. */
export function seed(): void {
  const existing = db.select({ id: profiles.id }).from(profiles).limit(1).all()
  if (existing.length > 0) return

  const now = Date.now()
  db.insert(profiles)
    .values({
      id: newId(),
      name: 'Personal',
      colour: '#6366f1',
      icon: 'circle',
      sortOrder: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  console.log('[tickit] seeded default profile "Personal"')
}
