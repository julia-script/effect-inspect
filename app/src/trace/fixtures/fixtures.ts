/**
 * Committed trace files, so a test can load a real 13k-span trace without a
 * collector, a browser, or an example program.
 *
 * Stored gzipped: the raw file is 6.5MB of NDJSON and compresses 16x, which is
 * the difference between a fixture that belongs in git and one that does not.
 *
 * Reads with `node:fs` rather than `FileSystem` from Effect, and `.oxlintrc.json`
 * exempts this directory for it: this is test scaffolding that has to be callable
 * from a plain synchronous `bun test`, which is the entire point of the fixture.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

/**
 * A real `bun run example:firehose 13000` run against the real collector,
 * saved from the webapp: 13,131 spans, 3 logs, 2 span events, 3 rows deep.
 */
export const firehoseTraceFile = (): string =>
  gunzipSync(
    readFileSync(fileURLToPath(new URL('./firehose.eitrace.gz', import.meta.url))),
  ).toString('utf8')
