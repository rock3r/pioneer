# Pi compatibility

Pioneer checks Pi's command-line interface against a versioned contract. [`pi-compatibility.json`](../pi-compatibility.json) defines the supported range and required capabilities.

Pioneer supports Pi `0.80.6` through `1.2.0`, inclusive. Older versions fail with `PI_VERSION_TOO_OLD`. Newer semantic versions continue with `PI_VERSION_UNTESTED` on stderr and in doctor machine output. Resume requires the current Pi version to match the stored version exactly.

## Why the minimum is 0.80.6

The minimum is the earliest released Pi version that satisfies every Pioneer feature and safety requirement:

- RPC mode and ephemeral sessions;
- offline model enumeration;
- `--no-approve`, which prevents untrusted project-local Pi configuration from loading;
- disabled prompt-template, theme, and skill discovery where Pioneer requires it;
- every thinking level Pioneer exposes, including `max`.
- RPC mode accepts the private `--session-dir` / exact `--session` recovery paths used by resumable reviews; a compatibility update must verify both flags and the on-disk session contract without parsing session content.

Pi `0.79.0` introduced the project-trust flags, but `max` first appears in the released CLI contract at [`v0.80.6`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/cli/args.ts). Supporting an earlier version would make either project trust or the advertised thinking-level contract conditional.

## Determining the range

For every Pioneer release:

1. Read the current upstream version:

   ```bash
   npm view @earendil-works/pi-coding-agent version
   ```

2. Compare Pi's release notes and source changes from the previous `testedMaximum` through that version.
   Check CLI parsing, RPC events, model-list output, configuration layout, project trust, thinking levels, and session/startup flags.
3. Update `testedMaximum` in `pi-compatibility.json` to the exact newest version reviewed.
4. Update the two endpoint versions in `.github/workflows/ci.yml` and `.github/workflows/release.yml`. `npm run release:verify` fails if either workflow drifts from the policy.
5. Run the compatibility smoke against both endpoints. The smoke verifies version output, every required CLI option, every required thinking level, offline model enumeration, and Pioneer's readiness behavior.
6. Run a real sandboxed review with the newest endpoint on macOS and Linux as part of the normal release validation.

`npm run pi:compat:latest` queries the official npm registry. It fails unless `testedMaximum` equals `latest`. Tagged releases run this check before publication. Maintainers must review and test each new Pi release before publishing Pioneer.

The minimum should move only when Pioneer intentionally adopts a newer required capability or stops supporting an old Pi contract. To lower it, prove every required capability against that exact released tag and add the endpoint to the matrix first.

## Failure behavior

Pioneer parses the first line of `pi --version` as SemVer before model discovery or run-state creation:

- below `minimum`: fail with `PI_VERSION_TOO_OLD`;
- within the range: continue normally;
- above `testedMaximum`: continue with `PI_VERSION_UNTESTED`;
- non-SemVer output: fail with `PI_VERSION_UNRECOGNIZED`.

Resume requires an exact match between stored and current Pi versions. A mismatch fails with `[REVIEW_RESUME_PI_VERSION_MISMATCH]`. Start a fresh review to create an archive for the current version.

Deep review loads the bundled inspection extension with `--extension PATH` and disables discovery with `--no-extensions`. Pi still honors explicit extension paths. Actors also receive `--no-builtin-tools` and an allowlist containing only inspection-extension tool names.

Review, deep-review, and eval Pi actors receive `--no-mcp` on Pi 1.0.4 or newer. A tool-restricted Pi actor with no known launch version fails with `[PI_NO_MCP_VERSION_UNKNOWN]`. Custom non-Pi eval actors receive no such flag.

A binary claiming an in-range version but missing `--no-approve` fails with `PI_CLI_INCOMPATIBLE`. The compatibility smoke catches official-package regressions; users should reinstall an official Pi release if a custom or stale standalone binary diverges from its reported version.
