import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { countTokens } from "gpt-tokenizer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "dist", "compose-agents.js");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
};

const normalizeTrailingWhitespace = (content) => content.replace(/\s+$/u, "");
const normalizePath = (value) => value.replace(/\\/g, "/");
const stripJsonComments = (input) => {
  let output = "";
  let inString = false;
  let stringChar = "";
  let escaping = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === stringChar) {
        inString = false;
        stringChar = "";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      output += char;
      continue;
    }

    output += char;
  }

  return output;
};
const TOOL_RULES = normalizeTrailingWhitespace(
  fs.readFileSync(path.join(repoRoot, "tools", "tool-rules.md"), "utf8")
);
const DEFAULT_GLOBAL_OUTPUTS = [
  "~/.codex/AGENTS.md",
  "~/.claude/CLAUDE.md",
  "~/.gemini/GEMINI.md",
  "~/.copilot/copilot-instructions.md"
];
const DEFAULT_REPOSITORY_OUTPUTS = ["AGENTS.md", "CLAUDE.md"];
const DEFAULT_COMPOSED_OUTPUTS = [...DEFAULT_REPOSITORY_OUTPUTS, ...DEFAULT_GLOBAL_OUTPUTS];
const BUDGET_TOKENIZER = "o200k_base";
const DEFAULT_TOTAL_BUDGET = 4500;
const DEFAULT_MODULE_BUDGET = 400;

const createCliEnv = (home, extra = {}) => ({
  ...extra,
  HOME: home,
  USERPROFILE: home
});

const resolveCliEnv = (options) => {
  if (options.env?.HOME || options.env?.USERPROFILE) {
    return { ...process.env, ...options.env };
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-home-"));
  return { ...process.env, ...createCliEnv(tempHome, options.env) };
};

const runCli = (args, options) =>
  execFileSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: resolveCliEnv(options),
    encoding: "utf8",
    stdio: "pipe"
  });

const runCliResult = (args, options) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: resolveCliEnv(options),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "CLI failed");
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const DEFAULT_BUDGET_OK = {
  tokenizer: BUDGET_TOKENIZER,
  totalBudget: DEFAULT_TOTAL_BUDGET,
  moduleBudget: DEFAULT_MODULE_BUDGET,
  overBudgetModules: [],
  exceeded: false
};

const formatRuleBlock = (rulePath, body, projectRoot) => {
  const relativePath = normalizePath(path.relative(projectRoot, rulePath));
  return `Source: ${relativePath}\n\n${body}`;
};

const withToolRules = (body) =>
  body
    ? `<!-- markdownlint-disable MD025 -->\n${TOOL_RULES}\n\n${body}`
    : `<!-- markdownlint-disable MD025 -->\n${TOOL_RULES}\n`;
const withComposedHeader = (body) => (body ? `<!-- markdownlint-disable MD025 -->\n${body}` : "");
const countBudgetTokens = (content) => (content.length === 0 ? 0 : countTokens(content));
const buildGlobalOutput = (blocks) => withComposedHeader(blocks.join("\n\n") + "\n");
const buildExpectedBudget = (blocks, overrides = {}) => ({
  ...DEFAULT_BUDGET_OK,
  totalTokens: countBudgetTokens(blocks.length === 0 ? "" : buildGlobalOutput(blocks)),
  ...overrides
});

it("prints version with --version and -V", () => {
  const expected = `${packageJson.version}\n`;
  const stdoutLong = runCli(["--version"], { cwd: repoRoot });
  const stdoutShort = runCli(["-V"], { cwd: repoRoot });
  expect(stdoutLong).toBe(expected);
  expect(stdoutShort).toBe(expected);
});

