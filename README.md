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

## Concepts

- `sources` is the ordered list of rules sources to read. Each entry is a
  `github:owner/repo@ref` reference or a local path.
- `profile` is the name of a rule bundle. Profiles are defined by each source
  in its own `agent-profiles.json`, not by the consuming repository.
- A profile selects which rule domains (`rules/domains/<domain>`) are composed.
  The consuming repository never lists domains directly, and never enumerates
  extra or local rule files.

## Compose

From each project root, run:

```sh
compose-agentsmd
```

The tool reads `agent-ruleset.json` from the given root directory (default: current working directory), and writes the repository-local output file specified by the ruleset. If `output` is omitted, it defaults to `AGENTS.md`.

By default, compose also writes a `CLAUDE.md` companion file containing an `@...` import pointing to the primary output file. You can disable this with `claude.enabled: false` in the ruleset.

By default, compose writes each source's `rules/global` to these user-global instruction files with the same composed content:

- `~/.codex/AGENTS.md`
- `~/.config/opencode/AGENTS.md`
- `~/.claude/CLAUDE.md`
- `~/.gemini/GEMINI.md`
- `~/.copilot/copilot-instructions.md`

Repository-local `AGENTS.md` contains the tool rules plus only the repository-facing rules selected by the profile. Global rules are not embedded into each repository output.

Each composed rule section is prefixed with the source file path that produced it.

When compose changes files, the CLI prints diffs for both repository outputs and global outputs. This works even when the project is not under git. `--quiet` and `--json` suppress this output.

## Check

Verify that the generated repository outputs are up to date without writing anything:

```sh
compose-agentsmd check
```

`check` composes the desired repository outputs in memory and compares them to the files on disk. It compares `AGENTS.md` and, when `claude.enabled` is true, the Claude companion (`CLAUDE.md`). It never writes files and never inspects the user-global outputs.

- Exit code `0`: repository outputs match.
- Exit code `1`: at least one repository output is stale. The command lists which outputs are stale.

## Setup (init)

For a project that does not have a ruleset yet, bootstrap one with `init`:

```sh
compose-agentsmd init --root path/to/project --yes
```

Defaults:

- `sources`: `["github:owner/repo"]`
- `profile`: `node-cli`
- `global`: omitted (defaults to `true`, meaning write user-global instruction files)
- `claude`: `{ "enabled": true, "output": "CLAUDE.md" }`
- `output`: `AGENTS.md`

Pass `--profile <name>` to set the profile. Use `--dry-run` to preview actions, `--force` to overwrite existing repository output files, and `--compose` to generate instruction files immediately.

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

`edit-rules` prepares (or reuses) a writable workspace for each source, then prints the workspace path, rules directory, and next steps. `apply-rules` pushes each GitHub source workspace (if clean) and regenerates repository/global instruction files by refreshing the cache. For local-path sources, `edit-rules` points to the local workspace and `apply-rules` skips the push.

## Project ruleset format

Ruleset files accept JSON with `//` or `/* */` comments.

```jsonc
{
  // Rules sources. Each entry is github:owner/repo@ref or a local path.
  "sources": ["github:metyatech/agent-rules"],
  // Profile name defined by a source's agent-profiles.json.
  "profile": "node-cli",
  // Optional Claude Code repository companion output.
  "claude": {
    "enabled": true,
    "output": "CLAUDE.md"
  },
  // Repository output file name.
  "output": "AGENTS.md"
}
```

Overlay example (a private source layered on top of a public one):

```jsonc
{
  "sources": ["github:metyatech/agent-rules", "github:metyatech/agent-rules-private"],
  "profile": "course-docs",
  "output": "AGENTS.md"
}
```

Ruleset keys:

- `sources` (required): non-empty ordered list of rules sources. Each entry is `github:owner/repo@ref` or a local path.
- `profile` (required): profile name. It must be defined by at least one source's `agent-profiles.json`.
- `global` (optional): write each source's `rules/global` to user-global instruction files (defaults to true). Set `false` to skip global writes.
- `budget` (optional): global-rule budget thresholds in `o200k_base` tokens.
- `budget.totalTokens` (optional): hard total token budget for the composed global instruction output (defaults to `8000`). Exceeding this is reported as a budget violation.
- `budget.moduleTokens` (optional): per-module advisory threshold for each composed global rule section (defaults to `800`). Crossing this is **not** a violation; it triggers a review prompt to check whether the listed modules contain procedural content that should move to skills (procedures belong in skills, not rules).
- `claude` (optional): repository companion settings for Claude Code.
- `claude.enabled` (optional): enable/disable companion generation (defaults to `true`).
- `claude.output` (optional): companion file path (defaults to `CLAUDE.md`).
- `output` (optional): repository output file name (defaults to `AGENTS.md`).

When the composed global instruction output exceeds the total budget, the CLI emits a `⚠ Global rules budget exceeded` warning to `stderr`. When any module crosses the per-module advisory threshold, the CLI emits a separate `ℹ Modules over per-module review threshold` advisory to `stderr`. Both can be suppressed with `--quiet`. The machine-readable `--json` output includes `budget.totalExceeded`, `budget.moduleReviewTriggered`, the tokenizer name, total token count, and any over-threshold modules.

### Profile manifest (`agent-profiles.json`)

Each rules source may place an `agent-profiles.json` at its root (next to `rules/`). It maps profile names to the domains that a consuming repository selects by naming the profile:

```json
{
  "profiles": {
    "course-docs": {
      "domains": ["education", "course-docs"]
    },
    "node-cli": {
      "domains": ["node", "agent-tooling"]
    }
  }
}
```

Resolution rules:

- Sources are read in declared order.
- A source without `agent-profiles.json`, or whose manifest lacks the requested profile, is skipped for profile resolution.
- If no source defines the requested profile, compose fails.
- For each source that defines the profile, its `rules/domains/<domain>` folders are composed in the manifest's declared domain order.
- Sources are composed in source order. When the same domain appears in multiple sources, each source's content is included (no de-duplication), which enables public + overlay layering.
- A missing domain directory is an error, not a silent skip.

### Ruleset schema validation

`compose-agentsmd` validates rulesets against `agent-ruleset.schema.json` on every run. If the ruleset does not conform to the schema, the tool exits with a schema error. The legacy `source`, `domains`, and `extra` keys are no longer accepted.

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
- `--profile <name>`: profile name for `init`
- `--output <file>`: repository output filename for `init`
- `--no-global`: initialize without user-global rules
- `--compose`: compose repository and user-global instruction files after `init`
- `--dry-run`: show plan without writing files
- `--yes`: skip init confirmation prompt
- `--force`: overwrite existing files during init
- `check`: verify generated repository outputs are current
- `edit-rules`: prepare or locate a writable rules workspace
- `apply-rules`: push workspace changes (if GitHub source) and regenerate rules with refresh
- `init`: generate a new ruleset

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
