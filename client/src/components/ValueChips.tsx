import { describeValues } from '../lib/fields.ts'
import type { FieldDef } from '../types.ts'

/**
 * The captured values of an event, wherever that event is shown.
 *
 * Label dim, value bright: at a glance you read the values, and only look for
 * the labels if you need them. Fields with nothing captured are simply absent —
 * a half-filled event is the normal case, not an error state. Values whose
 * field has since been deleted are skipped, never rewritten.
 */
export function ValueChips({
  fields,
  values,
  className = '',
}: {
  fields: readonly FieldDef[] | undefined
  values: Record<string, string | number | boolean> | undefined
  className?: string
}) {
  const items = describeValues(fields, values)
  if (items.length === 0) return null

  return (
    <ul className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 ${className}`}>
      {items.map((item) => (
        <li key={item.id} className="text-[13px] leading-tight">
          <span className="text-text-dim">{item.label} </span>
          <span className="font-medium text-text">{item.text}</span>
        </li>
      ))}
    </ul>
  )
}
