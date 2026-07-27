import type { ReactNode } from 'react'
import { Route, Switch } from 'wouter'

import { useDefaultProfile } from './lib/queries.ts'
import { Home } from './screens/Home.tsx'
import { TrackersScreen } from './screens/Trackers.tsx'

export function App() {
  const profileQuery = useDefaultProfile()
  const profile = profileQuery.data ?? null

  if (profileQuery.isPending) {
    return <Splash line="warming up" />
  }

  if (profileQuery.isError) {
    return (
      <Splash line="no connection">
        <button
          type="button"
          onClick={() => void profileQuery.refetch()}
          className="tap mt-8 h-[60px] w-full max-w-xs rounded-2xl border border-white/10 bg-ink-800 text-[17px]"
        >
          Try again
        </button>
      </Splash>
    )
  }

  if (!profile) {
    return <Splash line="no profile on the server" />
  }

  return (
    <Switch>
      <Route path="/">
        <Home profileId={profile.id} />
      </Route>
      <Route path="/trackers">
        <TrackersScreen profileId={profile.id} />
      </Route>
      <Route>
        <Splash line="nothing here" />
      </Route>
    </Switch>
  )
}

function Splash({ line, children }: { line: string; children?: ReactNode }) {
  return (
    <div className="pad-safe-x relative z-10 flex min-h-dvh flex-col items-center justify-center">
      <p className="text-[22px] font-semibold tracking-[-0.03em]">TickIt</p>
      <p className="stencil mt-3">{line}</p>
      {children}
    </div>
  )
}
