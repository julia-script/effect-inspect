import { Effect } from 'effect'
// Packaged asset reads are a Node runtime boundary.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Serves the Foldkit SPA and hashed Vite assets from the installed package. */
export const webAppFromDirectory = (clientRoot: URL) =>
  Effect.gen(function* () {
    const html = yield* Effect.promise(() => readFile(new URL('index.html', clientRoot), 'utf8'))
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
              headers: {
                'content-type': name.endsWith('.css') ? 'text/css' : 'text/javascript',
                'cache-control': 'public, max-age=31536000, immutable',
              },
            }),
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return new Response('Not found', { status: 404 })
            throw error
          },
        )
      }
      return Promise.resolve(
        new Response(html, {
          status: path === '/' ? 200 : 404,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
        }),
      )
    }
  })

/** Loads the webapp packaged alongside the CLI. */
export const loadWebApp = webAppFromDirectory(new URL('../../app/dist/', import.meta.url))
