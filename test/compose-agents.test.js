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
const relSource = (projectRoot, sourceRoot) =>
  normalizePath(path.relative(projectRoot, sourceRoot));

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
  "~/.config/opencode/AGENTS.md",
  "~/.claude/CLAUDE.md",
  "~/.gemini/GEMINI.md",
  "~/.copilot/copilot-instructions.md"
];
const DEFAULT_REPOSITORY_OUTPUTS = ["AGENTS.md", "CLAUDE.md"];
const DEFAULT_COMPOSED_OUTPUTS = [...DEFAULT_REPOSITORY_OUTPUTS, ...DEFAULT_GLOBAL_OUTPUTS];
const BUDGET_TOKENIZER = "o200k_base";
const DEFAULT_TOTAL_BUDGET = 8000;
const DEFAULT_MODULE_BUDGET = 800;
const BASE_PROFILE = "base";

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

const runCliStatus = (args, options) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: resolveCliEnv(options),
    encoding: "utf8"
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const DEFAULT_BUDGET_OK = {
  tokenizer: BUDGET_TOKENIZER,
  totalBudget: DEFAULT_TOTAL_BUDGET,
  moduleBudget: DEFAULT_MODULE_BUDGET,
  overBudgetModules: [],
  totalExceeded: false,
  moduleReviewTriggered: false
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

// Writes an agent-profiles.json at a source root mapping profile names to domains.
const writeProfileManifest = (sourceRoot, profiles) => {
  writeFile(path.join(sourceRoot, "agent-profiles.json"), JSON.stringify({ profiles }, null, 2));
};

// Writes a source that defines the base profile with the given (default empty) domains
// plus a single global rule module, so global-only tests have a valid profile.
const writeBaseSource = (sourceRoot, { domains = [], global = "# Only\n1" } = {}) => {
  writeProfileManifest(sourceRoot, { [BASE_PROFILE]: { domains } });
  if (global !== null) {
    writeFile(path.join(sourceRoot, "rules", "global", "only.md"), global);
  }
};

const withTempRoot = (run) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-"));
  try {
    return run(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

it("scopes the session gate to externally supplied instructions", () => {
  expect(TOOL_RULES).toContain("externally supplied human/operator instruction");
  expect(TOOL_RULES).toContain("run `compose-agentsmd` once");
  expect(TOOL_RULES).toContain("generated continuations");
  expect(TOOL_RULES).not.toContain("before responding to ANY user message");
});

it("prints version with --version and -V", () => {
  const expected = `${packageJson.version}\n`;
  const stdoutLong = runCli(["--version"], { cwd: repoRoot });
  const stdoutShort = runCli(["-V"], { cwd: repoRoot });
  expect(stdoutLong).toBe(expected);
  expect(stdoutShort).toBe(expected);
});

it("prints verbose diagnostics with -v", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    const stdout = runCli(["-v", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(/Verbose:/u);
    expect(stdout).toMatch(/Ruleset files:/u);
    expect(stdout).toMatch(/Composed instruction files:/u);
  }));

// (1) schema accepts sources + profile and composes selected domains.
it("composes AGENTS.md using sources and a profile", () =>
  withTempRoot((tempRoot) => {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeProfileManifest(sourceRoot, { "node-cli": { domains: ["node"] } });
    writeFile(path.join(rulesRoot, "global", "a.md"), "# Global A\nA");
    writeFile(path.join(rulesRoot, "global", "b.md"), "# Global B\nB");
    writeFile(path.join(rulesRoot, "domains", "node", "c.md"), "# Domain C\nC");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: "node-cli", output: "AGENTS.md" },
        null,
        2
      )
    );

    const stdout = runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(/Composed instruction files:/u);

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(
      withToolRules(
        formatRuleBlock(
          path.join(rulesRoot, "domains", "node", "c.md"),
          "# Domain C\nC",
          projectRoot
        ) + "\n"
      )
    );

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
      path.join(fakeHome, ".config", "opencode", "AGENTS.md"),
      path.join(fakeHome, ".claude", "CLAUDE.md"),
      path.join(fakeHome, ".gemini", "GEMINI.md"),
      path.join(fakeHome, ".copilot", "copilot-instructions.md")
    ]) {
      expect(fs.readFileSync(globalPath, "utf8")).toBe(expectedGlobalOutput);
    }
  }));

