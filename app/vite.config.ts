import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `root` is set so the app can be started from the repo root
// (`bun run dev:app`) without vite resolving entries against the root `src/`,
// which holds the protocol library, not the webapp.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
