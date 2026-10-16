# Contributing

Pioneer accepts focused fixes and improvements under the repository's [UEL-1.0 license](LICENSE).

Read [AGENTS.md](AGENTS.md), the [architecture](docs/ARCHITECTURE.md), and the [testing contract](docs/TESTING.md) before changing production behavior.

Keep source and reference grants read-only on macOS and Linux. Describe Windows isolation as instruction-only. Keep credentials out of logs and test fixtures. Pioneer must stop when it cannot validate a required security condition.

Use Node.js 22 and install dependencies without lifecycle scripts:

```bash
npm ci --ignore-scripts
npm run check
npm run package:smoke
```

Run `npm run sandbox:smoke` on macOS or Linux for sandbox changes. Windows changes must pass `npm run windows:smoke` on Windows.

Add a focused failing test before changing behavior. For releases, keep npm and all three plugin manifest versions equal.

Do not commit generated `dist/`, coverage output, credentials, Pi home snapshots, or eval run directories.

Report security-sensitive findings privately through [the security policy](.github/SECURITY.md).
