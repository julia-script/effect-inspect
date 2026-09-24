import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen.ts'

/** TanStack Start calls this per request to build the router. */
export const getRouter = () => createRouter({ routeTree, scrollRestoration: true })

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