// (8) at least one source defining the requested profile succeeds.
it("composes when a source defines the requested profile", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeProfileManifest(sourceRoot, { "node-cli": { domains: ["node"] } });
    writeFile(path.join(rulesRoot, "domains", "node", "n.md"), "# Node\nN");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: "node-cli" },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(
      withToolRules(
        formatRuleBlock(path.join(rulesRoot, "domains", "node", "n.md"), "# Node\nN", projectRoot) +
          "\n"
      )
    );
  }));

// (9) profile domains are expanded in declared order.
it("expands profile domains in declared order", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeProfileManifest(sourceRoot, { ordered: { domains: ["alpha", "beta"] } });
    writeFile(path.join(rulesRoot, "domains", "alpha", "a.md"), "# Alpha\nA");
    writeFile(path.join(rulesRoot, "domains", "beta", "b.md"), "# Beta\nB");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: [relSource(projectRoot, sourceRoot)], profile: "ordered" }, null, 2)
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    const alphaBlock = formatRuleBlock(
      path.join(rulesRoot, "domains", "alpha", "a.md"),
      "# Alpha\nA",
      projectRoot
    );
    const betaBlock = formatRuleBlock(
      path.join(rulesRoot, "domains", "beta", "b.md"),
      "# Beta\nB",
      projectRoot
    );
    expect(output).toBe(withToolRules([alphaBlock, betaBlock].join("\n\n") + "\n"));
    expect(output.indexOf("# Alpha")).toBeLessThan(output.indexOf("# Beta"));
  }));

// (10) multiple sources are expanded in source order.
it("expands multiple sources in source order", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceA = path.join(tempRoot, "source-a");
    const sourceB = path.join(tempRoot, "source-b");

    writeProfileManifest(sourceA, { shared: { domains: ["one"] } });
    writeFile(path.join(sourceA, "rules", "domains", "one", "a.md"), "# One\nA");
    writeProfileManifest(sourceB, { shared: { domains: ["two"] } });
    writeFile(path.join(sourceB, "rules", "domains", "two", "b.md"), "# Two\nB");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceA), relSource(projectRoot, sourceB)],
          profile: "shared"
        },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    const oneBlock = formatRuleBlock(
      path.join(sourceA, "rules", "domains", "one", "a.md"),
      "# One\nA",
      projectRoot
    );
    const twoBlock = formatRuleBlock(
      path.join(sourceB, "rules", "domains", "two", "b.md"),
      "# Two\nB",
      projectRoot
    );
    expect(output).toBe(withToolRules([oneBlock, twoBlock].join("\n\n") + "\n"));
    expect(output.indexOf("# One")).toBeLessThan(output.indexOf("# Two"));
  }));

// (10, overlay) same domain in multiple sources is composed without de-duplication.
it("layers the same domain from multiple sources without de-duplication", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const publicSource = path.join(tempRoot, "public");
    const overlaySource = path.join(tempRoot, "overlay");

    writeProfileManifest(publicSource, { "course-docs": { domains: ["docs"] } });
    writeFile(path.join(publicSource, "rules", "domains", "docs", "base.md"), "# Public\nP");
    writeProfileManifest(overlaySource, { "course-docs": { domains: ["docs"] } });
    writeFile(path.join(overlaySource, "rules", "domains", "docs", "extra.md"), "# Overlay\nO");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, publicSource), relSource(projectRoot, overlaySource)],
          profile: "course-docs"
        },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toContain("# Public");
    expect(output).toContain("# Overlay");
    expect(output.indexOf("# Public")).toBeLessThan(output.indexOf("# Overlay"));
  }));

