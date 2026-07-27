import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import { installOutbox } from './lib/outbox.ts'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A Pi on the LAN answers in single-digit milliseconds; a stale read is
      // never worth showing when the network is that cheap.
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: 0,
      // React Query's default `networkMode: 'online'` *pauses* a mutation while
      // the browser reports no connection and runs it on reconnect. That is the
      // wrong shape entirely here: every write now goes to IndexedDB first, so
      // there is nothing to wait for — and a paused mutation would stamp
      // `startAt` at the moment the network came back rather than the moment of
      // the tap, which is precisely the bug the outbox exists to prevent.
      // Retries and backoff belong to the queue, not to the query client.
      networkMode: 'always',
    },
  },
})

// Before the first render, deliberately: anything left in the queue from a
// previous session starts flushing as the app opens, whether or not the user
// goes anywhere near the Log screen.
installOutbox(queryClient)

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
