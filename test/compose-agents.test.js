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
const PRE_COMMIT = fs.readFileSync(path.join(repoRoot, ".husky", "pre-commit"), "utf8");

it("release publish verifies matching metadata and exact npm version before and after publishing", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "publish.yml"),
    "utf8"
  );
  expect(workflow).toMatch(/on:\s*\n\s+release:\s*\n\s+types:\s*\[published\]/u);
  expect(workflow).toContain("GITHUB_REF_NAME");
  expect(workflow).toContain("v${version}");
  expect(workflow).toContain("package-lock.json");
  expect(workflow).toContain("CHANGELOG.md");
  expect(workflow).toContain('npm view "compose-agentsmd@${version}" version');
  expect(workflow).toContain("npm publish --provenance");
  expect(workflow).toContain("already published; refusing a duplicate publish.");
  expect(workflow.match(/npm view "compose-agentsmd@\$\{version\}" version/gu)).toHaveLength(2);
  expect(workflow.indexOf('npm view "compose-agentsmd@${version}" version')).toBeLessThan(
    workflow.indexOf("npm publish --provenance")
  );
  expect(workflow.lastIndexOf('npm view "compose-agentsmd@${version}" version')).toBeGreaterThan(
    workflow.indexOf("npm publish --provenance")
  );
});

it("release consistency workflow checks main metadata against the exact npm package version", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "release-consistency.yml"),
    "utf8"
  );
  expect(workflow).toMatch(/branches:\s*\n\s+- main/u);
  for (const file of ["package.json", "package-lock.json", "CHANGELOG.md"]) {
    expect(workflow).toContain(file);
  }
  expect(workflow).toContain('npm view "compose-agentsmd@${version}" version');
  expect(workflow).toContain(
    "package.json declares ${version} but compose-agentsmd@${version} is not published to npm."
  );
  expect(workflow).toContain("Create/publish GitHub Release v${version}.");
});

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