// (6) a source without agent-profiles.json is skipped for profile resolution.
it("skips a source without a profile manifest", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const noManifest = path.join(tempRoot, "no-manifest");
    const withManifest = path.join(tempRoot, "with-manifest");

    // No agent-profiles.json here; its domain must never be composed.
    writeFile(path.join(noManifest, "rules", "domains", "ignored", "x.md"), "# Ignored\nX");
    writeProfileManifest(withManifest, { p: { domains: ["kept"] } });
    writeFile(path.join(withManifest, "rules", "domains", "kept", "y.md"), "# Kept\nY");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, noManifest), relSource(projectRoot, withManifest)],
          profile: "p"
        },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toContain("# Kept");
    expect(output).not.toContain("# Ignored");
  }));

// (7) a source whose manifest lacks the requested profile is skipped.
it("skips a source whose manifest lacks the requested profile", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const otherProfile = path.join(tempRoot, "other");
    const wantedProfile = path.join(tempRoot, "wanted");

    writeProfileManifest(otherProfile, { different: { domains: ["nope"] } });
    writeFile(path.join(otherProfile, "rules", "domains", "nope", "x.md"), "# Nope\nX");
    writeProfileManifest(wantedProfile, { p: { domains: ["yes"] } });
    writeFile(path.join(wantedProfile, "rules", "domains", "yes", "y.md"), "# Yes\nY");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, otherProfile), relSource(projectRoot, wantedProfile)],
          profile: "p"
        },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toContain("# Yes");
    expect(output).not.toContain("# Nope");
  }));

// (5) an unknown profile fails when no source defines it.
it("fails when no source defines the requested profile", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeProfileManifest(sourceRoot, { known: { domains: [] } });
    fs.mkdirSync(path.join(sourceRoot, "rules"), { recursive: true });

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: [relSource(projectRoot, sourceRoot)], profile: "missing" }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Profile "missing" is not defined by any source/u
    );
  }));

// (11) a missing domain directory fails.
it("fails when a profile domain directory is missing", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeProfileManifest(sourceRoot, { p: { domains: ["ghost"] } });
    fs.mkdirSync(path.join(sourceRoot, "rules"), { recursive: true });

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: [relSource(projectRoot, sourceRoot)], profile: "p" }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Domain directory "ghost" for profile "p" not found/u
    );
  }));

it("rejects profile domains that are not safe directory names", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeProfileManifest(sourceRoot, { p: { domains: ["../global"] } });
    fs.mkdirSync(path.join(sourceRoot, "rules", "global"), { recursive: true });

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: [relSource(projectRoot, sourceRoot)], profile: "p" }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Invalid profile manifest/u
    );
  }));

it("does not follow symlinks or junctions when collecting domain rules", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const secretsDir = path.join(sourceRoot, "secrets");

    fs.mkdirSync(path.join(sourceRoot, "rules", "domains", "node"), { recursive: true });
    fs.mkdirSync(secretsDir, { recursive: true });
    writeFile(path.join(secretsDir, "secret.md"), "# Secret\nleaked-marker");
    try {
      fs.symlinkSync(
        secretsDir,
        path.join(sourceRoot, "rules", "domains", "node", "leak"),
        "junction"
      );
    } catch (error) {
      // Junctions require Windows; skip the test gracefully if the host denies creation.
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        return;
      }
      throw error;
    }

    writeProfileManifest(sourceRoot, { p: { domains: ["node"] } });
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: [relSource(projectRoot, sourceRoot)], profile: "p" }, null, 2)
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).not.toContain("leaked-marker");
  }));

