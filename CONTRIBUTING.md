# Contributing

Pioneer accepts focused fixes and improvements under the repository's [UEL-1.0 license](LICENSE).

Read [AGENTS.md](AGENTS.md), the [architecture](docs/ARCHITECTURE.md), and the [testing contract](docs/TESTING.md) before changing production behavior. Preserve the fail-closed model: source and reference grants stay read-only on macOS and Linux, Windows never claims enforced isolation, and credentials must not appear in logs or test fixtures.

Use Node.js 22 and install dependencies without lifecycle scripts:

```bash
npm ci --ignore-scripts
npm run check
npm run package:smoke
```

Run `npm run sandbox:smoke` on macOS or Linux for sandbox changes. Windows changes must pass `npm run windows:smoke` on Windows and build the AppContainer prototype.

Add the narrowest failing test before changing behavior. Keep npm and both plugin manifest versions synchronized for release changes. Do not commit generated `dist/`, coverage output, credentials, Pi home snapshots, or eval run directories.

Report security-sensitive findings privately through [the security policy](.github/SECURITY.md).
