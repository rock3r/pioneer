# Pi compatibility

Pioneer treats Pi's command-line interface as a versioned external contract. The authoritative range and required capabilities live in [`pi-compatibility.json`](../pi-compatibility.json).

The current supported range is Pi `0.80.6` through `0.84.2`, inclusive. Older versions fail with `PI_VERSION_TOO_OLD`. A newer semantic version is allowed with `PI_VERSION_UNTESTED` on stderr and in doctor machine output so users are not blocked merely because Pi published first.

## Why the minimum is 0.80.6

The minimum is the earliest released Pi version that satisfies every Pioneer feature and safety requirement:

- RPC mode and ephemeral sessions;
- offline model enumeration;
- `--no-approve`, which prevents untrusted project-local Pi configuration from loading;
- disabled prompt-template, theme, and skill discovery where Pioneer requires it;
- every thinking level Pioneer exposes, including `max`.

Pi `0.79.0` introduced the project-trust flags, but `max` first appears in the released CLI contract at [`v0.80.6`](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/cli/args.ts). Supporting an earlier version would make either project trust or the advertised thinking-level contract conditional.

## Determining the range

For every Pioneer release:

1. Read the current upstream version:

   ```bash
   npm view @earendil-works/pi-coding-agent version
   ```

2. Compare Pi's release notes and source changes from the previous `testedMaximum` through that version. Pay particular attention to CLI argument parsing, RPC events, model-list output, configuration layout, trust behavior, thinking levels, and session/startup flags.
3. Update `testedMaximum` in `pi-compatibility.json` to the exact newest version reviewed.
4. Update the two endpoint versions in `.github/workflows/ci.yml` and `.github/workflows/release.yml`. `npm run release:verify` fails if either workflow drifts from the policy.
5. Run the compatibility smoke against both endpoints. The smoke verifies version output, every required CLI option, every required thinking level, offline model enumeration, and Pioneer's readiness behavior.
6. Run a real sandboxed review with the newest endpoint on macOS and Linux as part of the normal release validation.

`npm run pi:compat:latest` queries the official npm registry and fails unless `testedMaximum` is the current `latest`. The tagged release workflow runs this check before publication, so a new Pi release makes Pioneer fail closed at release time until maintainers review and test it.

The minimum should move only when Pioneer intentionally adopts a newer required capability or stops supporting an old Pi contract. To lower it, prove every required capability against that exact released tag and add the endpoint to the matrix first.

## Failure behavior

Pioneer parses the first line of `pi --version` as SemVer before model discovery or run-state creation:

- below `minimum`: fail with `PI_VERSION_TOO_OLD`;
- within the range: continue normally;
- above `testedMaximum`: continue with `PI_VERSION_UNTESTED`;
- non-SemVer output: fail with `PI_VERSION_UNRECOGNIZED`.

A binary claiming an in-range version but missing `--no-approve` fails with `PI_CLI_INCOMPATIBLE`. The compatibility smoke catches official-package regressions; users should reinstall an official Pi release if a custom or stale standalone binary diverges from its reported version.