it("rejects domain directories that are symlinks or junctions", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const secretsDir = path.join(sourceRoot, "secrets");

    fs.mkdirSync(path.join(sourceRoot, "rules", "domains"), { recursive: true });
    fs.mkdirSync(secretsDir, { recursive: true });
    writeFile(path.join(secretsDir, "secret.md"), "# Secret\nleaked-marker");
    try {
      fs.symlinkSync(secretsDir, path.join(sourceRoot, "rules", "domains", "evil"), "junction");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        return;
      }
      throw error;
    }

    writeProfileManifest(sourceRoot, { p: { domains: ["evil"] } });
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: [relSource(projectRoot, sourceRoot)], profile: "p" }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Domain directory "evil" for profile "p" is a symbolic link/u
    );
  }));

// (12) legacy extra files are no longer read.
it("does not read local extra files", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeProfileManifest(sourceRoot, { p: { domains: ["node"] } });
    writeFile(path.join(sourceRoot, "rules", "domains", "node", "n.md"), "# Node\nN");
    // A stray local rules file must be ignored (no `extra` mechanism exists).
    writeFile(
      path.join(projectRoot, "agent-rules-local", "custom.md"),
      "# Custom\nlocal-extra-marker"
    );

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: [relSource(projectRoot, sourceRoot)], profile: "p" }, null, 2)
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toContain("# Node");
    expect(output).not.toContain("local-extra-marker");
  }));

// (2) schema rejects the old `source` key.
it("rejects the legacy source key", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: ["local"], profile: "p", source: "github:owner/repo" }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Invalid ruleset schema .*(must NOT have additional properties|source)/u
    );
  }));

// (3) schema rejects the old `domains` key.
it("rejects the legacy domains key", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: ["local"], profile: "p", domains: ["node"] }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Invalid ruleset schema .*(must NOT have additional properties|domains)/u
    );
  }));

// (4) schema rejects the old `extra` key.
it("rejects the legacy extra key", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: ["local"], profile: "p", extra: ["x.md"] }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Invalid ruleset schema .*(must NOT have additional properties|extra)/u
    );
  }));

it("rejects a ruleset with an empty sources array", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: [], profile: "p" }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Invalid ruleset schema/u
    );
  }));

it("rejects a ruleset missing the profile", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: ["local"] }, null, 2)
    );

    expect(() => runCli(["--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Invalid ruleset schema/u
    );
  }));

it("creates CLAUDE companion by default", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  }));

it("supports disabling CLAUDE companion via ruleset", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          claude: { enabled: false }
        },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
  }));

it("supports custom CLAUDE companion output path", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          output: "docs/AGENTS.md",
          claude: { output: "CLAUDE.md" }
        },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(fs.existsSync(path.join(projectRoot, "docs", "AGENTS.md"))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe("@docs/AGENTS.md\n");
  }));

it("does not duplicate output when output is CLAUDE.md", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          output: "CLAUDE.md"
        },
        null,
        2
      )
    );

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
  }));

it("fails fast when ruleset is missing", () =>
  withTempRoot((tempRoot) => {
    expect(() => runCli(["--root", tempRoot], { cwd: repoRoot })).toThrow(
      /Missing ruleset file: .*agent-ruleset\.json/u
    );
  }));

it("does not search for rulesets in subdirectories", () =>
  withTempRoot((tempRoot) => {
    const nestedRoot = path.join(tempRoot, "nested");
    writeFile(
      path.join(nestedRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: ["local"], profile: "p" }, null, 2)
    );

    expect(() => runCli(["--root", tempRoot], { cwd: repoRoot })).toThrow(
      /Missing ruleset file: .*agent-ruleset\.json/u
    );
  }));

it("supports global=false to skip global rules", () =>
  withTempRoot((tempRoot) => {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeProfileManifest(sourceRoot, { p: { domains: ["node"] } });
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Only Global\n1");
    writeFile(path.join(rulesRoot, "domains", "node", "domain.md"), "# Domain\nD");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: "p", global: false },
        null,
        2
      )
    );

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
  }));