const runGit = (args, options = {}) =>
  execFileSync("git", args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

const createGithubWorkspaceFixture = (tempRoot, { defaultBranch = "main" } = {}) => {
  const home = path.join(tempRoot, "home");
  const bareRoot = path.join(tempRoot, "remote.git");
  const seedRoot = path.join(tempRoot, "seed");
  const workspaceRoot = path.join(home, ".agentsmd", "workspace", "test-owner", "test-repo");
  const projectRoot = path.join(tempRoot, "project");
  const gitConfig = path.join(home, "gitconfig");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.dirname(workspaceRoot), { recursive: true });
  runGit(["init", "--bare", "-b", defaultBranch, bareRoot]);
  runGit(["init", "-b", defaultBranch, workspaceRoot]);
  writeFile(path.join(workspaceRoot, "rules", "global", "only.md"), "# Only\n1");
  writeFile(
    path.join(workspaceRoot, "agent-profiles.json"),
    JSON.stringify({ profiles: { base: { domains: [] } } })
  );
  runGit(["add", "."], { cwd: workspaceRoot });
  runGit(["commit", "-m", "Initial rules"], {
    cwd: workspaceRoot,
    env: {
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
  runGit(["tag", "v1.0.0"], { cwd: workspaceRoot });
  runGit(["remote", "add", "origin", bareRoot], { cwd: workspaceRoot });
  runGit(["push", "-u", "origin", defaultBranch, "v1.0.0"], { cwd: workspaceRoot });
  const localRemote = bareRoot.replace(/\\/gu, "/");
  writeFile(
    gitConfig,
    `[url "${localRemote}"]\n\tinsteadOf = https://github.com/test-owner/test-repo.git\n`
  );
  const env = {
    ...createCliEnv(home),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "true",
    GIT_TERMINAL_PROMPT: "0"
  };
  writeFile(
    path.join(projectRoot, "agent-ruleset.json"),
    JSON.stringify({ sources: ["github:test-owner/test-repo"], profile: "base" }, null, 2)
  );
  return { home, bareRoot, seedRoot, workspaceRoot, projectRoot, env, defaultBranch };
};

const prepareGithubWorkspace = (fixture) => {
  return fixture.workspaceRoot;
};

const prepareRemoteWriter = (fixture) => {
  if (!fs.existsSync(fixture.seedRoot)) {
    runGit(["clone", fixture.bareRoot, fixture.seedRoot], { env: fixture.env });
  }
};

const pushRemoteCommitWithoutAdvancingLocalCanonical = (fixture, message) => {
  const remoteCommitSha = runGit(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", message], {
    cwd: fixture.workspaceRoot,
    env: {
      ...fixture.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
  runGit(["push", "origin", `${remoteCommitSha}:refs/heads/${fixture.defaultBranch}`], {
    cwd: fixture.workspaceRoot,
    env: fixture.env
  });
};

const commitFile = (repoRootPath, fileName, content, env) => {
  writeFile(path.join(repoRootPath, fileName), content);
  runGit(["add", fileName], { cwd: repoRootPath, env });
  runGit(["commit", "-m", `Update ${fileName}`], {
    cwd: repoRootPath,
    env: {
      ...env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
  return runGit(["rev-parse", "HEAD"], { cwd: repoRootPath, env });
};

const commitEmpty = (repoRootPath, message, env) => {
  runGit(["commit", "--allow-empty", "-m", message], {
    cwd: repoRootPath,
    env: {
      ...env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
  return runGit(["rev-parse", "HEAD"], { cwd: repoRootPath, env });
};

const getRemoteBranchSha = (fixture, branch = fixture.defaultBranch) =>
  runGit(["--git-dir", fixture.bareRoot, "rev-parse", `refs/heads/${branch}`], {
    env: fixture.env
  });

const gitRefExists = (repoRootPath, ref, env) =>
  (() => {
    const result = spawnSync(
      "git",
      ["--git-dir", repoRootPath, "show-ref", "--verify", "--quiet", ref],
      { env: { ...process.env, ...env }, encoding: "utf8" }
    );
    if (result.status === 0) {
      return true;
    }
    if (result.status === 1) {
      return false;
    }
    throw new Error(
      result.stderr || result.error?.message || `git show-ref failed: ${result.status}`
    );
  })();

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

const expectOutputChanges = (actual, expected) => {
  expect(actual).toHaveLength(expected.length);
  for (const expectedChange of expected) {
    expect(actual).toContainEqual(expect.objectContaining(expectedChange));
  }
};

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

it("relies on trusted hooks instead of a model-enforced session gate", () => {
  expect(TOOL_RULES).not.toContain("Session gate");
  expect(TOOL_RULES).not.toContain("externally supplied human/operator instruction");
  expect(TOOL_RULES).toMatch(/AGENTS\.md.*generated|generated.*AGENTS\.md/iu);
  expect(TOOL_RULES).toMatch(/do not.*discard|must not.*discard/iu);
  expect(TOOL_RULES).toMatch(/commit.*push/iu);
  expect(TOOL_RULES).toContain("run it via `npx compose-agentsmd`");
  expect(TOOL_RULES).toContain("compose-agentsmd edit-rules");
  expect(TOOL_RULES).toContain("compose-agentsmd apply-rules");
  expect(TOOL_RULES).toMatch(/Do not create additional task branches.*remote default branch/iu);
  expect(TOOL_RULES).toMatch(/Explicit-ref sources keep their configured ref/u);
  expect(TOOL_RULES).toContain("Do not edit `AGENTS.md` directly");
  expect(TOOL_RULES).not.toContain("ANSI-colored diff-style preview");
  expect(TOOL_RULES).not.toContain("ask for explicit approval");
});

it("pre-commit only stages refreshed generated outputs", () => {
  expect(PRE_COMMIT).toContain("set -eu");
  expect(PRE_COMMIT).toMatch(/^git add -- AGENTS\.md CLAUDE\.md$/mu);
  expect(PRE_COMMIT).not.toMatch(/npm run (?:compose|verify|build)|npm test|(?:lint|typecheck)/iu);
  expect(PRE_COMMIT).toContain("set -eu");
  expect(PRE_COMMIT).not.toMatch(/\|\|\s*true/u);
});

it("pre-push checks generated output freshness without writing", () => {
  const prePushPath = path.join(repoRoot, ".husky", "pre-push");
  expect(fs.existsSync(prePushPath)).toBe(true);
  const prePush = fs.readFileSync(prePushPath, "utf8");
  expect(prePush).toContain("set -eu");
  expect(prePush).toMatch(/^npm run check:generated$/mu);
  expect(prePush).not.toMatch(/npm run verify|npm run compose|(?:^|\s)compose-agentsmd(?:\s|$)/iu);
  expect(prePush).not.toMatch(/\|\|\s*true/u);
});

it("does not retain the unused legacy pre-commit hook", () => {
  expect(fs.existsSync(path.join(repoRoot, ".githooks", "pre-commit"))).toBe(false);
});

it("verify includes generated repository output freshness", () => {
  expect(packageJson.scripts["check:generated"]).toMatch(
    /compose-agents\.js check --refresh --quiet/u
  );
  expect(packageJson.scripts.verify).toContain("npm run check:generated");
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
      changes: expect.any(Array),
      dryRun: false,
      budget: buildExpectedBudget([onlyRule])
    });
    expectOutputChanges(result.changes, [
      { scope: "repository", target: "CLAUDE.md", status: "updated" },
      ...DEFAULT_GLOBAL_OUTPUTS.map((target) => ({ scope: "global", target, status: "updated" }))
    ]);
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

it("edit-rules returns a latest GitHub workspace to the remote default branch", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    runGit(["switch", "-c", "codex/tutorial-authoring-v6-rule-sync"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });

    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.stdout).toMatch(/Do not create task branches.*canonical branch/u);
    const currentBranch = runGit(["branch", "--show-current"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const headSha = runGit(["rev-parse", "HEAD"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const originMainSha = runGit(["rev-parse", "origin/main"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const statusPorcelain = runGit(["status", "--porcelain"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });

    expect(result.status).toBe(0);
    expect(currentBranch).toBe("main");
    expect(headSha).toBe(originMainSha);
    expect(statusPorcelain).toBe("");
  }));

it("edit-rules creates a latest workspace on a non-main remote default branch", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot, { defaultBranch: "trunk" });
    fs.renameSync(fixture.workspaceRoot, path.join(fixture.home, "workspace-before-edit"));
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(
      runGit(["branch", "--show-current"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe("trunk");
    expect(fs.existsSync(path.join(fixture.workspaceRoot, ".git", "refs", "heads", "main"))).toBe(
      false
    );
    expect(
      runGit(["status", "--porcelain"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe("");
  }));

it("edit-rules fast-forwards a stale canonical workspace", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    pushRemoteCommitWithoutAdvancingLocalCanonical(fixture, "Remote update");
    const originDefaultSha = getRemoteBranchSha(fixture);
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      originDefaultSha
    );
  }));

it("edit-rules preserves ahead commits on the canonical branch", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    const localSha = commitFile(fixture.workspaceRoot, "local-update.txt", "local\n", fixture.env);
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(
      runGit(["branch", "--show-current"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe("main");
    expect(
      runGit(["cat-file", "-e", `${localSha}^{commit}`], {
        cwd: fixture.workspaceRoot,
        env: fixture.env
      })
    ).toBe("");
  }));

it("edit-rules recreates a missing local canonical tracking branch", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot, { defaultBranch: "trunk" });
    prepareGithubWorkspace(fixture);
    runGit(["switch", "-c", "codex/workspace-task"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    runGit(["branch", "-D", "trunk"], { cwd: fixture.workspaceRoot, env: fixture.env });
    const expectedSha = getRemoteBranchSha(fixture, "trunk");
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(
      runGit(["branch", "--show-current"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe("trunk");
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      expectedSha
    );
    expect(
      runGit(["config", "--get", "branch.trunk.remote"], {
        cwd: fixture.workspaceRoot,
        env: fixture.env
      })
    ).toBe("origin");
  }));

it.each(["task", "canonical"])(
  "edit-rules blocks a dirty %s branch without changing it",
  (branchKind) =>
    withTempRoot((tempRoot) => {
      const fixture = createGithubWorkspaceFixture(tempRoot);
      prepareGithubWorkspace(fixture);
      if (branchKind === "task") {
        runGit(["switch", "-c", "codex/workspace-task"], {
          cwd: fixture.workspaceRoot,
          env: fixture.env
        });
      }
      const branchBefore = runGit(["branch", "--show-current"], {
        cwd: fixture.workspaceRoot,
        env: fixture.env
      });
      const dirtyFile = path.join(fixture.workspaceRoot, "rules", "dirty.md");
      writeFile(dirtyFile, "preserve me\n");
      const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
        cwd: repoRoot,
        env: fixture.env
      });
      expect(result.status).not.toBe(0);
      expect(
        runGit(["branch", "--show-current"], { cwd: fixture.workspaceRoot, env: fixture.env })
      ).toBe(branchBefore);
      expect(fs.readFileSync(dirtyFile, "utf8")).toBe("preserve me\n");
    })
);

it("edit-rules blocks a detached latest workspace without creating a branch", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    const headBefore = runGit(["rev-parse", "HEAD"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    runGit(["switch", "--detach", headBefore], { cwd: fixture.workspaceRoot, env: fixture.env });
    const branchesBefore = runGit(["branch", "--list"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).not.toBe(0);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      headBefore
    );
    expect(runGit(["branch", "--list"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      branchesBefore
    );
  }));

it("edit-rules blocks diverged canonical history without changing local or remote heads", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    pushRemoteCommitWithoutAdvancingLocalCanonical(fixture, "Remote only");
    const remoteSha = getRemoteBranchSha(fixture);
    const localSha = commitEmpty(fixture.workspaceRoot, "Local only", fixture.env);
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).not.toBe(0);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      localSha
    );
    expect(getRemoteBranchSha(fixture)).toBe(remoteSha);
  }));

it("apply-rules pushes an ahead canonical latest workspace to its default branch", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    const localSha = commitFile(fixture.workspaceRoot, "local-update.txt", "local\n", fixture.env);
    const result = runCliStatus(["apply-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(getRemoteBranchSha(fixture)).toBe(localSha);
  }));

it("apply-rules composes latest rules from remote HEAD instead of the latest semver tag", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    const commitBSha = commitFile(
      fixture.workspaceRoot,
      "rules/global/only.md",
      "# Only\n2",
      fixture.env
    );
    const result = runCliStatus(["apply-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(getRemoteBranchSha(fixture)).toBe(commitBSha);

    const generated = fs.readFileSync(path.join(fixture.home, ".codex", "AGENTS.md"), "utf8");
    expect(generated).toContain("# Only\n2");
    expect(generated).not.toContain("# Only\n1");
  }));

it.each(["github:test-owner/test-repo", "github:test-owner/test-repo@latest"])(
  "compose resolves %s from remote HEAD rather than its semver tag",
  (source) =>
    withTempRoot((tempRoot) => {
      const fixture = createGithubWorkspaceFixture(tempRoot);
      prepareGithubWorkspace(fixture);
      commitFile(fixture.workspaceRoot, "rules/global/only.md", "# Only\nnew HEAD", fixture.env);
      runGit(["push", "origin", "main"], { cwd: fixture.workspaceRoot, env: fixture.env });
      writeFile(
        path.join(fixture.projectRoot, "agent-ruleset.json"),
        JSON.stringify({ sources: [source], profile: "base" }, null, 2)
      );

      runCli(["--root", fixture.projectRoot], { cwd: repoRoot, env: fixture.env });
      const generated = fs.readFileSync(path.join(fixture.home, ".codex", "AGENTS.md"), "utf8");
      expect(generated).toContain("# Only\nnew HEAD");
      expect(generated).not.toContain("# Only\n1");
    })
);

it("compose keeps an explicit semver tag pinned when remote HEAD advances", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    commitFile(fixture.workspaceRoot, "rules/global/only.md", "# Only\nnew HEAD", fixture.env);
    runGit(["push", "origin", "main"], { cwd: fixture.workspaceRoot, env: fixture.env });
    writeFile(
      path.join(fixture.projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: ["github:test-owner/test-repo@v1.0.0"], profile: "base" }, null, 2)
    );

    runCli(["--root", fixture.projectRoot], { cwd: repoRoot, env: fixture.env });
    const generated = fs.readFileSync(path.join(fixture.home, ".codex", "AGENTS.md"), "utf8");
    expect(generated).toContain("# Only\n1");
    expect(generated).not.toContain("new HEAD");
  }));

it("compose keeps an explicit commit pinned when remote HEAD advances", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    const pinnedSha = getRemoteBranchSha(fixture);
    commitFile(fixture.workspaceRoot, "rules/global/only.md", "# Only\nnew HEAD", fixture.env);
    runGit(["push", "origin", "main"], { cwd: fixture.workspaceRoot, env: fixture.env });
    writeFile(
      path.join(fixture.projectRoot, "agent-ruleset.json"),
      JSON.stringify(
        { sources: [`github:test-owner/test-repo@${pinnedSha}`], profile: "base" },
        null,
        2
      )
    );

    runCli(["--root", fixture.projectRoot], { cwd: repoRoot, env: fixture.env });
    const generated = fs.readFileSync(path.join(fixture.home, ".codex", "AGENTS.md"), "utf8");
    expect(generated).toContain("# Only\n1");
    expect(generated).not.toContain("new HEAD");
  }));

it("edit-rules blocks a clean task branch with commits absent from canonical", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    const taskBranch = "codex/unique-workspace-commit";
    runGit(["switch", "-c", taskBranch], { cwd: fixture.workspaceRoot, env: fixture.env });
    const taskCommitSha = commitEmpty(fixture.workspaceRoot, "Task-only commit", fixture.env);
    const remoteHeadBefore = getRemoteBranchSha(fixture);

    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/commits not present|unique commit/iu);
    expect(
      runGit(["branch", "--show-current"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe(taskBranch);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      taskCommitSha
    );
    expect(
      runGit(["status", "--porcelain"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe("");
    expect(
      runGit(["cat-file", "-e", `${taskCommitSha}^{commit}`], {
        cwd: fixture.workspaceRoot,
        env: fixture.env
      })
    ).toBe("");
    expect(getRemoteBranchSha(fixture)).toBe(remoteHeadBefore);
  }));

it("edit-rules self heals a stale task branch with no unique commits", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    runGit(["switch", "-c", "codex/stale-without-commits"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(
      runGit(["branch", "--show-current"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe("main");
  }));

it("edit-rules heals an ancestor task branch when canonical already contains its commits", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    runGit(["switch", "-c", "codex/canonical-ancestor"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    runGit(["switch", "main"], { cwd: fixture.workspaceRoot, env: fixture.env });
    const canonicalHead = commitFile(
      fixture.workspaceRoot,
      "rules/global/only.md",
      "# Only\ncanonical advance",
      fixture.env
    );
    runGit(["switch", "codex/canonical-ancestor"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(
      runGit(["branch", "--show-current"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe("main");
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      canonicalHead
    );
  }));

it("apply-rules fast-forwards a behind canonical workspace before pushing", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    pushRemoteCommitWithoutAdvancingLocalCanonical(fixture, "Remote update");
    const result = runCliStatus(["apply-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    const remoteSha = getRemoteBranchSha(fixture);
    expect(result.status).toBe(0);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      remoteSha
    );
    expect(getRemoteBranchSha(fixture)).toBe(remoteSha);
  }));

it("apply-rules blocks a non-canonical task branch without pushing it", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    runGit(["switch", "-c", "codex/workspace-task"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const taskSha = commitFile(fixture.workspaceRoot, "task-only.txt", "task\n", fixture.env);
    runGit(["branch", "--set-upstream-to", "origin/main"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const remoteTaskBefore = gitRefExists(
      fixture.bareRoot,
      "refs/heads/codex/workspace-task",
      fixture.env
    );
    const remoteCanonicalBefore = getRemoteBranchSha(fixture);
    const result = runCliStatus(["apply-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/non-canonical/u);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      taskSha
    );
    expect(getRemoteBranchSha(fixture)).toBe(remoteCanonicalBefore);
    expect(gitRefExists(fixture.bareRoot, "refs/heads/codex/workspace-task", fixture.env)).toBe(
      remoteTaskBefore
    );
  }));

it("apply-rules blocks a dirty canonical workspace without changing it", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    const dirtyFile = path.join(fixture.workspaceRoot, "rules", "dirty.md");
    writeFile(dirtyFile, "preserve me\n");
    const headBefore = runGit(["rev-parse", "HEAD"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    const result = runCliStatus(["apply-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).not.toBe(0);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      headBefore
    );
    expect(fs.readFileSync(dirtyFile, "utf8")).toBe("preserve me\n");
  }));

it("apply-rules blocks detached latest workspaces without creating a branch", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    const headBefore = runGit(["rev-parse", "HEAD"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    runGit(["switch", "--detach", headBefore], { cwd: fixture.workspaceRoot, env: fixture.env });
    const detached = runCliStatus(["apply-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(detached.status).not.toBe(0);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      headBefore
    );
  }));

it("apply-rules blocks a diverged latest workspace without changing either head", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    runGit(["switch", "-c", "fixture-remote-advance"], {
      cwd: fixture.workspaceRoot,
      env: fixture.env
    });
    commitEmpty(fixture.workspaceRoot, "Remote only", fixture.env);
    runGit(["push", "origin", "HEAD:main"], { cwd: fixture.workspaceRoot, env: fixture.env });
    runGit(["switch", "main"], { cwd: fixture.workspaceRoot, env: fixture.env });
    const localSha = commitEmpty(fixture.workspaceRoot, "Local only", fixture.env);
    const remoteSha = getRemoteBranchSha(fixture);
    const diverged = runCliStatus(["apply-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(diverged.status).not.toBe(0);
    expect(runGit(["rev-parse", "HEAD"], { cwd: fixture.workspaceRoot, env: fixture.env })).toBe(
      localSha
    );
    expect(getRemoteBranchSha(fixture)).toBe(remoteSha);
  }));

it("edit-rules preserves an explicit GitHub ref instead of switching to default", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot, { defaultBranch: "trunk" });
    prepareRemoteWriter(fixture);
    runGit(["switch", "-c", "release"], { cwd: fixture.seedRoot, env: fixture.env });
    commitFile(fixture.seedRoot, "release-only.txt", "release\n", fixture.env);
    runGit(["push", "-u", "origin", "release"], { cwd: fixture.seedRoot, env: fixture.env });
    writeFile(
      path.join(fixture.projectRoot, "agent-ruleset.json"),
      JSON.stringify({ sources: ["github:test-owner/test-repo@release"], profile: "base" }, null, 2)
    );
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).toBe(0);
    expect(
      runGit(["branch", "--show-current"], { cwd: fixture.workspaceRoot, env: fixture.env })
    ).toBe("release");
  }));

it("edit-rules blocks when remote default branch cannot be resolved", () =>
  withTempRoot((tempRoot) => {
    const fixture = createGithubWorkspaceFixture(tempRoot);
    prepareGithubWorkspace(fixture);
    runGit(["symbolic-ref", "HEAD", "refs/heads/not-published"], {
      cwd: fixture.bareRoot,
      env: fixture.env
    });
    const result = runCliStatus(["edit-rules", "--root", fixture.projectRoot], {
      cwd: repoRoot,
      env: fixture.env
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(
      /Unable to resolve remote default branch/u
    );
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
      changes: expect.any(Array),
      dryRun: false,
      budget: buildExpectedBudget([onlyRule])
    });
    expectOutputChanges(result.changes, [
      ...DEFAULT_REPOSITORY_OUTPUTS.map((target) => ({
        scope: "repository",
        target,
        status: "updated"
      })),
      ...DEFAULT_GLOBAL_OUTPUTS.map((target) => ({ scope: "global", target, status: "updated" }))
    ]);

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
      changes: expect.any(Array),
      dryRun: true,
      budget: buildExpectedBudget([onlyRule])
    });
    expectOutputChanges(result.changes, [
      ...DEFAULT_REPOSITORY_OUTPUTS.map((target) => ({
        scope: "repository",
        target,
        status: "updated"
      })),
      ...DEFAULT_GLOBAL_OUTPUTS.map((target) => ({ scope: "global", target, status: "updated" }))
    ]);
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
      changes: expect.any(Array),
      dryRun: false,
      budget: buildExpectedBudget([onlyRule])
    });
    expectOutputChanges(result.changes, [
      ...DEFAULT_REPOSITORY_OUTPUTS.map((target) => ({
        scope: "repository",
        target,
        status: "updated"
      })),
      ...DEFAULT_GLOBAL_OUTPUTS.map((target) => ({ scope: "global", target, status: "updated" }))
    ]);

    const repeatResult = JSON.parse(
      runCli(["--json", "--root", projectRoot], { cwd: repoRoot, env: cliEnv })
    );
    expectOutputChanges(repeatResult.changes, [
      ...DEFAULT_REPOSITORY_OUTPUTS.map((target) => ({
        scope: "repository",
        target,
        status: "unchanged"
      })),
      ...DEFAULT_GLOBAL_OUTPUTS.map((target) => ({ scope: "global", target, status: "unchanged" }))
    ]);
  }));

it("returns independent patches for stale global outputs", () =>
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
    const globalPath = (target) => path.join(fakeHome, target.slice(2).replace(/\//gu, path.sep));
    writeFile(globalPath(DEFAULT_GLOBAL_OUTPUTS[0]), "codex stale\n");
    writeFile(globalPath(DEFAULT_GLOBAL_OUTPUTS[1]), "opencode stale\n");

    const result = JSON.parse(
      runCli(["--json", "--root", projectRoot], { cwd: repoRoot, env: cliEnv })
    );
    const expectedGlobalChanges = [
      { scope: "global", target: DEFAULT_GLOBAL_OUTPUTS[0], status: "updated" },
      { scope: "global", target: DEFAULT_GLOBAL_OUTPUTS[1], status: "updated" },
      ...DEFAULT_GLOBAL_OUTPUTS.slice(2).map((target) => ({
        scope: "global",
        target,
        status: "unchanged"
      }))
    ];
    expectOutputChanges(
      result.changes.filter((change) => change.scope === "global"),
      expectedGlobalChanges
    );

    const codexChange = result.changes.find(
      (change) => change.target === DEFAULT_GLOBAL_OUTPUTS[0]
    );
    const opencodeChange = result.changes.find(
      (change) => change.target === DEFAULT_GLOBAL_OUTPUTS[1]
    );
    expect(codexChange.patch).toContain("codex stale");
    expect(codexChange.patch).toContain("a/~/.codex/AGENTS.md");
    expect(codexChange.patch).not.toContain("opencode stale");
    expect(opencodeChange.patch).toContain("opencode stale");
    expect(opencodeChange.patch).toContain("a/~/.config/opencode/AGENTS.md");
    expect(opencodeChange.patch).not.toContain("codex stale");
  }));

it("returns separate repository patches for primary and Claude companion outputs", () =>
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
    writeFile(path.join(projectRoot, "AGENTS.md"), "primary stale\n");
    writeFile(path.join(projectRoot, "CLAUDE.md"), "companion stale\n");

    const result = JSON.parse(
      runCli(["--json", "--root", projectRoot], { cwd: repoRoot, env: cliEnv })
    );
    expectOutputChanges(
      result.changes.filter((change) => change.scope === "repository"),
      DEFAULT_REPOSITORY_OUTPUTS.map((target) => ({
        scope: "repository",
        target,
        status: "updated"
      }))
    );
    const primaryChange = result.changes.find((change) => change.target === "AGENTS.md");
    const companionChange = result.changes.find((change) => change.target === "CLAUDE.md");
    expect(primaryChange.patch).toContain("primary stale");
    expect(primaryChange.patch).toContain("a/AGENTS.md");
    expect(primaryChange.patch).not.toContain("companion stale");
    expect(companionChange.patch).toContain("companion stale");
    expect(companionChange.patch).toContain("a/CLAUDE.md");
    expect(companionChange.patch).not.toContain("primary stale");
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

it("check treats CRLF repository outputs as fresh without changing their bytes", () =>
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
    const outputPaths = DEFAULT_REPOSITORY_OUTPUTS.map((target) => path.join(projectRoot, target));
    for (const outputPath of outputPaths) {
      const lfContent = fs.readFileSync(outputPath, "utf8");
      expect(lfContent).toContain("\n");
      expect(lfContent).not.toContain("\r\n");
      fs.writeFileSync(outputPath, lfContent.replace(/\r\n|\n|\r/gu, "\r\n"), "utf8");
    }
    const bytesBefore = outputPaths.map((outputPath) => fs.readFileSync(outputPath));

    const { status, stdout, stderr } = runCliStatus(["check", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/Repository outputs are up to date/u);
    for (const [index, outputPath] of outputPaths.entries()) {
      expect(fs.readFileSync(outputPath)).toEqual(bytesBefore[index]);
    }
  }));

it("check still detects real content differences in CRLF repository outputs", () =>
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
    const agentsPath = path.join(projectRoot, "AGENTS.md");
    const lfContent = fs.readFileSync(agentsPath, "utf8");
    const changedContent = `${lfContent[0] === "!" ? "?" : "!"}${lfContent.slice(1)}`;
    expect(changedContent).not.toBe(lfContent);
    fs.writeFileSync(agentsPath, changedContent.replace(/\r\n|\n|\r/gu, "\r\n"), "utf8");
    const staleBytes = fs.readFileSync(agentsPath);

    const { status, stdout, stderr } = runCliStatus(["check", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });

    expect(status).toBe(1);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/Stale repository outputs/u);
    expect(stdout).toMatch(/- AGENTS\.md/u);
    expect(fs.readFileSync(agentsPath)).toEqual(staleBytes);
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
it("check detects stale AGENTS.md without modifying generated outputs", () =>
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
    const staleAgents = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    const claudeBefore = fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8");

    const { status, stdout } = runCliStatus(["check", "--refresh", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    expect(status).toBe(1);
    expect(stdout).toMatch(/Stale repository outputs/u);
    expect(stdout).toMatch(/- AGENTS\.md/u);
    expect(fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8")).toBe(staleAgents);
    expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe(claudeBefore);
  }));

it("compose repairs stale repository outputs and generated check passes", () =>
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
    const expectedAgents = fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8");
    const expectedClaude = fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8");
    writeFile(path.join(projectRoot, "AGENTS.md"), "stale AGENTS\n");
    writeFile(path.join(projectRoot, "CLAUDE.md"), "stale CLAUDE\n");

    runCli(["--root", projectRoot], { cwd: repoRoot, env: cliEnv });

    expect(fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8")).toBe(expectedAgents);
    expect(fs.readFileSync(path.join(projectRoot, "CLAUDE.md"), "utf8")).toBe(expectedClaude);
    const { status } = runCliStatus(["check", "--root", projectRoot], {
      cwd: repoRoot,
      env: cliEnv
    });
    expect(status).toBe(0);
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
    const staleGlobalPath = path.join(fakeHome, ".codex", "AGENTS.md");
    writeFile(staleGlobalPath, "global stale content\n");
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
      stale: [],
      changes: expect.any(Array)
    });
    expectOutputChanges(result.changes, [
      ...DEFAULT_REPOSITORY_OUTPUTS.map((target) => ({
        scope: "repository",
        target,
        status: "unchanged"
      }))
    ]);
    expect(fs.readFileSync(staleGlobalPath, "utf8")).toBe("global stale content\n");
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

    writeBaseSource(sourceRoot);
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
    expectOutputChanges(result.changes, [
      ...DEFAULT_REPOSITORY_OUTPUTS.map((target) => ({
        scope: "repository",
        target,
        status: "updated"
      })),
      ...DEFAULT_GLOBAL_OUTPUTS.map((target) => ({ scope: "global", target, status: "updated" }))
    ]);
    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
    for (const target of DEFAULT_GLOBAL_OUTPUTS) {
      expect(fs.existsSync(path.join(cliEnv.HOME, target.slice(2).replace(/\//gu, path.sep)))).toBe(
        false
      );
    }
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
