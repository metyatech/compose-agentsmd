# Tool Rules (compose-agentsmd)
- Before starting any work, run `compose-agentsmd` from the project root.
- If `compose-agentsmd` is not available, install it via npm: `npm install -g compose-agentsmd`.
- To update shared rules, run `compose-agentsmd edit-rules`, edit the workspace rules, then run `compose-agentsmd apply-rules`.
- Do not edit `AGENTS.md` directly; update the source rules and regenerate.
- These tool rules live in tools/tool-rules.md in the compose-agentsmd repository; do not duplicate them in global rule modules.
- When updating rules, include a colorized diff-style summary in the final response. Use `git diff --stat` first, then include the raw ANSI-colored output of `git diff --color=always` (no sanitizing or reformatting), and limit the output to the rule files that changed.
- Also provide a short, copy-pasteable command the user can run to view the diff in the same format. Use absolute paths so it works regardless of the current working directory, and scope it to the changed rule files.
- If a diff is provided, a separate detailed summary is not required. If a diff is not possible, include a detailed summary of what changed (added/removed/modified items).