it("supports source path pointing to a rules directory", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-root");
    const rulesRoot = path.join(sourceRoot, "rules");

    // Manifest sits at the source root, next to the rules directory the source points at.
    writeProfileManifest(sourceRoot, { [BASE_PROFILE]: { domains: [] } });
    writeFile(path.join(rulesRoot, "global", "only.md"), "# Ruleset Root\nruleset");

    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, rulesRoot)],
          profile: BASE_PROFILE,
          output: "AGENTS.md"
        },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(withToolRules(""));
  }));

it("accepts rulesets with comments", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const sourceRelative = relSource(projectRoot, sourceRoot);

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      `{
  // rules sources
  "sources": ["${sourceRelative}"],
  // profile
  "profile": "${BASE_PROFILE}",
  "output": "AGENTS.md"
}
`
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(withToolRules(""));
  }));

it("clears cached rules with --clear-cache", () =>
  withTempRoot((tempRoot) => {
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
  }));

it("edit-rules uses local source path as workspace", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

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
  }));

it("apply-rules composes with refresh for local source", () =>
  withTempRoot((tempRoot) => {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    runCli(["apply-rules", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    const output = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    expect(output).toBe(withToolRules(""));
    expect(fs.readFileSync(path.join(fakeHome, ".codex", "AGENTS.md"), "utf8")).toBe(
      withComposedHeader(
        formatRuleBlock(path.join(rulesRoot, "global", "only.md"), "# Only\n1", projectRoot) + "\n"
      )
    );
  }));

it("apply-rules supports --json output", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

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

    expect(fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8")).toBe(withToolRules(""));
    expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  }));

it("apply-rules respects --dry-run with --json", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

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
  }));

// (16) init creates a new-format ruleset.
it("init creates a default ruleset with comments", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");

    const stdout = runCli(["init", "--yes", "--root", projectRoot], { cwd: repoRoot });
    expect(stdout).toMatch(/Initialized ruleset:/u);

    const rulesetRaw = fs.readFileSync(path.join(projectRoot, "agent-ruleset.json"), "utf8");
    expect(rulesetRaw).toMatch(/\/\/ Rules sources/u);
    expect(/("global"\s*:)/u.test(rulesetRaw)).toBe(false);
    expect(rulesetRaw).not.toMatch(/"domains"/u);
    expect(rulesetRaw).not.toMatch(/"extra"/u);
    expect(rulesetRaw).not.toMatch(/"source"\s*:/u);

    const ruleset = JSON.parse(stripJsonComments(rulesetRaw));
    expect(ruleset).toEqual({
      sources: ["github:owner/repo"],
      profile: "node-cli",
      output: "AGENTS.md",
      claude: { enabled: true, output: "CLAUDE.md" }
    });

    expect(fs.existsSync(path.join(projectRoot, "agent-rules-local", "custom.md"))).toBe(false);
  }));

it("init accepts a custom profile", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");

    runCli(["init", "--yes", "--profile", "course-docs", "--root", projectRoot], { cwd: repoRoot });

    const ruleset = JSON.parse(
      stripJsonComments(fs.readFileSync(path.join(projectRoot, "agent-ruleset.json"), "utf8"))
    );
    expect(ruleset.profile).toBe("course-docs");
    expect(ruleset.sources).toEqual(["github:owner/repo"]);
  }));

it("supports --quiet and -q to suppress output", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    expect(runCli(["--quiet", "--root", projectRoot], { cwd: repoRoot, env: cliEnv })).toBe("");
    expect(runCli(["-q", "--root", projectRoot], { cwd: repoRoot, env: cliEnv })).toBe("");
  }));

it("supports --json for machine-readable output", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

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
  }));

it("supports --dry-run for compose", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    const stdout = runCli(["--dry-run", "--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(/Composed instruction files:/u);
    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
  }));

