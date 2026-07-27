import type { ReactNode } from 'react'
import { Link, Route, Switch } from 'wouter'

import { OutboxStatus } from './components/OutboxStatus.tsx'
import { TabBar } from './components/TabBar.tsx'
import { useProfileSelection } from './lib/profile.ts'
import { useProfiles } from './lib/queries.ts'
import { DashboardScreen } from './screens/Dashboard.tsx'
import { Home } from './screens/Home.tsx'
import { ProfilesScreen } from './screens/Profiles.tsx'
import { TimelineScreen } from './screens/Timeline.tsx'

export function App() {
  const profilesQuery = useProfiles()
  const { profile, selectable, select } = useProfileSelection(profilesQuery.data)

  if (profilesQuery.isPending) {
    return (
      <>
        <OutboxStatus />
        <Splash line="warming up" />
      </>
    )
  }

  // Reads fail honestly — a stale health log presented as current is worse than
  // an error. Writes do not: the outbox pill rides along on this screen so a
  // queue that is waiting out the outage is visible from the one place the app
  // can still be seen when everything else is unreachable.
  if (profilesQuery.isError) {
    return (
      <>
        <OutboxStatus />
        <Splash line="no connection">
          <button
            type="button"
            onClick={() => void profilesQuery.refetch()}
            className="tap mt-8 h-[60px] w-full max-w-xs rounded-2xl border border-ink-600 bg-ink-800 text-[17px]"
          >
            Try again
          </button>
        </Splash>
      </>
    )
  }

  return (
    <>
      <OutboxStatus />

      <Switch>
        <Route path="/">
          {profile ? (
            <Home profile={profile} profiles={selectable} onSelectProfile={select} />
          ) : (
            <NoProfile />
          )}
        </Route>

        <Route path="/timeline">
          {profile ? <TimelineScreen profile={profile} /> : <NoProfile />}
        </Route>

        <Route path="/dashboard">
          {profile ? <DashboardScreen profile={profile} /> : <NoProfile />}
        </Route>

        {/* There is no /trackers route. Managing trackers is the Log screen's
            edit mode; a saved link to the old screen falls through to the
            catch-all, which is the honest answer — it no longer exists. */}
        <Route path="/profiles">
          <ProfilesScreen selectedId={profile?.id ?? null} onSelectProfile={select} />
        </Route>

        <Route>
          <Splash line="nothing here" />
        </Route>
      </Switch>

      <TabBar />
    </>
  )
}

/**
 * Every profile has been deleted. Nothing can be logged without a context to
 * log it in, so the only thing on offer is making one.
 */
function NoProfile() {
  return (
    <Splash line="no profile">
      <p className="mt-5 max-w-xs text-center text-[17px] leading-snug text-balance text-text-dim">
        A profile is the context you log in. There has to be one.
      </p>
      <Link
        href="/profiles"
        className="tap mt-7 flex h-[60px] w-full max-w-xs items-center justify-center rounded-2xl bg-periwinkle text-[17px] font-semibold text-ink-900"
      >
        Create a profile
      </Link>
    </Splash>
  )
}

function Splash({ line, children }: { line: string; children?: ReactNode }) {
  return (
    <div className="pad-safe-x pad-tabs relative z-10 flex min-h-dvh flex-col items-center justify-center">
      <p className="lockup text-[22px] font-semibold tracking-[-0.03em]">TickIt</p>
      <p className="stencil mt-3">{line}</p>
      {children}
    </div>
  )
}
