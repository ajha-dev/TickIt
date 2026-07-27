import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface SheetProps {
  open: boolean
  onClose: () => void
  /** Small tracked label above the title. */
  eyebrow?: string
  title: string
  /** One line of consequence-stating copy. Never "Are you sure?". */
  body?: ReactNode
  children: ReactNode
}

/**
 * A bottom sheet. Everything interactive sits at the bottom of the screen,
 * inside the thumb arc — a centred dialog would put the confirm button in the
 * middle of the display where one hand cannot reach it.
 */
export function Sheet({ open, onClose, eyebrow, title, body, children }: SheetProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  // Portalled to <body> deliberately: every screen root establishes its own
  // stacking context, so a sheet rendered inside one would sit *under* the tab
  // bar however high its z-index. A modal has to cover the navigation.
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="anim-fade absolute inset-0 bg-black/72 backdrop-blur-[3px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="anim-rise pad-safe-x pad-safe-bottom relative max-h-[90dvh] w-full overflow-y-auto overscroll-contain rounded-t-[26px] border-t border-ink-600 bg-ink-800 pt-3 shadow-[0_-30px_60px_-20px_rgba(0,0,0,0.9)]"
      >
        <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-ink-600" />

        {eyebrow ? <p className="stencil mb-2.5">{eyebrow}</p> : null}
        <h2 className="text-[26px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance">
          {title}
        </h2>
        {body ? (
          <div className="mt-2.5 text-[15px] leading-snug text-text-dim">{body}</div>
        ) : null}

        <div className="mt-7 flex flex-col gap-2.5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

type ButtonTone = 'primary' | 'danger' | 'quiet'

const TONES: Record<ButtonTone, string> = {
  // Soft-periwinkle is the primary accent; wisteria is its pressed state.
  primary: 'bg-periwinkle text-ink-900 border-transparent font-semibold active:bg-wisteria',
  // Warm, and only ever Stop or Delete.
  danger: 'bg-ember text-ink-900 border-transparent font-semibold',
  quiet: 'bg-ink-700 text-text border-ink-600',
}

/** Full-width, 60px tall. Sized to be hit without aiming. */
export function SheetButton({
  tone = 'quiet',
  onClick,
  disabled,
  children,
}: {
  tone?: ButtonTone
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`tap flex h-[60px] w-full items-center justify-center rounded-2xl border text-[17px] tracking-[-0.01em] disabled:opacity-40 ${TONES[tone]}`}
    >
      {children}
    </button>
  )
}