it("prints repository and global diffs when outputs change", () =>
  withTempRoot((tempRoot) => {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );
    writeFile(path.join(projectRoot, "AGENTS.md"), "old\n");
    writeFile(path.join(fakeHome, ".codex", "AGENTS.md"), "old-global\n");

    const stdout = runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    expect(stdout).toMatch(/Repository outputs updated/u);
    expect(stdout).toMatch(/Global outputs updated/u);
    expect(stdout).toMatch(/--- BEGIN REPOSITORY DIFF ---/u);
    expect(stdout).toMatch(/--- a\/AGENTS\.md/u);
    expect(stdout).toMatch(/\+\+\+ b\/AGENTS\.md/u);
    expect(stdout).toMatch(/--- BEGIN GLOBAL DIFF ---/u);
    expect(stdout).toMatch(/--- a\/~\/\.codex\/AGENTS\.md/u);
    expect(stdout).toMatch(/\+\+\+ b\/~\/\.codex\/AGENTS\.md/u);
  }));

it("prints unchanged for repository and global outputs when nothing changed", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const stdout = runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(stdout).toMatch(/Repository outputs unchanged/u);
    expect(stdout).toMatch(/Global outputs unchanged/u);
    expect(stdout).not.toMatch(/BEGIN DIFF/u);
  }));

// (13) check exits 0 when outputs are current.
it("check exits 0 when repository outputs are current", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const { status, stdout } = runCliStatus(["check", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    expect(status).toBe(0);
    expect(stdout).toMatch(/Repository outputs are up to date/u);
  }));

it("check does not inspect global output files", () =>
  withTempRoot((tempRoot) => {
    const fakeHome = path.join(tempRoot, "home");
    const cliEnv = createCliEnv(fakeHome);
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const codexGlobalOutput = path.join(fakeHome, ".codex", "AGENTS.md");
    fs.rmSync(codexGlobalOutput, { force: true });
    fs.mkdirSync(codexGlobalOutput, { recursive: true });

    const { status, stdout, stderr } = runCliStatus(["check", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/Repository outputs are up to date/u);
  }));

// (14) check exits 1 when AGENTS.md is stale.
it("check exits 1 when AGENTS.md is stale", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    writeFile(path.join(projectRoot, "AGENTS.md"), "stale content\n");

    const { status, stdout } = runCliStatus(["check", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    expect(status).toBe(1);
    expect(stdout).toMatch(/Stale repository outputs/u);
    expect(stdout).toMatch(/- AGENTS\.md/u);
  }));

// (15) check writes no files.
it("check writes no files", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    const { status } = runCliStatus(["check", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    expect(status).toBe(1);
    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
  }));

it("check supports --json output", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });
    const { status, stdout } = runCliStatus(["check", "--json", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toEqual({
      check: true,
      upToDate: true,
      repositoryOutputs: DEFAULT_REPOSITORY_OUTPUTS,
      stale: []
    });
  }));

it("init --dry-run does not write files", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const stdout = runCli(["init", "--dry-run", "--root", projectRoot], { cwd: repoRoot });
    expect(stdout).toMatch(/Dry run/u);
    expect(fs.existsSync(path.join(projectRoot, "agent-ruleset.json"))).toBe(false);
  }));

it("init refuses to overwrite an existing ruleset without --force", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: ["local"], profile: "p" }, null, 2)
    );

    expect(() => runCli(["init", "--yes", "--root", projectRoot], { cwd: repoRoot })).toThrow(
      /Ruleset already exists/u
    );
  }));

it("init respects --quiet and --json", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");

    const stdoutQuiet = runCli(["init", "--yes", "--quiet", "--root", projectRoot], {
      cwd: repoRoot
    });
    expect(stdoutQuiet).toBe("");
    expect(fs.existsSync(path.join(projectRoot, "agent-ruleset.json"))).toBe(true);

    fs.rmSync(projectRoot, { recursive: true, force: true });

    const stdoutJson = runCli(["init", "--yes", "--json", "--root", projectRoot], {
      cwd: repoRoot
    });
    const result = JSON.parse(stdoutJson);
    expect(result.dryRun).toBe(false);
    expect(result.initialized).toEqual(["agent-ruleset.json"]);
    expect(result.composed).toEqual([]);
    expect(result.localRules).toBeUndefined();
    expect(stdoutJson).not.toMatch(/Initialized ruleset:/u);
  }));

