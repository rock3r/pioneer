# Pioneer plugin

This directory is the shared plugin payload for Agent Plugins v1 clients, Codex, and Claude Code. The portable root [`plugin.json`](plugin.json) and both client-specific manifests discover the same `pioneer` skill; the plugin does not bundle provider credentials or the Pioneer executable.

Install the Pioneer CLI and configure Pi before installing the plugin. See the [agent-integration guide](https://github.com/rock3r/pioneer/blob/main/user-guide/plugins.md) for installation and validation instructions.
