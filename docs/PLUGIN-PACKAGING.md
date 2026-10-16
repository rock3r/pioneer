# Plugin packaging

## Shared payload

The publishable plugin lives at `plugins/pioneer/`:

```text
plugins/pioneer/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── assets/
│   ├── pioneer-banner.jpg
│   └── pioneer-mascot.png
├── LICENSE
├── README.md
├── plugin.json
└── skills/pioneer/
    ├── evals/evals.json
    └── SKILL.md
```

Agent Plugins v1 clients, Codex, and Claude Code load the same skill. It calls the installed `pioneer` executable. Users install Pi and configure provider credentials separately.

## Portable Agent Plugins definition

The root `plugin.json` follows [Agent Plugins v1](https://agent-plugins.org/specification) and its `1.0.0` schema. It uses only the allowed portable metadata fields. Clients discover skills under the fixed `skills/` path. Pioneer has no Model Context Protocol (MCP) server, so the package omits the optional `mcp.json`.

Each client defines installation and marketplace behavior. Point its installer at `plugins/pioneer/`. Client-specific manifests supply additional package or interface metadata.

Validate the portable manifest, shared Agent Skill, and cross-manifest identity with the offline repository contract test:

```bash
npm test -- src/branding.test.ts
```

## Codex definition

`.codex-plugin/plugin.json` defines the stable name, semantic version, UEL license identifier, skill path, and Codex interface metadata. Composer, light, and dark logos all use `assets/pioneer-mascot.png`. `.agents/plugins/marketplace.json` defines the installable repository/team marketplace named `pioneer`.

Validate the plugin with the locally installed plugin-creator validator:

```bash
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/pioneer
```

Install the repo marketplace during local development:

```bash
codex plugin marketplace add /absolute/path/to/pioneer
codex plugin add pioneer@pioneer
```

The repository does not write or assume a user's personal Codex marketplace. A remote publisher can catalog the same plugin directory without changing its contents.

## Claude Code definition

`.claude-plugin/marketplace.json` makes the repository a Claude Code marketplace named `pioneer`. Its relative source points to `./plugins/pioneer`, whose `.claude-plugin/plugin.json` declares the shared skill.

Claude Code's plugin and marketplace schemas have no icon or logo field. The shared package includes the mascot. Claude Code cannot display it as a plugin logo with these schemas.

Validate both marketplace and plugin from the repository root:

```bash
claude plugin validate . --strict
```

Install locally during development:

```text
/plugin marketplace add /absolute/path/to/pioneer
/plugin install pioneer@pioneer
/reload-plugins
```

## CLI prerequisite

Users must install the CLI, configure Pi, and run readiness checks separately. Plugin installation must never silently run package-manager lifecycle actions or copy provider credentials.

## Versioning

The npm package and all three plugin manifests use the same semantic version. Update all four fields for each release. Claude Code uses the manifest version as its cache/update key. Changes without a version increase do not update existing installations.

Keep the stable identifier `pioneer`. Change display text rather than renaming the identifier, because installed plugin settings and skill namespaces depend on it.

## Release checklist

1. Update the shared skill and user guide together when CLI behavior changes.
2. Keep the portable, Codex, and Claude manifest versions equal and keep the plugin-local UEL text synchronized with the root license.
3. Validate the portable manifest and Agent Skill, the Codex plugin and repo marketplace, and the Claude marketplace and plugin.
4. Run `npm run check` and `npm run sandbox:smoke` on macOS and Linux.
5. Confirm `pioneer doctor` and `pioneer eval --help` against a configured Pi installation.
6. Run the two independent user-selected model/provider reviews through Pioneer required by the release process.
7. Tag only after the plugin payload, CLI documentation, and UEL license are final.