it("compose respects --dry-run with --json", () =>
  withTempRoot((tempRoot) => {
    const cliEnv = createCliEnv(path.join(tempRoot, "home"));
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");

    writeBaseSource(sourceRoot, { global: null });
    // Global directory is optional; ensure the rules root exists for local resolution.
    fs.mkdirSync(path.join(sourceRoot, "rules"), { recursive: true });
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

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
  }));

it("init --dry-run with --json outputs plan", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const stdout = runCli(["init", "--dry-run", "--json", "--root", projectRoot], {
      cwd: repoRoot
    });
    const result = JSON.parse(stdout);
    expect(result.dryRun).toBe(true);
    expect(result.plan).toEqual([{ action: "create", path: "agent-ruleset.json" }]);
    expect(fs.existsSync(path.join(projectRoot, "agent-ruleset.json"))).toBe(false);
  }));

// (17) CLI help and README no longer recommend domains or extra.
it("help and README no longer expose legacy source/domains/extra options", () => {
  const help = runCli(["--help"], { cwd: repoRoot });
  expect(help).not.toMatch(/--domains/u);
  expect(help).not.toMatch(/--extra/u);
  expect(help).not.toMatch(/--source\b/u);
  expect(help).toMatch(/--profile/u);
  expect(help).toMatch(/\bcheck\b/u);

  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  expect(readme).not.toMatch(/--domains/u);
  expect(readme).not.toMatch(/--extra/u);
  expect(readme).not.toMatch(/"extra"/u);
  expect(readme).not.toMatch(/^\s*"source":/mu);
  expect(readme).toMatch(/"sources"/u);
  expect(readme).toMatch(/"profile"/u);
});

it("budget: no warning when within limits", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");

    writeProfileManifest(sourceRoot, { [BASE_PROFILE]: { domains: [] } });
    writeFile(path.join(rulesRoot, "global", "small.md"), "# Small\nA\nB\nC");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [relSource(projectRoot, sourceRoot)], profile: BASE_PROFILE },
        null,
        2
      )
    );

    const { stderr } = runCliResult(["--root", projectRoot], { cwd: repoRoot });
    expect(stderr).toBe("");
  }));

it("budget: emits per-module review advisory to stderr when a module exceeds advisory threshold", () =>
  withTempRoot((tempRoot) => {
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

    writeProfileManifest(sourceRoot, { [BASE_PROFILE]: { domains: [] } });
    writeFile(path.join(rulesRoot, "global", "big-module.md"), bigContent);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          budget: { totalTokens: moduleTokens + 500, moduleTokens: moduleBudget }
        },
        null,
        2
      )
    );

    const { stderr } = runCliResult(["--root", projectRoot], { cwd: repoRoot });
    expect(stderr).not.toMatch(/⚠ Global rules budget exceeded/u);
    expect(stderr).toMatch(
      new RegExp(
        `ℹ Modules over per-module review threshold \\(> ${moduleBudget} tokens, advisory\\):`,
        "u"
      )
    );
    expect(stderr).toMatch(new RegExp(`big-module\\.md: ${moduleTokens} tokens`, "u"));
    expect(stderr).toMatch(/Review whether listed modules contain procedural content/u);
  }));

