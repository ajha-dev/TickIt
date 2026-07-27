/**
 * Field definitions, client side.
 *
 * The server validates all of this (CONTRACT.md § "Field definitions and
 * values"), but a 400 arriving after you tapped Save is a worse experience than
 * a disabled button, so the same rules are enforced here for immediate
 * feedback. The server remains the authority; this is only the fast path.
 *
 * The one rule that is *not* about feedback: an edited field keeps its `id`.
 * Values already logged are keyed by field id, so dropping the id would orphan
 * every value ever captured for that field. New fields, and only new fields,
 * omit it.
 */

import type { FieldDef, FieldDefInput, FieldKind } from '../types.ts'

export const MAX_FIELDS = 1
export const MAX_LABEL = 24
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 6
export const MAX_OPTION_LENGTH = 16
export const MAX_UNIT = 8

export const FIELD_KINDS: readonly FieldKind[] = ['CHOICE', 'NUMBER', 'BOOL', 'TEXT']

export const KIND_COPY: Record<FieldKind, { label: string; hint: string }> = {
  CHOICE: { label: 'Choice', hint: 'Pick one of a few' },
  NUMBER: { label: 'Number', hint: 'A value, with a unit' },
  BOOL: { label: 'Yes / no', hint: 'A toggle' },
  TEXT: { label: 'Text', hint: 'A short note' },
}

/**
 * A field being edited. `key` is local and stable across re-renders so React
 * (and reordering) has something to hold on to; `id` is the *server's* id and
 * exists only for fields that already exist.
 */
export interface FieldDraft {
  key: string
  id?: string
  label: string
  kind: FieldKind
  unit: string
  options: string[]
}

let localKey = 0
function nextKey(): string {
  localKey += 1
  return `draft-${localKey}`
}

export function blankDraft(kind: FieldKind = 'CHOICE'): FieldDraft {
  return {
    key: nextKey(),
    label: '',
    kind,
    unit: '',
    options: kind === 'CHOICE' ? ['', ''] : [],
  }
}

/** Server shape → editable shape, preserving ids. */
export function toDrafts(fields: readonly FieldDef[] | undefined): FieldDraft[] {
  return (fields ?? []).map((field) => ({
    key: nextKey(),
    id: field.id,
    label: field.label,
    kind: field.kind,
    unit: field.unit ?? '',
    options: field.options ? [...field.options] : field.kind === 'CHOICE' ? ['', ''] : [],
  }))
}

/** Switching kind keeps the label but drops anything the new kind cannot carry. */
export function withKind(draft: FieldDraft, kind: FieldKind): FieldDraft {
  return {
    ...draft,
    kind,
    unit: kind === 'NUMBER' ? draft.unit : '',
    options: kind === 'CHOICE' ? (draft.options.length > 0 ? draft.options : ['', '']) : [],
  }
}

export function moveDraft(drafts: FieldDraft[], from: number, to: number): FieldDraft[] {
  if (to < 0 || to >= drafts.length || from === to) return drafts
  const next = [...drafts]
  const [moved] = next.splice(from, 1)
  if (!moved) return drafts
  next.splice(to, 0, moved)
  return next
}

/** Per-field problem text, or null when the field is fine. Order matters: the
 *  first thing wrong is the thing to say. */
export function draftError(draft: FieldDraft, all: readonly FieldDraft[]): string | null {
  const label = draft.label.trim()
  if (label.length === 0) return 'Needs a label'
  if (label.length > MAX_LABEL) return `Label is longer than ${MAX_LABEL} characters`

  const duplicate = all.some(
    (other) => other.key !== draft.key && other.label.trim().toLowerCase() === label.toLowerCase(),
  )
  if (duplicate) return 'Two fields share this label'

  if (draft.kind === 'CHOICE') {
    const options = draft.options.map((o) => o.trim()).filter((o) => o.length > 0)
    if (options.length < MIN_OPTIONS) return `Needs at least ${MIN_OPTIONS} options`
    if (options.length > MAX_OPTIONS) return `No more than ${MAX_OPTIONS} options`
    if (options.some((o) => o.length > MAX_OPTION_LENGTH)) {
      return `Options are ${MAX_OPTION_LENGTH} characters at most`
    }
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      return 'Two options are the same'
    }
  }

  if (draft.kind === 'NUMBER' && draft.unit.trim().length > MAX_UNIT) {
    return `Unit is ${MAX_UNIT} characters at most`
  }

  return null
}

export function draftsAreValid(drafts: readonly FieldDraft[]): boolean {
  return drafts.length <= MAX_FIELDS && drafts.every((d) => draftError(d, drafts) === null)
}

/** Editable shape → the `fields` payload. Existing ids survive; new ones are
 *  left for the server to mint. */
export function toPayload(drafts: readonly FieldDraft[]): FieldDefInput[] {
  return drafts.map((draft) => {
    const field: FieldDefInput = {
      // The server assigns an id when it is absent; `id` is only spread back in
      // for fields that already have one, which is what keeps logged values
      // attached to their definition.
      ...(draft.id ? { id: draft.id } : {}),
      label: draft.label.trim(),
      kind: draft.kind,
    }

    if (draft.kind === 'CHOICE') {
      field.options = draft.options.map((o) => o.trim()).filter((o) => o.length > 0)
    }
    const unit = draft.unit.trim()
    if (draft.kind === 'NUMBER' && unit.length > 0) field.unit = unit

    return field
  })
}

/* ------------------------------------------------------------- values ---- */

/** A captured value, rendered for display. Returns null when nothing was
 *  captured for that field — an entirely normal outcome. */
export function formatValue(
  field: FieldDef,
  value: string | number | boolean | undefined,
): string | null {
  if (value === undefined || value === null || value === '') return null

  switch (field.kind) {
    case 'BOOL':
      return value ? 'Yes' : 'No'
    case 'NUMBER':
      return field.unit ? `${String(value)} ${field.unit}` : String(value)
    default:
      return String(value)
  }
}

/**
 * The values of an event, paired with their definitions and in field order.
 * Values whose field has since been deleted are skipped rather than rewritten —
 * the row keeps the orphaned key, the UI simply stops rendering it.
 */
export function describeValues(
  fields: readonly FieldDef[] | undefined,
  values: Record<string, string | number | boolean> | undefined,
): { id: string; label: string; text: string }[] {
  if (!fields || !values) return []
  const out: { id: string; label: string; text: string }[] = []
  for (const field of fields) {
    const text = formatValue(field, values[field.id])
    if (text !== null) out.push({ id: field.id, label: field.label, text })
  }
  return out
}
