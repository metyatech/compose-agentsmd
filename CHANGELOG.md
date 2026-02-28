# Changelog

All notable changes to this project will be documented in this file.

## 3.3.1 - 2026-02-18

- Updated `ajv` in `package-lock.json` to `8.18.0` via `npm audit fix` to remediate a moderate advisory.

## 3.3.0 - 2026-02-18

- Added ruleset-level `claude` companion settings (`enabled` / `output`) with schema validation.
- Compose now generates a `CLAUDE.md` companion file by default with an `@...` import to the primary output.
- Added opt-out support via `claude.enabled: false` and custom companion path support via `claude.output`.
- Updated tests and README/usage docs for companion output behavior and JSON output lists.

## 3.2.7 - 2026-02-07

- Print a unified diff for `AGENTS.md` when it changes during compose/apply-rules (works without git).
- Suppress the diff/recognition hint output when using `--quiet` or `--json`.
- Added regression tests for the diff output behavior.

## 3.2.6 - 2026-02-06

- Enhanced `edit-rules` output to show the rules directory and concrete next steps for editing and applying rule updates.
- Added tests that verify the new `edit-rules` guidance output for local source layouts.
- Documented that `apply-rules` pushes the workspace for GitHub sources (when clean) before regenerating `AGENTS.md`.
- Updated README shared-rules update flow text to match the current CLI behavior.
- Regenerated `AGENTS.md` with updated tool rules and latest upstream shared rule content.

## 3.2.5 - 2026-02-06

- Clarified that `tools/tool-rules.md` is the shared rule source for all repositories using compose-agentsmd.
- Added a rule that planned rule updates must be shown first (preferably as a colorized diff) and require explicit approval before edits are applied.
- Regenerated `AGENTS.md` with the updated tool rules and latest shared upstream rule content.

## 3.2.4 - 2026-02-02

- Refactored CLI argument value parsing to reduce duplication.

## 3.2.3 - 2026-02-01

- Restored shared tool rules to use `compose-agentsmd` and moved the repo-specific compose instruction into a local rule.
- Added a local rules file and wired it into the ruleset, then regenerated `AGENTS.md`.

## 3.2.2 - 2026-02-01

- Normalized AGENTS.md Source paths to GitHub-style refs for remote rules and project-relative paths for local rules, with matching test updates.
- Added a pre-commit hook to run lint/test/build.
- Updated the ruleset to use `github:metyatech/agent-rules` with `cli`/`release` domains, removing the local release extra and regenerating AGENTS.md with the shared rules.
- Clarified tool rules location and rule-update diff requirements, and switched this repo to generate rules via `npm run compose`.
- Bumped @types/node to ^25.1.0.

## 3.2.1 - 2026-01-27

- Regenerated `AGENTS.md` to exclude the `AGENTS.md` file from rule diff output.

## 1.0.1 - 2026-01-25

- Switched the package to ESM (`"type": "module"`, NodeNext compiler options).
- Hardened npm publish settings (`publishConfig.access`, `files`, `prepare`).
- Expanded test coverage for rules root precedence and ruleset validation.
- Added GitHub community health files and CI workflow.
- Regenerated `AGENTS.md` from the updated rule modules.

## 1.1.0 - 2026-01-26

- Added JSON Schema validation for rulesets with an explicit schema file.
- Prepended tool guidance rules to generated `AGENTS.md` files.
- Updated shared rule modules for JSON schema validation and English rule writing guidance.

## 1.1.1 - 2026-01-26

- Clarified that README updates must be edited at the same time as code changes in shared rules.

## 1.1.2 - 2026-01-26

- Clarified that version bumps must include both release creation and package publishing.

## 2.0.0 - 2026-01-26

- Switched ruleset format to `source/global/domains/extra` with remote GitHub sources and cache support in `~/.agentsmd`.
- Added `--refresh` and `--clear-cache` cache management commands.
- Updated ruleset schema, tests, and README to match the new format.

## 2.0.1 - 2026-01-26

- Moved the publish/global-update rule into local rules for this repository.

## 2.0.2 - 2026-01-26

- Externalized tool-inserted rules and usage text into `tools/`.
- Added rule guidance to externalize long embedded strings/templates when possible.

## 3.0.0 - 2026-01-26

- Removed recursive ruleset discovery; only the project root ruleset is composed unless `--ruleset` is provided.

## 3.1.0 - 2026-01-26

- Added `--version`/`-V` and `--verbose`/`-v` flags with verbose diagnostics output.

## 3.2.0 - 2026-01-26

- Added `init` to bootstrap rulesets with dry-run, confirmation, and compose options.
- Allowed ruleset files to include line/block comments (JSON with comments).
- Updated init defaults to use generic GitHub sources and omit global/domains/extra unless specified.
