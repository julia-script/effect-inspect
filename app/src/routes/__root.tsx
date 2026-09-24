/// <reference types="vite/client" />
import { RegistryContext, RegistryProvider } from '@effect/atom-react'
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { type ReactNode, useContext, useEffect } from 'react'
import { startPanelSync } from '../state/panels.ts'
import { startThemeSync, THEME_BOOT_SCRIPT } from '../state/theme.ts'
import styles from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'effect-inspect' },
    ],
    links: [{ rel: 'stylesheet', href: styles }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      {/* One registry for the whole app, so the connection atom is shared. */}
      <RegistryProvider>
        <ThemeSync />
        <PanelSync />
        <Outlet />
      </RegistryProvider>
    </RootDocument>
  )
}

/**
 * Owns the `dark` class on `<html>` for the life of the app.
 *
 * Renders nothing: the theme is not React state that something displays, it is
 * a property of the document. One component starts the sync, everything else —
 * the toggle, the flame chart — reads atoms.
 */
function ThemeSync() {
  const registry = useContext(RegistryContext)
  useEffect(() => startThemeSync(registry), [registry])
  return null
}

/**
 * Adopts and persists the side panels' collapse state.
 *
 * Separate from `ThemeSync` because they own different storage keys and have
 * different failure modes: the theme has a boot script and a flash to avoid,
 * the panels have neither.
 */
function PanelSync() {
  const registry = useContext(RegistryContext)
  useEffect(() => startPanelSync(registry), [registry])
  return null
}

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    // Dark is the default and is what the server renders, so a dark-theme user
    // — the common case — gets the right markup with no client correction at
    // all. `suppressHydrationWarning` is required because the boot script below
    // may have already changed this class before React hydrates, and that
    // divergence is the point rather than a bug.
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/*
         * Runs before the body paints, and before any module is fetched.
         *
         * This is the no-flash mechanism: `localStorage` and
         * `prefers-color-scheme` do not exist on the server, so the rendered
         * `class="dark"` is a guess. Correcting it in an effect would mean a
         * dark frame for every light-theme user. Correcting it synchronously
         * here means there is no frame to see.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
