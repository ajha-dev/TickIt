import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from './client.js'

const here = dirname(fileURLToPath(import.meta.url))

/** `src/db` and `dist/db` are both two levels below the workspace root. */
export const migrationsFolder = resolve(here, '../../drizzle')

export function runMigrations(): void {
  migrate(db, { migrationsFolder })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runMigrations()
  console.log(`[tickit] migrations applied from ${migrationsFolder}`)
}
