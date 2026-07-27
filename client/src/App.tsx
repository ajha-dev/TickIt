import type { ReactNode } from 'react'
import { Link, Route, Switch } from 'wouter'

import { TabBar } from './components/TabBar.tsx'
import { useProfileSelection } from './lib/profile.ts'
import { useProfiles } from './lib/queries.ts'
import { CalendarScreen } from './screens/Calendar.tsx'
import { Home } from './screens/Home.tsx'
import { ProfilesScreen } from './screens/Profiles.tsx'
import { TimelineScreen } from './screens/Timeline.tsx'
import { TrackersScreen } from './screens/Trackers.tsx'

export function App() {
  const profilesQuery = useProfiles()
  const { profile, selectable, select } = useProfileSelection(profilesQuery.data)

  if (profilesQuery.isPending) {
    return <Splash line="warming up" />
  }

  if (profilesQuery.isError) {
    return (
      <Splash line="no connection">
        <button
          type="button"
          onClick={() => void profilesQuery.refetch()}
          className="tap mt-8 h-[60px] w-full max-w-xs rounded-2xl border border-ink-600 bg-ink-800 text-[17px]"
        >
          Try again
        </button>
      </Splash>
    )
  }

  return (
    <>
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

        <Route path="/calendar">
          {profile ? <CalendarScreen profile={profile} /> : <NoProfile />}
        </Route>

        <Route path="/trackers">
          {profile ? <TrackersScreen profile={profile} /> : <NoProfile />}
        </Route>

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
