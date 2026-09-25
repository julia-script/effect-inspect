import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
// Vite config runs synchronously in plain Node, outside any Effect runtime.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Stops the dev server once whatever ran `bun run dev:app` is gone.
 *
 * Launchers that kill only a wrapping shell (agent background shells,
 * `sh -c "bun run dev:app"`) leave `bun run` and vite reparented to init and
 * holding the port; neither SIGTERM nor stdin EOF reaches vite then.
 */
// ponytail: polls every 2s; a launcher that exits on purpose right after
// starting it (e.g. `(bun run dev:app &)`) stops the server too.
const exitWithLauncher = (): Plugin => ({
  name: 'exit-with-launcher',
  apply: 'serve',
  configureServer(server) {
    if (process.platform === 'win32') return
    const parent = process.ppid
    const launcher = Number(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(parent)], { encoding: 'utf8' }),
    )
    const timer = setInterval(() => {
      if (process.ppid === parent && isAlive(launcher)) return
      clearInterval(timer)
      void server.close().finally(() => process.exit(0))
    }, 2000)
    timer.unref()
  },
})

// `root` is set so the app can be started from the repo root
// (`bun run dev:app`) without vite resolving entries against the root `src/`,
// which holds the protocol library, not the webapp.
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Next to the collector's 34437; strict so a busy port fails loudly instead
  // of silently moving to another one.
  server: { port: 34438, strictPort: true },
  plugins: [tailwindcss(), tanstackStart(), viteReact(), exitWithLauncher()],
})
