import { Effect } from 'effect'
// Reading packaged assets is a Node runtime boundary; the app itself returns Web Responses.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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
      const name = path.slice('/assets/'.length)
      if (!/^[\w.-]+$/.test(name))
        return Promise.resolve(new Response('Not found', { status: 404 }))
      const file = fileURLToPath(new URL(`assets/${name}`, clientRoot))
      return readFile(file).then(
        (bytes) =>
          new Response(bytes, {
            headers: { 'content-type': name.endsWith('.css') ? 'text/css' : 'text/javascript' },
          }),
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return new Response('Not found', { status: 404 })
          throw error
        },
      )
    }
    return app.default.fetch(request)
  }
})
