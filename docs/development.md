# Development, testing and packaging

Use Node 24 (`.nvmrc`) and the pnpm version pinned in `package.json`.
Production API runtime support is separate from this development toolchain;
see [runtime and operations](runtime-and-operations.md).

```sh
nvm install
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm browser:install
corepack pnpm package
```

If Linux browser dependencies are missing, install them explicitly:

```sh
corepack pnpm --filter @ungate/scripts exec playwright install --with-deps chromium
```

Playwright is a development requirement, not a requirement for VSIX users.
With [Task](https://taskfile.dev/docs/installation) installed:

```sh
task setup
task check
task package
```

`Taskfile.yml` delegates to the same package scripts. Ordered operations run
sequentially. Normal `package` builds, checks types, lints, runs API/extension
tests, exercises HTTP and real-process coordination, runs the built dashboard
in Chromium, stages a clean extension, verifies actual VSIX entries and hashes,
and smoke-tests the bundled API. The artifact is written to
`apps/extension/out/ungate-1.7.14.vsix`.

`corepack pnpm package:vsix` is a faster build-and-package path for iteration,
not a replacement for complete `package` checks. `task install` explicitly
runs checks and installs the verified package using Cursor CLI. Builds do not
install or publish automatically.

Select an existing compatible browser with `UNGATE_CHROMIUM_EXECUTABLE_PATH`;
`UNGATE_CHROMIUM_ARGS` accepts a JSON array for constrained environments.
The default uses Playwright Chromium; no browser binary ships in VSIX.

The Node packaging pipeline replaces platform-specific shell copies. Legacy
`scripts/build-package/run.sh` delegates to the same pipeline. Local automated
checks do not establish live provider, Remote SSH or cross-platform acceptance;
verify those paths in the target environment.

[Cursor compatibility evidence](cursor-compatibility.md) records historical
test/package results and their limitations. Documentation is not loaded by the
extension or API; [AGENTS.md](../AGENTS.md) provides coding-agent architecture
and implementation constraints. Return to the [README](../README.md).
