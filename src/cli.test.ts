import { describe, expect, it } from 'bun:test'

const run = (...args: ReadonlyArray<string>) =>
  Bun.spawnSync({
    cmd: [process.execPath, new URL('./cli.ts', import.meta.url).pathname, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })

describe('effect-inspect CLI', () => {
  it('shows the command tree in root help', () => {
    const result = run('--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('effect-inspect <subcommand>')
    expect(result.stdout.toString()).toContain('start')
  })

  it('shows help for the start command', () => {
    const result = run('start', '--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('effect-inspect start')
    expect(result.stdout.toString()).toContain('EFFECT_INSPECT_PORT')
  })
})
