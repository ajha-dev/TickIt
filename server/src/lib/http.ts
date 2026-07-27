import type { Context } from 'hono'

/** Parse a JSON request body, tolerating an empty body as `{}`. */
export async function readJson(c: Context): Promise<unknown> {
  const raw = await c.req.text()
  if (raw.trim() === '') return {}
  return JSON.parse(raw) as unknown
}

export const DEFAULT_COLOUR = '#6366f1'
export const DEFAULT_ICON = 'circle'
