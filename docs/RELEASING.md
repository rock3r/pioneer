# Releasing

Releases publish one public npm CLI package and the matching portable Agent Plugins, Codex, and Claude plugin payload from the same tagged source tree.

## One-time setup

1. Publish the repository at `https://github.com/rock3r/pioneer` and set that URL as `origin`. npm provenance requires the repository URL in `package.json` to match exactly.
2. Ensure the npm account or organization owns the `@rock3r` scope. The scoped package identity is `@rock3r/pioneer`; do not substitute the unrelated unscoped package.
3. Create a protected GitHub environment named `npm` and require reviewer approval if desired.
4. Configure npm trusted publishing for GitHub repository `rock3r/pioneer`, workflow `.github/workflows/release.yml`, and environment `npm`. The checked-in workflow uses OIDC and must not receive an `NPM_TOKEN`.
5. Set package publishing access to require two-factor authentication and disallow traditional tokens. Retain the trusted relationship so GitHub Actions can publish with provenance.

The workflow uses a GitHub-hosted Ubuntu runner, `id-token: write`, npm 11, and public access. It never publishes from a self-hosted runner.

## Release gates

For every tag, `.github/workflows/release.yml` independently requires:

- full lint, type, test, and build checks on Ubuntu, macOS, and Windows;
- exact tag, npm package, portable plugin, Codex plugin, and Claude plugin version agreement;
- portable schema, plugin name/skill-path integrity, and byte-for-byte root/plugin UEL agreement;
- the minimum and tested-maximum Pi releases to pass the CLI compatibility smoke;
- the checked-in Pi tested maximum to equal the official npm `latest`;
- a real Seatbelt smoke battery on macOS;
- a real Bubblewrap/AppArmor smoke battery on Linux;
- Windows fail-closed CLI checks;
- one npm tarball built once, installed, and invoked on all three operating systems.

Only the tarball that passed the matrix is published. A GitHub release and attached tarball are created after npm accepts the package. GitHub generates the release page notes from commits and merged pull requests; [the changelog](../CHANGELOG.md) is the curated, versioned user-facing record.

## Refreshing Pi compatibility

Before every release, follow [Pi compatibility](PI-COMPATIBILITY.md):

1. Run `npm view @earendil-works/pi-coding-agent version`.
2. Review upstream release notes and relevant source changes through that exact version.
3. Update `testedMaximum` in `pi-compatibility.json`.
4. Update the Pi endpoint matrices in both CI workflows.
5. Run `npm run pi:compat:latest`.
6. Install and run `npm run pi:compat:smoke -- VERSION` once for the minimum and once for the tested maximum.

Do not defer a newer Pi release to a later Pioneer release: review it, raise the tested maximum, update both endpoint matrices, and run the endpoint smokes before cutting the tag.

`npm run release:verify` rejects policy/workflow drift. The tagged release also performs the online freshness check, so publication stops if Pi releases a newer `latest` before Pioneer ships.

## Cutting a release

1. Refresh the Pi compatibility range and endpoint tests.
2. Update `package.json` and all three plugin manifests to the same semantic version.
3. Update `CHANGELOG.md`: move every applicable entry from `Unreleased` into a new `## <version> - YYYY-MM-DD` section, then leave an empty `Unreleased` heading for the next release.
4. Update other release-facing documentation and verify the UEL text is synchronized.
5. Run locally:

   ```bash
   npm ci --ignore-scripts
   npm run check
   npm run package:smoke
   npm run pi:compat:latest
   npm run sandbox:smoke
   npm run release:verify -- v0.1.3
   ```

6. Validate the portable Agent Plugins package and both native plugin formats using [the plugin packaging commands](PLUGIN-PACKAGING.md).
7. Run two independent real reviews through Pioneer. Use `pioneer models` to enumerate the configured choices, then ask the user which model and provider to use for each review before starting. For each Pioneer process, preserve the nested terminal session until it returns an exit code, then record the exit code and stdout/stderr byte counts. An intermediate empty output with a session ID is not a completed review. Use `--report /absolute/path/report.md` when a durable final report artifact is needed.
8. Commit and push the reviewed release candidate.
9. Create and push an annotated `v<version>` tag. Pushing the tag is the publication trigger.

Do not reuse or move a published version tag. If a release is defective, fix forward with a new patch version and deprecate the affected npm version when appropriate.
