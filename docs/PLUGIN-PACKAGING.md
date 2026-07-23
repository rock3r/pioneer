# Plugin packaging

## Shared payload

The publishable plugin lives at `plugins/pioneer/`:

```text
plugins/pioneer/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── LICENSE
├── README.md
└── skills/pioneer/SKILL.md
```

Codex and Claude Code load the same skill. The skill delegates to the installed `pioneer` executable; it does not contain a second implementation, bundle Pi, or carry provider credentials.

## Codex definition

`.codex-plugin/plugin.json` contains the stable plugin name, semantic version, UEL license identifier, skill path, and Codex interface metadata. Its composer, light, and dark logo fields share `assets/pioneer-mascot.png`. `.agents/plugins/marketplace.json` makes the checkout an explicitly installable repo/team marketplace named `pioneer`.

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

Claude Code's current plugin manifest and marketplace schemas do not expose an icon or logo field. The mascot remains in the shared plugin payload, but Claude cannot display a plugin-specific logo until its schema adds that capability.

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

Plugin installation does not install the Pioneer CLI or Pi itself. This is deliberate: agent plugins should not silently execute package-manager lifecycle actions or copy provider credentials. Users install the CLI, configure Pi, and run readiness checks separately.

## Versioning

The npm package and both plugin manifests use the same semantic version. Bump all three together for every published release. Claude Code treats an explicit manifest version as its cache/update key; pushing changes without a version bump does not update existing installations.

Keep the stable identifier `pioneer`. Change display text rather than renaming the identifier, because installed plugin settings and skill namespaces depend on it.

## Release checklist

1. Update the shared skill and user guide together when CLI behavior changes.
2. Keep both manifest versions equal and keep the plugin-local UEL text synchronized with the root license.
3. Validate the Codex plugin and repo marketplace plus the Claude marketplace and plugin.
4. Run `npm run check` and `npm run sandbox:smoke` on macOS and Linux.
5. Confirm `pioneer-eval doctor` against a configured Pi installation.
6. Test a real review through each agent client.
7. Tag only after the plugin payload, CLI documentation, and UEL license are final.
