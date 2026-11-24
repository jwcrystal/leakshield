# pi package installation from a built npm artifact

Date: 2026-11-24. pi **1.6.0**, Linux, Node **22.19.0** and **24.22.3**.
Source base: `8e83b91` plus this package-install patch. These checks do not
publish a release or establish that the registry's 0.3.1 contains pi support.

## Result

The same LeakShield package can expose its existing OpenCode root entry and an
explicit pi extension through `pi.extensions`. Both Node versions passed the
packed-artifact checks for Chat Completions, Anthropic Messages and Responses:

| Check, per API | Node 22.19.0 | Node 24.22.3 |
|---|---|---|
| Real `pi install <installed-package-directory>` exits successfully | pass | pass |
| Registration is in `settings.packages`, without an explicit extension entry | pass | pass |
| Packaged CLI doctor recognizes the registration with `PARTIAL` coverage | pass | pass |
| Real pi completes one model request | pass | pass |
| Recorder sees no original synthetic canary and does see a placeholder | pass | pass |
| Displayed reply restores the synthetic value | pass | pass |
| Real `pi remove <same-directory>` clears the registration | pass | pass |

The runner also checks that the tarball includes the compiled extension, its
installed manifest declares the expected path and `pi-package` keyword, and
the unchanged OpenCode root entry can be imported from the installed artifact.

## Reproduction

Install pi 1.6.0 separately; no host dependency is added to LeakShield:

```bash
npm ci
npm run build
piRuntimeDir="$(mktemp -d)"
npm install --prefix "$piRuntimeDir" --cache "$piRuntimeDir/npm-cache" \
  --ignore-scripts --save-exact @earendil-works/pi-coding-agent@1.6.0
node scripts/e2e/run-pi-package.mjs "$piRuntimeDir/node_modules/.bin/pi"
```

Select each tested Node version on `PATH` as well as for the runner: pi's
executable uses its Node shebang. The runner packs the existing build with
`npm pack --ignore-scripts`, installs that tarball into a fresh npm prefix, and
uses the resulting package directory with real pi. Each API uses isolated
agent/settings/model directories and a recording provider on `127.0.0.1`.
Only synthetic keys and canaries are used. Failed checks keep their temporary
artifacts; successful runs remove them.

## Doctor boundaries

The doctor reads supported user `settings.packages` entries, the installed
manifest and the declared extension file. Standard `npm:leakshield` entries
(including versioned specifications) and supported local-directory entries are
recognized. It does not execute package code, install packages or prove live
interception. It reports missing/broken entries and disabled extensions rather
than treating a source name alone as proof of protection.

Package/CLI/project load order is not established, so valid package
registrations produce a warning and `PARTIAL`. Other resource filters, git
packages and project-only registrations remain unverified. pi can skip a
package that fails to install/load and continue running, so a synthetic
runtime check remains necessary after installation.

## Limits

This tests an unpublished artifact installed by npm and then registered through
pi's local-package command. It does not fetch `npm:leakshield` from the public
registry, test git/project-trust workflows, verify Windows, or measure real
provider availability. The package version remains 0.3.1 in this patch; that
filename is a local build, not the existing public release. The manifest is
ready for npm-source discovery when a new version is published. Wire defaults,
masking policy and the pi hook-only decision remain unchanged.
