import type { ReactNode } from 'react'
import { Link, useRoute } from 'wouter'

/**
 * The bottom tab bar.
 *
 * PLAN.md replaced "no nav on Home" with a constraint rather than a ban: the
 * bar must never compete with a log target. So it is deliberately *small* —
 * 54px of chrome, 20px icons, 10px labels, sitting below the safe-area inset —
 * and every screen that owns tappable content pads itself past `--tabbar-h`
 * plus a `--tabbar-clear` thumb-slip margin. Nothing you can log lives near it.
 *
 * Colour follows THEME.md: active is soft-periwinkle, inactive is
 * lavender-grey. Both are small elements, so both may carry full chroma.
 */

interface Tab {
  href: string
  label: string
  icon: (active: boolean) => ReactNode
}

/* Timeline and Dashboard slot straight into this list when they land; the bar
   is a flex row of equal columns, so a fourth and fifth tab need no redesign. */
const TABS: Tab[] = [
  {
    href: '/',
    label: 'Log',
    icon: (active) => (
      <>
        <circle cx="12" cy="12" r="3.4" fill="currentColor" />
        <circle
          cx="12"
          cy="12"
          r="7.6"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity={active ? 0.9 : 0.55}
        />
      </>
    ),
  },
  {
    href: '/timeline',
    label: 'Timeline',
    icon: (active) => (
      <>
        <path
          d="M6 4.5v15"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity={active ? 0.9 : 0.5}
        />
        <circle cx="6" cy="8" r="2.1" fill="currentColor" />
        <circle cx="6" cy="16" r="2.1" fill="currentColor" opacity={active ? 1 : 0.75} />
        <path
          d="M11 8h8M11 16h5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    href: '/dashboard',
    label: 'Dashboard',
    // Bars rising from a baseline — the actogram the screen actually draws,
    // not a generic chart glyph.
    icon: (active) => (
      <>
        <path
          d="M4 19.2h16"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity={active ? 0.9 : 0.5}
        />
        <rect x="5.4" y="11" width="3.1" height="5.6" rx="1.55" fill="currentColor" />
        <rect
          x="10.45"
          y="6.2"
          width="3.1"
          height="10.4"
          rx="1.55"
          fill="currentColor"
          opacity={active ? 1 : 0.72}
        />
        <rect
          x="15.5"
          y="9"
          width="3.1"
          height="7.6"
          rx="1.55"
          fill="currentColor"
          opacity={active ? 1 : 0.72}
        />
      </>
    ),
  },
  {
    href: '/trackers',
    label: 'Trackers',
    icon: () => (
      <>
        <circle cx="5.5" cy="7" r="1.7" fill="currentColor" />
        <circle cx="5.5" cy="16" r="1.7" fill="currentColor" />
        <path
          d="M10.5 7h8M10.5 16h5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </>
    ),
  },
  // Profiles is deliberately NOT a tab. Switching context is something you do
  // from the Log screen's header, where you can see which profile you are in;
  // managing them is a rare housekeeping task reached from that same switcher.
  // Giving it a permanent quarter of the bar overstated how often it is used.
]

export function TabBar() {
  return (
    <nav
      aria-label="Sections"
      className="pad-safe-x fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-900/92 backdrop-blur-xl"
      style={{ paddingBottom: 'var(--safe-b)' }}
    >
      <ul className="mx-auto flex max-w-md items-stretch">
        {TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} />
        ))}
      </ul>
    </nav>
  )
}

function TabLink({ tab }: { tab: Tab }) {
  const [active] = useRoute(tab.href)

  return (
    <li className="flex-1">
      <Link
        href={tab.href}
        aria-current={active ? 'page' : undefined}
        className={`flex h-[54px] flex-col items-center justify-center gap-[5px] ${
          active ? 'text-periwinkle' : 'text-lavender'
        }`}
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
          {tab.icon(active)}
        </svg>
        <span
          className={`text-[10px] leading-none tracking-[0.04em] ${
            active ? 'font-semibold' : 'font-medium'
          }`}
        >
          {tab.label}
        </span>
      </Link>
    </li>
  )
}
