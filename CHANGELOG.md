# Changelog

All notable changes to this project will be documented in this file.

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