it("prints verbose diagnostics with -v", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          global: true,
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    const stdout = runCli(["-v", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(/Verbose:/u);
    expect(stdout).toMatch(/Ruleset files:/u);
    expect(stdout).toMatch(/Composed instruction files:/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("composes AGENTS.md using local source and extra rules", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          global: true,
          output: "AGENTS.md",
          domains: ["node"],
          extra: ["agent-rules-local/custom.md"]
        },
        null,
        2
      )
    );

    writeFile(path.join(projectRoot, "agent-rules-local", "custom.md"), "# Custom\nlocal");

    writeFile(path.join(rulesRoot, "global", "a.md"), "# Global A\nA");
    writeFile(path.join(rulesRoot, "global", "b.md"), "# Global B\nB");
    writeFile(path.join(rulesRoot, "domains", "node", "c.md"), "# Domain C\nC");

    const stdout = runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(/Composed instruction files:/u);

    const outputPath = path.join(projectRoot, "AGENTS.md");
    const output = fs.readFileSync(outputPath, "utf8");

    const expected = withToolRules(
      [
        formatRuleBlock(
          path.join(rulesRoot, "domains", "node", "c.md"),
          "# Domain C\nC",
          projectRoot
        ),
        formatRuleBlock(
          path.join(projectRoot, "agent-rules-local", "custom.md"),
          "# Custom\nlocal",
          projectRoot
        )
      ].join("\n\n") + "\n"
    );

    expect(output).toBe(expected);
    const claudeOutput = fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8");
    expect(claudeOutput).toBe("@AGENTS.md\n");
    const expectedGlobalOutput = withComposedHeader(
      [
        formatRuleBlock(path.join(rulesRoot, "global", "a.md"), "# Global A\nA", projectRoot),
        formatRuleBlock(path.join(rulesRoot, "global", "b.md"), "# Global B\nB", projectRoot)
      ].join("\n\n") + "\n"
    );
    for (const globalPath of [
      path.join(fakeHome, ".codex", "AGENTS.md"),
      path.join(fakeHome, ".claude", "CLAUDE.md"),
      path.join(fakeHome, ".gemini", "GEMINI.md"),
      path.join(fakeHome, ".copilot", "copilot-instructions.md")
    ]) {
      expect(fs.readFileSync(globalPath, "utf8")).toBe(expectedGlobalOutput);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("creates CLAUDE companion by default", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: path.relative(projectRoot, sourceRoot) }, null, 2)
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("supports disabling CLAUDE companion via ruleset", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          claude: {
            enabled: false
          }
        },
        null,
        2
      )
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("supports custom CLAUDE companion output path", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          output: "docs/AGENTS.md",
          claude: {
            output: "CLAUDE.md"
          }
        },
        null,
        2
      )
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(fs.existsSync(path.join(projectRoot, "docs", "AGENTS.md"))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe("@docs/AGENTS.md\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("does not duplicate output when output is CLAUDE.md", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          output: "CLAUDE.md"
        },
        null,
        2
      )
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    const stdout = runCli(["--json", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const result = JSON.parse(stdout);
    const onlyRule = formatRuleBlock(
      path.join(rulesRoot, "global", "only.md"),
      "# Only\n1",
      projectRoot
    );
    expect(result).toEqual({
      composed: ["CLAUDE.md", ...DEFAULT_GLOBAL_OUTPUTS],
      repositoryOutputs: ["CLAUDE.md"],
      globalOutputs: DEFAULT_GLOBAL_OUTPUTS,
      dryRun: false,
      budget: buildExpectedBudget([onlyRule])
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("fails fast when ruleset is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    expect(() => runCli(["--root", tempRoot], { cwd: repoRoot })).toThrow(
      /Missing ruleset file: .*agent-ruleset\.json/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("does not search for rulesets in subdirectories", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const nestedRoot = path.join(tempRoot, "nested");
    writeFile(
      path.join(nestedRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(nestedRoot, path.join(tempRoot, "rules-source")),
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    expect(() => runCli(["--root", tempRoot], { cwd: repoRoot })).toThrow(
      /Missing ruleset file: .*agent-ruleset\.json/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("supports global=false to skip global rules", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          global: false,
          domains: ["node"],
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only Global\n1");
    writeFile(path.join(rulesRoot, "domains", "node", "domain.md"), "# Domain\nD");

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(
      withToolRules(
        formatRuleBlock(
          path.join(rulesRoot, "domains", "node", "domain.md"),
          "# Domain\nD",
          projectRoot
        ) + "\n"
      )
    );
    for (const globalPath of DEFAULT_GLOBAL_OUTPUTS.map((filePath) =>
      filePath.replace(/^~\//u, `${normalizePath(fakeHome)}/`)
    )) {
      expect(fs.existsSync(globalPath.replace(/\//g, path.sep))).toBe(false);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("supports source path pointing to a rules directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const rulesRoot = path.join(tempRoot, "rules-root", "rules");
    const rulesRootRelative = path.relative(projectRoot, rulesRoot);

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          output: "AGENTS.md",
          source: rulesRootRelative,
          global: true
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Ruleset Root\nruleset");

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(withToolRules(""));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("accepts rulesets with comments", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");
    const sourceRelative = path.relative(projectRoot, sourceRoot).replace(/\\/g, "/");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      `{
  // rules source
  "source": "${sourceRelative}",
  "output": "AGENTS.md"
}
`
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(withToolRules(""));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("rejects invalid ruleset shapes with a clear error", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: "",
          output: "",
          domains: ["node", ""],
          extra: ["valid.md", ""]
        },
        null,
        2
      )
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Invalid ruleset schema .*source|Invalid ruleset schema .*\/output|Invalid ruleset schema .*\/claude\/output/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("clears cached rules with --clear-cache", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const fakeHome = path.join(tempRoot, "home");
    const cacheRoot = path.join(fakeHome, ".agentsmd", "cache", "owner", "repo", "ref");
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "marker.txt"), "cache", "utf8");

    const stdout = runCli(["--clear-cache"], {
      cwd: repoRoot,
      env: { USERPROFILE: fakeHome, HOME: fakeHome }
    });

    expect(stdout).toMatch(/Cache cleared\./u);
    expect(fs.existsSync(path.join(fakeHome, ".agentsmd", "cache"))).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("edit-rules uses local source path as workspace", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    fs.mkdirSync(path.join(sourceRoot, "rules", "global"), { recursive: true });

    const stdout = runCli(["edit-rules", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(
      new RegExp(`Rules workspace: ${sourceRoot.replace(/\\/g, "\\\\")}`, "u")
    );
    expect(stdout).toMatch(
      new RegExp(`Rules directory: ${path.join(sourceRoot, "rules").replace(/\\/g, "\\\\")}`, "u")
    );
    expect(stdout).toMatch(/Next steps:/u);
    expect(stdout).toMatch(/compose-agentsmd apply-rules/u);
    expect(stdout).toMatch(/regenerate instruction files/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("edit-rules keeps rules directory when source points directly to rules", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, rulesRoot),
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    fs.mkdirSync(path.join(rulesRoot, "global"), { recursive: true });

    const stdout = runCli(["edit-rules", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(
      new RegExp(`Rules workspace: ${sourceRoot.replace(/\\/g, "\\\\")}`, "u")
    );
    expect(stdout).toMatch(new RegExp(`Rules directory: ${rulesRoot.replace(/\\/g, "\\\\")}`, "u"));
    expect(stdout).toMatch(/Next steps:/u);
    expect(stdout).toMatch(/compose-agentsmd apply-rules/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("apply-rules composes with refresh for local source", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    runCli(["apply-rules", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(withToolRules(""));
    expect(fs.readFileSync(path.join(fakeHome, ".codex", "AGENTS.md"), "utf8")).toBe(
      withComposedHeader(
        formatRuleBlock(path.join(rulesRoot, "global", "only.md"), "# Only\n1", projectRoot) + "\n"
      )
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("apply-rules supports --json output", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    const stdout = runCli(["apply-rules", "--json", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    const result = JSON.parse(stdout);
    const onlyRule = formatRuleBlock(
      path.join(rulesRoot, "global", "only.md"),
      "# Only\n1",
      projectRoot
    );
    expect(result).toEqual({
      composed: DEFAULT_COMPOSED_OUTPUTS,
      repositoryOutputs: DEFAULT_REPOSITORY_OUTPUTS,
      globalOutputs: DEFAULT_GLOBAL_OUTPUTS,
      dryRun: false,
      budget: buildExpectedBudget([onlyRule])
    });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(withToolRules(""));
    expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("apply-rules respects --dry-run with --json", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    const stdout = runCli(["apply-rules", "--dry-run", "--json", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    expect(stdout).not.toMatch(/Composed instruction files:/u);

    const result = JSON.parse(stdout);
    const onlyRule = formatRuleBlock(
      path.join(rulesRoot, "global", "only.md"),
      "# Only\n1",
      projectRoot
    );
    expect(result).toEqual({
      composed: DEFAULT_COMPOSED_OUTPUTS,
      repositoryOutputs: DEFAULT_REPOSITORY_OUTPUTS,
      globalOutputs: DEFAULT_GLOBAL_OUTPUTS,
      dryRun: true,
      budget: buildExpectedBudget([onlyRule])
    });
    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("init creates a default ruleset with comments", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");

    const stdout = runCli(["init", "--yes", "--root", projectRoot], { cwd: repoRoot });
    expect(stdout).toMatch(/Initialized ruleset:/u);

    const rulesetPath = path.join(projectRoot, "agent-ruleset.json");
    const rulesetRaw = fs.readFileSync(rulesetPath, "utf8");
    expect(rulesetRaw).toMatch(/\/\/ Rules source/u);
    expect(/("global"\s*:)/u.test(rulesetRaw)).toBe(false);
    const ruleset = JSON.parse(stripJsonComments(rulesetRaw));

    expect(ruleset).toEqual({
      source: "github:owner/repo@latest",
      domains: [],
      extra: [],
      output: "AGENTS.md",
      claude: {
        enabled: true,
        output: "CLAUDE.md"
      }
    });

    const localRulesPath = path.join(projectRoot, "agent-rules-local", "custom.md");
    expect(fs.existsSync(localRulesPath)).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("supports --quiet and -q to suppress output", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: path.relative(projectRoot, sourceRoot) }, null, 2)
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    const stdoutLong = runCli(["--quiet", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdoutLong).toBe("");

    const stdoutShort = runCli(["-q", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdoutShort).toBe("");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("supports --json for machine-readable output", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: path.relative(projectRoot, sourceRoot) }, null, 2)
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    const stdout = runCli(["--json", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const result = JSON.parse(stdout);
    const onlyRule = formatRuleBlock(
      path.join(rulesRoot, "global", "only.md"),
      "# Only\n1",
      projectRoot
    );
    expect(result).toEqual({
      composed: DEFAULT_COMPOSED_OUTPUTS,
      repositoryOutputs: DEFAULT_REPOSITORY_OUTPUTS,
      globalOutputs: DEFAULT_GLOBAL_OUTPUTS,
      dryRun: false,
      budget: buildExpectedBudget([onlyRule])
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("supports --dry-run for compose", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: path.relative(projectRoot, sourceRoot) }, null, 2)
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    const stdout = runCli(["--dry-run", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(/Composed instruction files:/u);
    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("prints repository and global diffs when outputs change", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: path.relative(projectRoot, sourceRoot) }, null, 2)
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    writeFile(path.join(projectRoot, "AGENTS.md"), "old\n");
    writeFile(path.join(fakeHome, ".codex", "AGENTS.md"), "old-global\n");

    const stdout = runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(/Composed instruction files:/u);
    expect(stdout).toMatch(/Repository outputs updated/u);
    expect(stdout).toMatch(/Global outputs updated/u);
    expect(stdout).toMatch(/--- BEGIN REPOSITORY DIFF ---/u);
    expect(stdout).toMatch(/--- a\/AGENTS\.md/u);
    expect(stdout).toMatch(/\+\+\+ b\/AGENTS\.md/u);
    expect(stdout).toMatch(/--- BEGIN GLOBAL DIFF ---/u);
    expect(stdout).toMatch(/--- a\/~\/\.codex\/AGENTS\.md/u);
    expect(stdout).toMatch(/\+\+\+ b\/~\/\.codex\/AGENTS\.md/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("prints unchanged for repository and global outputs when nothing changed", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: path.relative(projectRoot, sourceRoot) }, null, 2)
    );
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only\n1");

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const stdout = runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(stdout).toMatch(/Composed instruction files:/u);
    expect(stdout).toMatch(/Repository outputs unchanged/u);
    expect(stdout).toMatch(/Global outputs unchanged/u);
    expect(stdout).not.toMatch(/BEGIN DIFF/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("init --dry-run does not write files", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");

    const stdout = runCli(["init", "--dry-run", "--root", projectRoot], { cwd: repoRoot });
    expect(stdout).toMatch(/Dry run/u);
    expect(fs.existsSync(path.join(projectRoot, "agent-ruleset.json"))).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("init refuses to overwrite an existing ruleset without --force", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: "local" }, null, 2)
    );

    expect(() => runCli(["init", "--yes", "--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Ruleset already exists/u
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("init respects --quiet and --json", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");

    // Case 1: --quiet suppresses standard output
    const stdoutQuiet = runCli(["init", "--yes", "--quiet", "--root", projectRoot], {
      cwd: repoRoot
    });
    expect(stdoutQuiet).toBe("");
    expect(fs.existsSync(path.join(projectRoot, "agent-ruleset.json"))).toBe(true);

    // Clean up for next case
    fs.rmSync(projectRoot, { recursive: true, force: true });

    // Case 2: --json outputs JSON and suppresses standard output
    const stdoutJson = runCli(["init", "--yes", "--json", "--root", projectRoot], {
      cwd: repoRoot
    });
    const result = JSON.parse(stdoutJson);

    expect(result.dryRun).toBe(false);
    expect(result.initialized).toEqual(["agent-ruleset.json"]);
    expect(result.localRules).toEqual([]);
    expect(result.composed).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, "agent-ruleset.json"))).toBe(true);

    // Check that there is no other output mixed with JSON
    expect(stdoutJson).not.toMatch(/Initialized ruleset:/u);

    // Clean up for next case
    fs.rmSync(projectRoot, { recursive: true, force: true });

    // Case 3: --json takes precedence over --quiet
    const stdoutJsonQuiet = runCli(["init", "--yes", "--quiet", "--json", "--root", projectRoot], {
      cwd: repoRoot
    });
    const resultJsonQuiet = JSON.parse(stdoutJsonQuiet);

    expect(resultJsonQuiet.dryRun).toBe(false);
    expect(resultJsonQuiet.initialized).toEqual(["agent-ruleset.json"]);
    expect(resultJsonQuiet.localRules).toEqual([]);
    expect(resultJsonQuiet.composed).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, "agent-ruleset.json"))).toBe(true);
    expect(stdoutJsonQuiet).not.toMatch(/Initialized ruleset:/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("compose respects --dry-run with --json", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: path.relative(projectRoot, sourceRoot) }, null, 2)
    );
    fs.mkdirSync(path.join(sourceRoot, "rules", "global"), { recursive: true });

    const stdout = runCli(["--dry-run", "--json", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    const result = JSON.parse(stdout);

    expect(result.dryRun).toBe(true);
    expect(result.composed).toEqual(DEFAULT_COMPOSED_OUTPUTS);
    expect(result.repositoryOutputs).toEqual(DEFAULT_REPOSITORY_OUTPUTS);
    expect(result.globalOutputs).toEqual(DEFAULT_GLOBAL_OUTPUTS);
    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("init --dry-run with --json outputs plan", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");

    const stdout = runCli(["init", "--dry-run", "--json", "--root", projectRoot], {
      cwd: repoRoot
    });
    const result = JSON.parse(stdout);

    expect(result.dryRun).toBe(true);
    expect(Array.isArray(result.plan)).toBe(true);
    expect(result.plan).toEqual([{ action: "create", path: "agent-ruleset.json" }]);
    expect(fs.existsSync(path.join(projectRoot, "agent-ruleset.json"))).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("budget: no warning when within limits", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ source: path.relative(projectRoot, sourceRoot) }, null, 2)
    );
    writeFile(path.join(rulesRoot, "global", "small.md"), "# Small\nA\nB\nC");

    const { stderr } = runCliResult(["--root", projectRoot], { cwd: repoRoot });
    expect(stderr).toBe("");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("budget: warns to stderr when a module exceeds per-module token limit", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");
    const bigContent = Array.from({ length: 200 }, () => "budget").join(" ");
    const moduleSection = formatRuleBlock(
      path.join(rulesRoot, "global", "big-module.md"),
      bigContent,
      projectRoot
    );
    const moduleTokens = countBudgetTokens(moduleSection);
    const moduleBudget = moduleTokens - 1;

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          budget: { totalTokens: moduleTokens + 500, moduleTokens: moduleBudget }
        },
        null,
        2
      )
    );
    writeFile(path.join(rulesRoot, "global", "big-module.md"), bigContent);

    const { stderr } = runCliResult(["--root", projectRoot], { cwd: repoRoot });
    expect(stderr).toMatch(/⚠ Global rules budget exceeded/u);
    expect(stderr).toMatch(new RegExp(`Over-budget modules \\(> ${moduleBudget} tokens\\):`, "u"));
    expect(stderr).toMatch(new RegExp(`big-module\\.md: ${moduleTokens} tokens`, "u"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("budget: warns to stderr when total tokens exceed total limit", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");
    const globalBlocks = [
      formatRuleBlock(path.join(rulesRoot, "global", "a.md"), "# A\nline1\nline2", projectRoot),
      formatRuleBlock(path.join(rulesRoot, "global", "b.md"), "# B\nline1\nline2", projectRoot),
      formatRuleBlock(path.join(rulesRoot, "global", "c.md"), "# C\nline1\nline2", projectRoot)
    ];
    const totalTokens = countBudgetTokens(buildGlobalOutput(globalBlocks));
    const totalBudget = totalTokens - 1;

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          budget: { totalTokens: totalBudget, moduleTokens: DEFAULT_MODULE_BUDGET * 4 }
        },
        null,
        2
      )
    );
    writeFile(path.join(rulesRoot, "global", "a.md"), "# A\nline1\nline2");
    writeFile(path.join(rulesRoot, "global", "b.md"), "# B\nline1\nline2");
    writeFile(path.join(rulesRoot, "global", "c.md"), "# C\nline1\nline2");

    const { stderr } = runCliResult(["--root", projectRoot], { cwd: repoRoot });
    expect(stderr).toMatch(
      new RegExp(
        `⚠ Global rules budget exceeded \\(${BUDGET_TOKENIZER}\\): ${totalTokens}/${totalBudget} tokens`,
        "u"
      )
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("budget: warning is suppressed with --quiet", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");
    const bigContent = Array.from({ length: 200 }, () => "budget").join(" ");
    const moduleSection = formatRuleBlock(
      path.join(rulesRoot, "global", "big-module.md"),
      bigContent,
      projectRoot
    );
    const moduleTokens = countBudgetTokens(moduleSection);

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          budget: { totalTokens: moduleTokens + 500, moduleTokens: moduleTokens - 1 }
        },
        null,
        2
      )
    );
    writeFile(path.join(rulesRoot, "global", "big-module.md"), bigContent);

    const { stderr } = runCliResult(["--quiet", "--root", projectRoot], { cwd: repoRoot });
    expect(stderr).toBe("");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("budget: json output includes budget data when exceeded", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");
    const overRule = formatRuleBlock(
      path.join(rulesRoot, "global", "over.md"),
      "# Over\nA\nB\nC",
      projectRoot
    );
    const moduleTokens = countBudgetTokens(overRule);

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          budget: { totalTokens: moduleTokens + 500, moduleTokens: moduleTokens - 1 }
        },
        null,
        2
      )
    );
    writeFile(path.join(rulesRoot, "global", "over.md"), "# Over\nA\nB\nC");

    const stdout = runCli(["--json", "--root", projectRoot], { cwd: repoRoot });
    const result = JSON.parse(stdout);
    expect(result.budget.exceeded).toBe(true);
    expect(result.budget.tokenizer).toBe(BUDGET_TOKENIZER);
    expect(result.budget.overBudgetModules).toHaveLength(1);
    expect(result.budget.overBudgetModules[0].name).toBe("over.md");
    expect(result.budget.overBudgetModules[0].tokens).toBe(moduleTokens);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it("budget: apply-rules warning emitted to stderr on exceeded", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));

  try {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");
    const ruleSection = formatRuleBlock(
      path.join(rulesRoot, "global", "rule.md"),
      "# Rule\nA\nB",
      projectRoot
    );
    const moduleTokens = countBudgetTokens(ruleSection);

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          source: path.relative(projectRoot, sourceRoot),
          budget: { totalTokens: moduleTokens + 500, moduleTokens: moduleTokens - 1 }
        },
        null,
        2
      )
    );
    writeFile(path.join(rulesRoot, "global", "rule.md"), "# Rule\nA\nB");

    const { stderr } = runCliResult(["apply-rules", "--root", projectRoot], { cwd: repoRoot });
    expect(stderr).toMatch(/⚠ Global rules budget exceeded/u);
    expect(stderr).toMatch(new RegExp(`rule\\.md: ${moduleTokens} tokens`, "u"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
