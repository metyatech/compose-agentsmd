# Contributing

Thank you for your interest in contributing to `compose-agentsmd`.

## Development setup

```bash
git clone https://github.com/metyatech/compose-agentsmd.git
cd compose-agentsmd
npm install
npm run verify   # lint + format check + test
```

## Submitting changes

1. Fork the repository and create a feature branch.
2. Add or update tests for any changed behavior.
3. Run `npm run verify` and ensure all checks pass.
4. Open a pull request with a clear description of the change.

## Code style

- TypeScript strict mode is required.
- Format with Prettier (`npm run format`).
- Lint with ESLint and tsc (`npm run lint`).

## Rules composition workflow

This repository treats `AGENTS.md` as a generated file.

- Do not edit `AGENTS.md` directly.
- Update the source rule modules and regenerate with:

```sh
npm run compose
```

## Scope

This package covers **AGENTS.md composition only**. Keep PRs scoped to composition and rule-management concerns.
