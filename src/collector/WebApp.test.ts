import { describe, expect, it } from 'bun:test'
import { Effect, FileSystem } from 'effect'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import { webAppFromDirectory } from './WebApp.ts'

const withApp = (test: (fetch: (request: Request) => Promise<Response>) => Effect.Effect<void>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        yield* fs.makeDirectory(`${directory}/assets`)
        yield* fs.writeFileString(`${directory}/index.html`, '<!doctype html><div id="root"></div>')
        yield* fs.writeFileString(`${directory}/assets/index-abc.js`, 'console.log("foldkit")')
        yield* fs.writeFileString(`${directory}/assets/index-abc.css`, 'body { color: red }')
        const fetch = yield* webAppFromDirectory(new URL(`file://${directory}/`))
        yield* test(fetch)
      }),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  )

describe('Foldkit webapp assets', () => {
  it('serves the SPA document and themed not-found entry with correct status', () =>
    withApp((fetch) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => fetch(new Request('http://localhost/')))
        expect(root.status).toBe(200)
        expect(root.headers.get('content-type')).toContain('text/html')
        expect(yield* Effect.promise(() => root.text())).toContain('id="root"')
        const missing = yield* Effect.promise(() => fetch(new Request('http://localhost/unknown')))
        expect(missing.status).toBe(404)
        expect(yield* Effect.promise(() => missing.text())).toContain('id="root"')
      }),
    ))
  it('serves hashed JS and CSS with immutable caching and rejects missing or unsafe assets', () =>
    withApp((fetch) =>
      Effect.gen(function* () {
        const script = yield* Effect.promise(() =>
          fetch(new Request('http://localhost/assets/index-abc.js')),
        )
        expect(script.headers.get('content-type')).toBe('text/javascript')
        expect(script.headers.get('cache-control')).toContain('immutable')
        expect(yield* Effect.promise(() => script.text())).toContain('foldkit')
        const css = yield* Effect.promise(() =>
          fetch(new Request('http://localhost/assets/index-abc.css')),
        )
        expect(css.headers.get('content-type')).toBe('text/css')
        const missing = yield* Effect.promise(() =>
          fetch(new Request('http://localhost/assets/missing.js')),
        )
        expect(missing.status).toBe(404)
        const unsafe = yield* Effect.promise(() =>
          fetch(new Request('http://localhost/assets/a%2Fb.js')),
        )
        expect(unsafe.status).toBe(404)
      }),
    ))
})
