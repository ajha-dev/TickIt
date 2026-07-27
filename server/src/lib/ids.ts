import { v7 as uuidv7 } from 'uuid'

/** Time-sortable UUIDv7 — used for every primary key. */
export function newId(): string {
  return uuidv7()
}
