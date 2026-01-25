import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "dist", "compose-agents.js");

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
};

const normalizeTrailingWhitespace = (content) => content.replace(/\s+$/u, "");
const normalizePath = (filePath) => filePath.replace(/\\/g, "/");

const collectMarkdownFiles = (rootDir) => {
  const results = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
        results.push(entryPath);
      }
    }
  }

  return results.sort((a, b) => {
    const relA = normalizePath(path.relative(rootDir, a));
    const relB = normalizePath(path.relative(rootDir, b));
    return relA.localeCompare(relB);
  });
};

const runCli = (args, options) =>
  execFileSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: "pipe"
  });

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

test("composes AGENTS.md using --rules-root override", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const rulesRoot = path.join(tempRoot, "rules", "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          output: "AGENTS.md",
          domains: ["node"],
          rules: ["agent-rules-local/custom.md"]
        },
        null,
        2
      )
    );

    writeFile(path.join(projectRoot, "agent-rules-local", "custom.md"), "# Custom\nlocal");

    writeFile(path.join(rulesRoot, "global", "a.md"), "# Global A\nA");
    writeFile(path.join(rulesRoot, "global", "b.md"), "# Global B\nB");
    writeFile(path.join(rulesRoot, "domains", "node", "c.md"), "# Domain C\nC");

    const stdout = runCli(["--root", projectRoot, "--rules-root", rulesRoot], { cwd: repoRoot });
    assert.match(stdout, /Composed AGENTS\.md:/u);

    const outputPath = path.join(projectRoot, "AGENTS.md");
    const output = fs.readFileSync(outputPath, "utf8");

    const expected =
      "<!-- markdownlint-disable MD025 -->\n# Global A\nA\n\n# Global B\nB\n\n# Domain C\nC\n\n# Custom\nlocal\n";

    assert.equal(output, expected);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fails fast when ruleset is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    assert.throws(
      () => runCli(["--root", tempRoot], { cwd: repoRoot }),
      /No ruleset files named agent-ruleset\.json found/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("supports AGENT_RULES_ROOT environment override", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const rulesRoot = path.join(tempRoot, "shared", "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only Global\n1");

    runCli(["--root", projectRoot], {
      cwd: repoRoot,
      env: { AGENT_RULES_ROOT: rulesRoot }
    });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    assert.equal(output, "<!-- markdownlint-disable MD025 -->\n# Only Global\n1\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("uses rulesRoot from ruleset when CLI and env overrides are absent", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const rulesRoot = path.join(tempRoot, "rules-from-ruleset");
    const rulesRootRelative = path.relative(projectRoot, rulesRoot);

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          output: "AGENTS.md",
          rulesRoot: rulesRootRelative
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Ruleset Root\nruleset");

    runCli(["--root", projectRoot], { cwd: repoRoot });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    assert.equal(output, "<!-- markdownlint-disable MD025 -->\n# Ruleset Root\nruleset\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI --rules-root takes precedence over AGENT_RULES_ROOT and ruleset rulesRoot", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const cliRulesRoot = path.join(tempRoot, "cli-rules");
    const envRulesRoot = path.join(tempRoot, "env-rules");
    const rulesetRulesRoot = path.join(tempRoot, "ruleset-rules");
    const rulesetRelativeRoot = path.relative(projectRoot, rulesetRulesRoot);

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          output: "AGENTS.md",
          rulesRoot: rulesetRelativeRoot
        },
        null,
        2
      )
    );

    writeFile(path.join(cliRulesRoot, "global", "only.md"), "# CLI Root\ncli");
    writeFile(path.join(envRulesRoot, "global", "only.md"), "# ENV Root\nenv");
    writeFile(path.join(rulesetRulesRoot, "global", "only.md"), "# RULESET Root\nruleset");

    runCli(["--root", projectRoot, "--rules-root", cliRulesRoot], {
      cwd: repoRoot,
      env: { AGENT_RULES_ROOT: envRulesRoot }
    });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    assert.equal(output, "<!-- markdownlint-disable MD025 -->\n# CLI Root\ncli\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("supports globalDir and domainsDir overrides", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const rulesRoot = path.join(tempRoot, "rules-root");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          output: "AGENTS.md",
          domains: ["node"],
          rulesRoot: path.relative(projectRoot, rulesRoot),
          globalDir: "g",
          domainsDir: "d"
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "g", "a.md"), "# Global Override\nG");
    writeFile(path.join(rulesRoot, "d", "node", "b.md"), "# Domain Override\nD");

    runCli(["--root", projectRoot], { cwd: repoRoot });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    const expected =
      "<!-- markdownlint-disable MD025 -->\n# Global Override\nG\n\n# Domain Override\nD\n";
    assert.equal(output, expected);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("rejects invalid ruleset shapes with a clear error", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          output: "",
          domains: ["node", ""],
          rules: ["valid.md", ""]
        },
        null,
        2
      )
    );

    assert.throws(
      () => runCli(["--root", projectRoot], { cwd: repoRoot }),
      /Invalid ruleset output|"domains" entries must be non-empty strings|"rules" entries must be non-empty strings/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("composes using default agent-rules submodule layout", () => {
  const submoduleRulesRoot = path.join(repoRoot, "agent-rules", "rules");
  if (!fs.existsSync(submoduleRulesRoot)) {
    throw new Error("agent-rules submodule is required for this test");
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const projectRulesRoot = path.join(projectRoot, "agent-rules", "rules");

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.cpSync(submoduleRulesRoot, projectRulesRoot, { recursive: true });

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          output: "AGENTS.md",
          domains: ["node"]
        },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot });

    const outputPath = path.join(projectRoot, "AGENTS.md");
    const output = fs.readFileSync(outputPath, "utf8");
    assert.match(output, /^<!-- markdownlint-disable MD025 -->\n/u);

    const globalFiles = collectMarkdownFiles(path.join(projectRulesRoot, "global"));
    const firstGlobal = normalizeTrailingWhitespace(fs.readFileSync(globalFiles[0], "utf8"));
    assert.ok(firstGlobal.length > 0);
    assert.match(output, new RegExp(escapeRegExp(firstGlobal), "u"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
