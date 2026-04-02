# Compose AGENTS.md

This repository contains CLI tooling for composing repository-local and user-global agent instruction files from modular rule sets.

## Compatibility

- Node.js >= 20

## Release notes

See `CHANGELOG.md` for release notes.

It is intended to be used together with shared rule modules such as the public `agent-rules` repository.

## Install (global CLI)

After publishing to npm, install globally:

```sh
npm install -g compose-agentsmd
```

This provides the `compose-agentsmd` command.

## Rules setup (this repository)

The default ruleset for this repository is `agent-ruleset.json` and currently composes the `node` domain into repository-local instructions from the shared GitHub source.

## Compose

From each project root, run:

```sh
compose-agentsmd
```

The tool reads `agent-ruleset.json` from the given root directory (default: current working directory), and writes the repository-local output file specified by the ruleset. If `output` is omitted, it defaults to `AGENTS.md`.

By default, compose also writes a `CLAUDE.md` companion file containing an `@...` import pointing to the primary output file. You can disable this with `claude.enabled: false` in the ruleset.

By default, compose writes `rules/global` to these user-global instruction files with the same composed content:

- `~/.codex/AGENTS.md`
- `~/.claude/CLAUDE.md`
- `~/.gemini/GEMINI.md`
- `~/.copilot/copilot-instructions.md`

Repository-local `AGENTS.md` contains the tool rules plus only the repository-facing rules (`domains` + `extra`). Global rules are no longer embedded into each repository output.

Each composed rule section is prefixed with the source file path that produced it.

When compose changes files, the CLI prints diffs for both repository outputs and global outputs. This works even when the project is not under git. `--quiet` and `--json` suppress this output.

## Setup (init)

For a project that does not have a ruleset yet, bootstrap one with `init`:

```sh
compose-agentsmd init --root path/to/project --yes
```

Defaults:

- `source`: `github:owner/repo@latest`
- `domains`: empty
- `extra`: empty
- `global`: omitted (defaults to `true`, meaning write user-global instruction files)
- `claude`: `{ "enabled": true, "output": "CLAUDE.md" }`
- `output`: `AGENTS.md`

Use `--dry-run` to preview actions, `--force` to overwrite existing repository output files, and `--compose` to generate instruction files immediately.

## Updating shared rules

For GitHub sources, the tool keeps two locations:

- Cache: `~/.agentsmd/cache/<owner>/<repo>/<ref>/` (read-only, used for compose)
- Workspace: `~/.agentsmd/workspace/<owner>/<repo>/` (editable)

Update flow:

```sh
compose-agentsmd edit-rules
# edit files under rules/ in the workspace
compose-agentsmd apply-rules
```

`edit-rules` clones the GitHub source into the workspace (or reuses it), then prints the workspace path, rules directory, and next steps. `apply-rules` pushes the workspace (if clean) and regenerates repository/global instruction files by refreshing the cache. If your `source` is a local path, `edit-rules` points to the local workspace and `apply-rules` skips the push.

## Project ruleset format

Ruleset files accept JSON with `//` or `/* */` comments.

```jsonc
{
  // Rules source. Use github:owner/repo@ref or a local path.
  "source": "github:owner/repo@latest",
  // Domain folders under rules/domains.
  "domains": ["node", "unreal"],
  // Additional local rule files to append.
  "extra": ["agent-rules-local/custom.md"],
  // Optional Claude Code repository companion output.
  "claude": {
    "enabled": true,
    "output": "CLAUDE.md"
  },
  // Repository output file name.
  "output": "AGENTS.md"
}
```

Ruleset keys:

- `source` (required): rules source. Use `github:owner/repo@ref` or a local path.
- `global` (optional): write `rules/global` to user-global instruction files (defaults to true). Set `false` to skip global writes.
- `domains` (optional): domain folders under `rules/domains/<domain>`.
- `extra` (optional): additional local rule files to append.
- `budget` (optional): global-rule budget thresholds in `o200k_base` tokens.
- `budget.totalTokens` (optional): total token budget for the composed global instruction output (defaults to `4500`).
- `budget.moduleTokens` (optional): per-module token budget for each composed global rule section (defaults to `400`).
- `claude` (optional): repository companion settings for Claude Code.
- `claude.enabled` (optional): enable/disable companion generation (defaults to `true`).
- `claude.output` (optional): companion file path (defaults to `CLAUDE.md`).
- `output` (optional): repository output file name (defaults to `AGENTS.md`).

When the composed global instruction output exceeds either budget, the CLI emits a warning to `stderr`. The machine-readable `--json` output includes the tokenizer name, total token count, and any over-budget modules.

### Ruleset schema validation

`compose-agentsmd` validates rulesets against `agent-ruleset.schema.json` on every run. If the ruleset does not conform to the schema, the tool exits with a schema error.

### Cache

Remote sources are cached under `~/.agentsmd/cache/<owner>/<repo>/<ref>/`. Use `--refresh` to re-fetch or `--clear-cache` to remove cached rules.

### Optional arguments

- `--root <path>`: project root (defaults to current working directory)
- `--ruleset <path>`: only compose a single ruleset file
- `--ruleset-name <name>`: override the ruleset filename (default: `agent-ruleset.json`)
- `--refresh`: refresh cached remote rules
- `--clear-cache`: remove cached remote rules and exit
- `--version` / `-V`: show version and exit
- `--verbose` / `-v`: show verbose diagnostics
- `--source <source>`: rules source for `init`
- `--domains <list>`: comma-separated domains for `init`
- `--extra <list>`: comma-separated extra rules for `init`
- `--output <file>`: repository output filename for `init`
- `--no-domains`: initialize with no domains
- `--no-extra`: initialize without extra rule files
- `--no-global`: initialize without user-global rules
- `--compose`: compose repository and user-global instruction files after `init`
- `--dry-run`: show init plan without writing files
- `--yes`: skip init confirmation prompt
- `--force`: overwrite existing files during init
- `edit-rules`: prepare or locate a writable rules workspace
- `apply-rules`: push workspace changes (if GitHub source) and regenerate rules with refresh
- `init`: generate a new ruleset and optional local rules file

## Development

```sh
npm install
npm run lint
npm run build
npm test
```

## Overview

This repository contains the compose-agentsmd project.

## Documentation

- [CHANGELOG.md](CHANGELOG.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [LICENSE](LICENSE)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
