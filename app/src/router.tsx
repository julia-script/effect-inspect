import { createRouter, Link } from '@tanstack/react-router'
import { FileQuestion } from 'lucide-react'
import { Empty } from './components/Panel.tsx'
import { routeTree } from './routeTree.gen.ts'

/**
 * Shown for any URL the route tree does not match.
 *
 * Configured at the router rather than per route because the app is a
 * single-page inspector: `/` is the only real route, so *every* miss is the
 * same miss, and a `notFoundComponent` on each route would be the same
 * component repeated. Without this, TanStack falls back to a bare
 * `<p>Not Found</p>` that ignores the theme entirely — which is what a stray
 * request (a probe for `/favicon.ico`, a stale bookmark) would otherwise render.
 */
const NotFound = () => (
  <div className="flex h-screen flex-col items-center justify-center bg-page font-mono text-ink antialiased">
    <Empty
      icon={FileQuestion}
      title="No such page"
      hint={
        <>
          effect-inspect is a single page. Head back to{' '}
          <Link to="/" className="text-accent underline underline-offset-2">
            the inspector
          </Link>
          .
        </>
      }
    />
  </div>
)

/** TanStack Start calls this per request to build the router. */
export const getRouter = () =>
  createRouter({ routeTree, scrollRestoration: true, defaultNotFoundComponent: NotFound })

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
