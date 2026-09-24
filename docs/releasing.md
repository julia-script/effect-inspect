# Releasing `effect-inspect`

Changesets records user-visible changes and prepares version and changelog commits. Publishing is an explicit GitHub Actions run after its version PR is merged; no npm publish token is stored in GitHub.

## One-time setup

The package must be public (`private: false`), have a version, and set `repository.url` in `package.json` to this repository before publishing. The installed CLI supports Node.js 22 or newer without Bun. Check the tarball with `npm pack --dry-run`, install it in a clean Node-only project to run `effect-inspect start`, and verify the package name is available on npm.

An npm package must already exist before its trusted publisher can be configured. A maintainer must bootstrap the first release locally with npm login and 2FA:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
npm pack --dry-run
npm login
npm publish --access public
```

This first publish is the only publish that requires local npm authentication. Do not run the GitHub publish workflow until the npm trusted publisher is configured.

On npmjs.com, open **effect-inspect → Settings → Trusted publishing**, choose **GitHub Actions**, and enter:

| Field                | Value                                                        |
| -------------------- | ------------------------------------------------------------ |
| Organization or user | `julia-script`                                               |
| Repository           | `effect-inspect`                                             |
| Workflow filename    | `publish.yml` (filename only, not the path)                  |
| Environment          | Leave blank (the workflow does not use a GitHub environment) |
| Allowed actions      | Allow direct `npm publish`                                   |

The workflow file is `.github/workflows/publish.yml`. Its job runs on a GitHub-hosted runner with `id-token: write`, Node 24, and npm 11.15 or newer. npm exchanges the job's OIDC identity for a short-lived publishing credential; there is no `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret. The `GITHUB_TOKEN` in the separate Changesets workflow is only for creating version PRs. In GitHub **Settings → Actions → General**, allow GitHub Actions to create and approve pull requests so that workflow can create its PR.

The npm settings must match the GitHub repository and workflow filename exactly. If the repository is renamed or the workflow file is renamed, update the npm trusted publisher connection. Once OIDC publishing works, npm recommends restricting traditional token-based publishing access in the package's **Publishing access** settings.

## Subsequent releases

1. For a change that should release, run `bunx changeset`, select `effect-inspect`, choose the semver bump, and commit the generated `.changeset/*.md` file with the change. For an internal-only change, run `bunx changeset --empty` if a changeset is expected by review policy.
2. On pushes to `main`, `.github/workflows/changesets.yml` opens or updates a **Version Packages** PR. Its `changeset version` step consumes the pending changesets and updates `package.json` and `CHANGELOG.md`. Review and merge that PR.
3. In GitHub Actions, run **Publish to npm** from the `main` branch. `.github/workflows/publish.yml` installs dependencies, runs format/lint/type checks, tests, build, and a package dry run before `npm publish --access public`. Confirm the package version is new before dispatching; npm rejects publishing an existing version.

Trusted publishing requires npm 11.5.1 or newer and a GitHub-hosted runner. The workflow installs npm 11.15 or newer. A failed OIDC publish should first be checked against the exact npm trusted-publisher fields, `id-token: write`, and the `repository.url` in `package.json`.

Sources: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm trust command and package prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/), [Changesets action](https://github.com/changesets/action/tree/maintenance/v1).