it("budget: warns to stderr when total tokens exceed total limit", () =>
  withTempRoot((tempRoot) => {
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

    writeProfileManifest(sourceRoot, { [BASE_PROFILE]: { domains: [] } });
    writeFile(path.join(rulesRoot, "global", "a.md"), "# A\nline1\nline2");
    writeFile(path.join(rulesRoot, "global", "b.md"), "# B\nline1\nline2");
    writeFile(path.join(rulesRoot, "global", "c.md"), "# C\nline1\nline2");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          budget: { totalTokens: totalBudget, moduleTokens: DEFAULT_MODULE_BUDGET * 4 }
        },
        null,
        2
      )
    );

    const { stderr } = runCliResult(["--root", projectRoot], { cwd: repoRoot });
    expect(stderr).toMatch(
      new RegExp(
        `⚠ Global rules budget exceeded \\(${BUDGET_TOKENIZER}\\): ${totalTokens}/${totalBudget} tokens`,
        "u"
      )
    );
  }));

it("budget: warning is suppressed with --quiet", () =>
  withTempRoot((tempRoot) => {
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

    writeProfileManifest(sourceRoot, { [BASE_PROFILE]: { domains: [] } });
    writeFile(path.join(rulesRoot, "global", "big-module.md"), bigContent);
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          budget: { totalTokens: moduleTokens + 500, moduleTokens: moduleTokens - 1 }
        },
        null,
        2
      )
    );

    const { stderr } = runCliResult(["--quiet", "--root", projectRoot], { cwd: repoRoot });
    expect(stderr).toBe("");
  }));

it("budget: json output includes budget data when module advisory triggers", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");
    const overRule = formatRuleBlock(
      path.join(rulesRoot, "global", "over.md"),
      "# Over\nA\nB\nC",
      projectRoot
    );
    const moduleTokens = countBudgetTokens(overRule);

    writeProfileManifest(sourceRoot, { [BASE_PROFILE]: { domains: [] } });
    writeFile(path.join(rulesRoot, "global", "over.md"), "# Over\nA\nB\nC");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          budget: { totalTokens: moduleTokens + 500, moduleTokens: moduleTokens - 1 }
        },
        null,
        2
      )
    );

    const stdout = runCli(["--json", "--root", projectRoot], { cwd: repoRoot });
    const result = JSON.parse(stdout);
    expect(result.budget.totalExceeded).toBe(false);
    expect(result.budget.moduleReviewTriggered).toBe(true);
    expect(result.budget.tokenizer).toBe(BUDGET_TOKENIZER);
    expect(result.budget.overBudgetModules).toHaveLength(1);
    expect(result.budget.overBudgetModules[0].name).toBe("over.md");
    expect(result.budget.overBudgetModules[0].tokens).toBe(moduleTokens);
  }));

it("budget: apply-rules emits per-module review advisory on module advisory trigger", () =>
  withTempRoot((tempRoot) => {
    const projectRoot = path.join(tempRoot, "project");
    const sourceRoot = path.join(tempRoot, "rules-source");
    const rulesRoot = path.join(sourceRoot, "rules");
    const ruleSection = formatRuleBlock(
      path.join(rulesRoot, "global", "rule.md"),
      "# Rule\nA\nB",
      projectRoot
    );
    const moduleTokens = countBudgetTokens(ruleSection);

    writeProfileManifest(sourceRoot, { [BASE_PROFILE]: { domains: [] } });
    writeFile(path.join(rulesRoot, "global", "rule.md"), "# Rule\nA\nB");
    writeFile(
      path.join(projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        {
          sources: [relSource(projectRoot, sourceRoot)],
          profile: BASE_PROFILE,
          budget: { totalTokens: moduleTokens + 500, moduleTokens: moduleTokens - 1 }
        },
        null,
        2
      )
    );

    const { stderr } = runCliResult(["apply-rules", "--root", projectRoot], { cwd: repoRoot });
    expect(stderr).not.toMatch(/⚠ Global rules budget exceeded/u);
    expect(stderr).toMatch(/ℹ Modules over per-module review threshold/u);
    expect(stderr).toMatch(new RegExp(`rule\\.md: ${moduleTokens} tokens`, "u"));
  }));
