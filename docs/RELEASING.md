# Releasing

Releases publish one public npm CLI package and the matching Codex and Claude plugin payload from the same tagged source tree.

## One-time setup

1. Publish the repository at `https://github.com/rock3r/pioneer` and set that URL as `origin`. npm provenance requires the repository URL in `package.json` to match exactly.
2. Ensure the npm account or organization owns the `@rock3r` scope. The scoped package identity is `@rock3r/pioneer`; do not substitute the unrelated unscoped package.
3. Create a protected GitHub environment named `npm` and require reviewer approval if desired.
4. Configure npm trusted publishing for GitHub repository `rock3r/pioneer`, workflow `release.yml`, environment `npm`, and the `npm publish` action. The checked-in workflow uses OIDC and must not receive an `NPM_TOKEN`.
5. Set package publishing access to require two-factor authentication and disallow traditional tokens. Retain the trusted relationship so GitHub Actions can publish with provenance.

The workflow uses a GitHub-hosted Ubuntu runner, `id-token: write`, npm 11, and public access. It never publishes from a self-hosted runner.

## Release gates

For every tag, `.github/workflows/release.yml` independently requires:

- full lint, type, test, and build checks on Ubuntu, macOS, and Windows;
- exact tag, npm package, Codex plugin, and Claude plugin version agreement;
- plugin name/skill-path integrity and byte-for-byte root/plugin UEL agreement;
- a real Seatbelt smoke battery on macOS;
- a real Bubblewrap/AppArmor smoke battery on Linux;
- Windows fail-closed CLI checks and an AppContainer prototype build;
- one npm tarball built once, installed, and invoked on all three operating systems.

Only the tarball that passed the matrix is published. A GitHub release and attached tarball are created after npm accepts the package.

## Cutting a release

1. Update `package.json` and both plugin manifests to the same semantic version.
2. Update release-facing documentation and verify the UEL text is synchronized.
3. Run locally:

   ```bash
   npm ci --ignore-scripts
   npm run check
   npm run package:smoke
   npm run sandbox:smoke
   npm run release:verify -- v0.1.0
   ```

4. Validate both plugin formats using [the plugin packaging commands](PLUGIN-PACKAGING.md).
5. Run a real review through Codex and Claude Code.
6. Commit and push the reviewed release candidate.
7. Create and push an annotated `v<version>` tag. Pushing the tag is the publication trigger.

Do not reuse or move a published version tag. If a release is defective, fix forward with a new patch version and deprecate the affected npm version when appropriate.
