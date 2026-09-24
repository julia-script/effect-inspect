import { Effect } from 'effect'

/** Serves the built TanStack Start app from paths relative to this package. */
export const loadWebApp = Effect.gen(function* () {
  const serverEntry = new URL('../../app/dist/server/server.js', import.meta.url)
  const clientRoot = new URL('../../app/dist/client/', import.meta.url)
  const app = (yield* Effect.promise(() => import(serverEntry.href))) as {
    readonly default: { readonly fetch: (request: Request) => Promise<Response> }
  }

  return (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path.startsWith('/assets/')) {
      const file = Bun.file(new URL(`.${path}`, clientRoot))
      return file
        .exists()
        .then((exists) =>
          exists ? new Response(file) : new Response('Not found', { status: 404 }),
        )
    }
    return app.default.fetch(request)
  }
})
