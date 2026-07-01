#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
import { Ajv, type ErrorObject } from "ajv";
import { createTwoFilesPatch } from "diff";
import { countTokens } from "gpt-tokenizer";
import { prepareGitFallbackDestination } from "./git-fallback.js";
import { resolveProfileSelections } from "./profiles.js";

const DEFAULT_RULESET_NAME = "agent-ruleset.json";
const DEFAULT_OUTPUT = "AGENTS.md";
const DEFAULT_CLAUDE_OUTPUT = "CLAUDE.md";
const DEFAULT_CODEX_GLOBAL_OUTPUT = path.join(os.homedir(), ".codex", "AGENTS.md");
const DEFAULT_CLAUDE_GLOBAL_OUTPUT = path.join(os.homedir(), ".claude", "CLAUDE.md");
const DEFAULT_GEMINI_GLOBAL_OUTPUT = path.join(os.homedir(), ".gemini", "GEMINI.md");
const DEFAULT_COPILOT_GLOBAL_OUTPUT = path.join(
  os.homedir(),
  ".copilot",
  "copilot-instructions.md"
);
const DEFAULT_CACHE_ROOT = path.join(os.homedir(), ".agentsmd", "cache");
const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), ".agentsmd", "workspace");
const DEFAULT_INIT_SOURCES: string[] = ["github:owner/repo"];
const DEFAULT_INIT_PROFILE = "node-cli";
const RULESET_SCHEMA_PATH = new URL("../agent-ruleset.schema.json", import.meta.url);
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);

type CliArgs = {
  help?: boolean;
  version?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  root?: string;
  ruleset?: string;
  rulesetName?: string;
  refresh?: boolean;
  clearCache?: boolean;
  profile?: string;
  output?: string;
  global?: boolean;
  compose?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  command?: "compose" | "edit-rules" | "apply-rules" | "init" | "check";
};

const TOOL_RULES_PATH = new URL("../tools/tool-rules.md", import.meta.url);
const USAGE_PATH = new URL("../tools/usage.txt", import.meta.url);

const BUDGET_TOKENIZER = "o200k_base";
// Token budgets for the composed global rules.
// - DEFAULT_TOTAL_BUDGET: hard budget for the always-loaded global rules.
//   Sized to accommodate realistic invariant density (~80–120 invariants ×
//   ~30–50 tokens each ≈ 5–6k tokens) plus structural margin and growth
//   headroom, while staying a small fraction of the smallest target model's
//   effective system-prompt window. Total exceedance is a budget violation.
// - DEFAULT_MODULE_BUDGET: per-module advisory threshold, NOT a violation.
//   Crossing it triggers a review prompt to check whether the module is
//   leaking procedural content (procedures belong in skills, not rules).
const DEFAULT_TOTAL_BUDGET = 8000;
const DEFAULT_MODULE_BUDGET = 800;
const LINT_HEADER = "<!-- markdownlint-disable MD025 -->";

const readValueArg = (remaining: string[], index: number, flag: string): string => {
  const value = remaining[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {};
  const knownCommands = new Set(["edit-rules", "apply-rules", "init", "check"]);
  const remaining = [...argv];

  if (remaining.length > 0 && knownCommands.has(remaining[0])) {
    args.command = remaining.shift() as "edit-rules" | "apply-rules" | "init" | "check";
  }

  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-V") {
      args.version = true;
      continue;
    }

    if (arg === "--verbose" || arg === "-v") {
      args.verbose = true;
      continue;
    }

    if (arg === "--quiet" || arg === "-q") {
      args.quiet = true;
      continue;
    }

    if (arg === "--json") {
      args.json = true;
      continue;
    }

    if (arg === "--root") {
      const value = readValueArg(remaining, i, "--root");
      args.root = value;
      i += 1;
      continue;
    }

    if (arg === "--ruleset") {
      const value = readValueArg(remaining, i, "--ruleset");
      args.ruleset = value;
      i += 1;
      continue;
    }

    if (arg === "--ruleset-name") {
      const value = readValueArg(remaining, i, "--ruleset-name");
      args.rulesetName = value;
      i += 1;
      continue;
    }

    if (arg === "--refresh") {
      args.refresh = true;
      continue;
    }

    if (arg === "--clear-cache") {
      args.clearCache = true;
      continue;
    }

    if (arg === "--profile") {
      const value = readValueArg(remaining, i, "--profile");
      args.profile = value;
      i += 1;
      continue;
    }

    if (arg === "--output") {
      const value = readValueArg(remaining, i, "--output");
      args.output = value;
      i += 1;
      continue;
    }

    if (arg === "--no-global") {
      args.global = false;
      continue;
    }

    if (arg === "--compose") {
      args.compose = true;
      continue;
    }

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--yes") {
      args.yes = true;
      continue;
    }

    if (arg === "--force") {
      args.force = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
};

const normalizeTrailingWhitespace = (content: string): string => content.replace(/\s+$/u, "");
const normalizePath = (filePath: string): string => filePath.replace(/\\/g, "/");
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const askQuestion = (prompt: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

const usage = normalizeTrailingWhitespace(fs.readFileSync(USAGE_PATH, "utf8"));
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version?: string };
const getVersion = (): string => packageJson.version ?? "unknown";

const rulesetSchema = JSON.parse(fs.readFileSync(RULESET_SCHEMA_PATH, "utf8"));
const TOOL_RULES = normalizeTrailingWhitespace(fs.readFileSync(TOOL_RULES_PATH, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateRulesetSchema = ajv.compile(rulesetSchema);

const formatSchemaErrors = (errors: ErrorObject[] | null | undefined): string => {
  if (!errors || errors.length === 0) {
    return "Unknown schema validation error";
  }

  return errors
    .map((error) => {
      const pathLabel = error.instancePath ? error.instancePath : "(root)";
      return `${pathLabel} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
};

const resolveFrom = (baseDir: string, targetPath: string): string => {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }

  return path.resolve(baseDir, targetPath);
};

const isSubPath = (baseDir: string, targetPath: string): boolean => {
  const relativePath = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const toDisplayPath = (rootDir: string, filePath: string): string => {
  if (isSubPath(rootDir, filePath)) {
    const relativePath = path.relative(rootDir, filePath);
    return normalizePath(relativePath || path.basename(filePath));
  }

  const homeDir = os.homedir();
  if (isSubPath(homeDir, filePath)) {
    const relativeToHome = normalizePath(path.relative(homeDir, filePath));
    return relativeToHome ? `~/${relativeToHome}` : "~";
  }

  return normalizePath(path.resolve(filePath));
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const clearCache = (): void => {
  if (fs.existsSync(DEFAULT_CACHE_ROOT)) {
    fs.rmSync(DEFAULT_CACHE_ROOT, { recursive: true, force: true });
  }
};

const ensureFileExists = (filePath: string): void => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }
};

const ensureDirectoryExists = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Missing directory: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
};

const isExistingDirectory = (dirPath: string): boolean =>
  fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();

const stripJsonComments = (input: string): string => {
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

const readJsonFile = (filePath: string): unknown => {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(stripJsonComments(raw));
};

type ProjectRuleset = {
  sources: string[];
  profile: string;
  global?: boolean;
  output?: string;
  claude?: {
    enabled?: boolean;
    output?: string;
  };
  budget?: {
    totalTokens?: number;
    moduleTokens?: number;
  };
};

const readProjectRuleset = (rulesetPath: string): ProjectRuleset => {
  const parsed = readJsonFile(rulesetPath);
  const isValid = validateRulesetSchema(parsed);
  if (!isValid) {
    const message = formatSchemaErrors(validateRulesetSchema.errors);
    throw new Error(`Invalid ruleset schema in ${rulesetPath}: ${message}`);
  }

  const ruleset = parsed as ProjectRuleset;
  if (ruleset.output === undefined) {
    ruleset.output = DEFAULT_OUTPUT;
  }
  if (ruleset.claude === undefined) {
    ruleset.claude = {};
  }
  if (ruleset.claude.enabled === undefined) {
    ruleset.claude.enabled = true;
  }
  if (ruleset.claude.output === undefined) {
    ruleset.claude.output = DEFAULT_CLAUDE_OUTPUT;
  }
  if (ruleset.global === undefined) {
    ruleset.global = true;
  }

  return ruleset;
};

type GithubSource = {
  owner: string;
  repo: string;
  ref: string;
  url: string;
};

const collectMarkdownFiles = (rootDir: string): string[] => {
  ensureDirectoryExists(rootDir);

  const results: string[] = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symbolic links (including Windows junctions). Following them would
      // let a malicious source compose files outside its declared rules/domains
      // boundary through the markdown collector.
      if (entry.isSymbolicLink()) {
        continue;
      }

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

type ComposeOptions = {
  refresh?: boolean;
  dryRun?: boolean;
  emitDiffs?: boolean;
  emitGlobalDiffs?: boolean;
};

type OutputScope = "repository" | "global";

type OutputGroupDiff = {
  scope: OutputScope;
  targets: string[];
  status: "unchanged" | "updated";
  patch?: string;
};

type BudgetCheckResult = {
  tokenizer: string;
  totalTokens: number;
  totalBudget: number;
  moduleBudget: number;
  overBudgetModules: Array<{ name: string; tokens: number }>;
  totalExceeded: boolean;
  moduleReviewTriggered: boolean;
};

type RepositoryComposedFile = {
  absolutePath: string;
  displayPath: string;
  content: string;
};

type ComposeResult = {
  output: string;
  outputs: string[];
  repositoryOutputs: string[];
  globalOutputs: string[];
  repositoryFiles: RepositoryComposedFile[];
  outputDiffs: OutputGroupDiff[];
  budgetResult: BudgetCheckResult;
};

const sanitizeCacheSegment = (value: string): string => value.replace(/[\\/]/gu, "__");
const looksLikeCommitHash = (value: string): boolean => /^[a-f0-9]{7,40}$/iu.test(value);

const execGit = (args: string[], cwd?: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const parseGithubSource = (source: string): GithubSource => {
  const trimmed = source.trim();
  if (!trimmed.startsWith("github:")) {
    throw new Error(`Unsupported source: ${source}`);
  }

  const withoutPrefix = trimmed.slice("github:".length);
  const [repoPart, refPart] = withoutPrefix.split("@");
  const [owner, repo] = repoPart.split("/");

  if (!isNonEmptyString(owner) || !isNonEmptyString(repo)) {
    throw new Error(`Invalid GitHub source (expected github:owner/repo@ref): ${source}`);
  }

  const ref = isNonEmptyString(refPart) ? refPart : "latest";
  return { owner, repo, ref, url: `https://github.com/${owner}/${repo}.git` };
};

const parseSemver = (tag: string): number[] | null => {
  const cleaned = tag.startsWith("v") ? tag.slice(1) : tag;
  const parts = cleaned.split(".");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => Number.isNaN(value))) {
    return null;
  }

  return numbers;
};

const compareSemver = (a: number[], b: number[]): number => {
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
};

const resolveLatestTag = (repoUrl: string): { tag?: string; hash?: string } => {
  const raw = execGit(["ls-remote", "--tags", "--refs", repoUrl]);
  if (!raw) {
    return {};
  }

  const candidates = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, ref] = line.split(/\s+/u);
      const tag = ref?.replace("refs/tags/", "");
      if (!hash || !tag) {
        return null;
      }
      const semver = parseSemver(tag);
      if (!semver) {
        return null;
      }
      return { hash, tag, semver };
    })
    .filter((item): item is { hash: string; tag: string; semver: number[] } => Boolean(item));

  if (candidates.length === 0) {
    return {};
  }

  candidates.sort((a, b) => compareSemver(a.semver, b.semver));
  const latest = candidates[candidates.length - 1];
  return { tag: latest.tag, hash: latest.hash };
};

const resolveHeadHash = (repoUrl: string): string => {
  const raw = execGit(["ls-remote", repoUrl, "HEAD"]);
  const [hash] = raw.split(/\s+/u);
  if (!hash) {
    throw new Error(`Unable to resolve HEAD for ${repoUrl}`);
  }
  return hash;
};

const resolveRefHash = (repoUrl: string, ref: string): string | null => {
  const raw = execGit(["ls-remote", repoUrl, ref, `refs/tags/${ref}`, `refs/heads/${ref}`]);
  if (!raw) {
    return null;
  }
  const [hash] = raw.split(/\s+/u);
  return hash ?? null;
};

const cloneAtRef = (repoUrl: string, ref: string, destination: string): void => {
  execGit(["clone", "--depth", "1", "--branch", ref, repoUrl, destination]);
};

const fetchCommit = (repoUrl: string, commitHash: string, destination: string): void => {
  prepareGitFallbackDestination(destination);
  execGit(["init"], destination);
  execGit(["remote", "add", "origin", repoUrl], destination);
  execGit(["fetch", "--depth", "1", "origin", commitHash], destination);
  execGit(["checkout", "FETCH_HEAD"], destination);
};

const resolveGithubRulesRoot = (
  source: string,
  refresh: boolean
): { rulesRoot: string; resolvedRef: string } => {
  const parsed = parseGithubSource(source);
  const resolved = parsed.ref === "latest" ? resolveLatestTag(parsed.url) : null;
  const resolvedRef = resolved?.tag ?? (parsed.ref === "latest" ? "HEAD" : parsed.ref);
  const resolvedHash =
    resolved?.hash ??
    (resolvedRef === "HEAD"
      ? resolveHeadHash(parsed.url)
      : resolveRefHash(parsed.url, resolvedRef));

  if (!resolvedHash && !looksLikeCommitHash(resolvedRef)) {
    throw new Error(`Unable to resolve ref ${resolvedRef} for ${parsed.url}`);
  }

  const cacheSegment =
    resolvedRef === "HEAD"
      ? sanitizeCacheSegment(resolvedHash ?? resolvedRef)
      : sanitizeCacheSegment(resolvedRef);
  const cacheDir = path.join(DEFAULT_CACHE_ROOT, parsed.owner, parsed.repo, cacheSegment);

  if (refresh && fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  if (!fs.existsSync(cacheDir)) {
    ensureDir(path.dirname(cacheDir));
    try {
      cloneAtRef(parsed.url, resolvedRef, cacheDir);
    } catch (error) {
      if (resolvedHash && looksLikeCommitHash(resolvedHash)) {
        fetchCommit(parsed.url, resolvedHash, cacheDir);
      } else if (looksLikeCommitHash(resolvedRef)) {
        fetchCommit(parsed.url, resolvedRef, cacheDir);
      } else {
        throw error;
      }
    }
  }

  const rulesRoot = path.join(cacheDir, "rules");
  ensureDirectoryExists(rulesRoot);

  return { rulesRoot, resolvedRef };
};

const resolveLocalRulesRoot = (rulesetDir: string, source: string): string => {
  const resolvedSource = resolveFrom(rulesetDir, source);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Missing source path: ${resolvedSource}`);
  }

  const candidate =
    path.basename(resolvedSource) === "rules" ? resolvedSource : path.join(resolvedSource, "rules");
  ensureDirectoryExists(candidate);
  return candidate;
};

const resolveWorkspaceRoot = (rulesetDir: string, source: string): string => {
  if (source.startsWith("github:")) {
    const parsed = parseGithubSource(source);
    return path.join(DEFAULT_WORKSPACE_ROOT, parsed.owner, parsed.repo);
  }

  return resolveFrom(rulesetDir, source);
};

const ensureWorkspaceForGithubSource = (source: string): string => {
  const parsed = parseGithubSource(source);
  const workspaceRoot = path.join(DEFAULT_WORKSPACE_ROOT, parsed.owner, parsed.repo);

  if (!fs.existsSync(workspaceRoot)) {
    ensureDir(path.dirname(workspaceRoot));
    execGit(["clone", parsed.url, workspaceRoot]);
  }

  if (parsed.ref !== "latest") {
    execGit(["fetch", "--all"], workspaceRoot);
    execGit(["checkout", parsed.ref], workspaceRoot);
  }

  return workspaceRoot;
};

const applyRulesFromWorkspace = (source: string): void => {
  if (!source.startsWith("github:")) {
    return;
  }

  const workspaceRoot = ensureWorkspaceForGithubSource(source);
  const status = execGit(["status", "--porcelain"], workspaceRoot);
  if (status) {
    throw new Error(`Workspace has uncommitted changes: ${workspaceRoot}`);
  }

  const branch = execGit(["rev-parse", "--abbrev-ref", "HEAD"], workspaceRoot);
  if (branch === "HEAD") {
    throw new Error(`Workspace is in detached HEAD state: ${workspaceRoot}`);
  }

  execGit(["push"], workspaceRoot);
};

// A resolved rules source: its on-disk rules root, the source repo root (which
// holds `agent-profiles.json`), and the ref label used for rule provenance.
type SourceContext = {
  source: string;
  rulesRoot: string;
  sourceRoot: string;
  resolvedRef?: string;
};

const resolveRulesRoot = (
  rulesetDir: string,
  source: string,
  refresh: boolean
): { rulesRoot: string; resolvedRef?: string } => {
  if (source.startsWith("github:")) {
    return resolveGithubRulesRoot(source, refresh);
  }

  return { rulesRoot: resolveLocalRulesRoot(rulesetDir, source) };
};

const resolveSourceContexts = (
  rulesetDir: string,
  sources: string[],
  refresh: boolean
): SourceContext[] =>
  sources.map((source) => {
    const { rulesRoot, resolvedRef } = resolveRulesRoot(rulesetDir, source, refresh);
    return {
      source,
      rulesRoot,
      sourceRoot: path.dirname(rulesRoot),
      resolvedRef
    };
  });

const formatRuleSourcePath = (
  rulePath: string,
  context: SourceContext,
  rulesetDir: string
): string => {
  const isFromSource = rulePath.startsWith(context.rulesRoot);

  if (isFromSource && context.source.startsWith("github:")) {
    const parsed = parseGithubSource(context.source);
    const cacheRepoRoot = path.dirname(context.rulesRoot);
    const relativePath = normalizePath(path.relative(cacheRepoRoot, rulePath));
    const refToUse = context.resolvedRef ?? parsed.ref;
    return `github:${parsed.owner}/${parsed.repo}@${refToUse}/${relativePath}`;
  }

  return normalizePath(path.relative(rulesetDir, rulePath));
};

const getGlobalOutputPaths = (): string[] => [
  DEFAULT_CODEX_GLOBAL_OUTPUT,
  DEFAULT_CLAUDE_GLOBAL_OUTPUT,
  DEFAULT_GEMINI_GLOBAL_OUTPUT,
  DEFAULT_COPILOT_GLOBAL_OUTPUT
];

const resolveOutputPaths = (
  rulesetDir: string,
  projectRuleset: ProjectRuleset
): { primaryOutputPath: string; companionOutputPath?: string; globalOutputPaths: string[] } => {
  const primaryOutputPath = resolveFrom(rulesetDir, projectRuleset.output ?? DEFAULT_OUTPUT);
  const claude = projectRuleset.claude ?? {};
  const companionEnabled = claude.enabled !== false;
  const configuredCompanionPath = resolveFrom(rulesetDir, claude.output ?? DEFAULT_CLAUDE_OUTPUT);
  const globalOutputPaths = projectRuleset.global === false ? [] : getGlobalOutputPaths();

  if (
    !companionEnabled ||
    path.resolve(primaryOutputPath) === path.resolve(configuredCompanionPath)
  ) {
    return { primaryOutputPath, globalOutputPaths };
  }

  return {
    primaryOutputPath,
    companionOutputPath: configuredCompanionPath,
    globalOutputPaths
  };
};

const buildClaudeCompanionContent = (
  primaryOutputPath: string,
  companionOutputPath: string
): string => {
  const relativeImportPath = normalizePath(
    path.relative(path.dirname(companionOutputPath), primaryOutputPath)
  );
  return `@${relativeImportPath}\n`;
};

const buildInstructionContent = (parts: string[], includeToolRules: boolean): string => {
  const sections = includeToolRules ? [normalizeTrailingWhitespace(TOOL_RULES), ...parts] : parts;
  if (sections.length === 0) {
    return "";
  }

  return `${LINT_HEADER}\n${sections.join("\n\n")}\n`;
};

const countBudgetTokens = (content: string): number => {
  if (content.length === 0) {
    return 0;
  }

  return countTokens(content);
};

const buildScopeDiff = (
  scope: OutputScope,
  targetPaths: string[],
  desiredContent: string,
  rootDir: string
): OutputGroupDiff | undefined => {
  if (targetPaths.length === 0) {
    return undefined;
  }

  const displayTargets = targetPaths.map((filePath) => toDisplayPath(rootDir, filePath));
  const changedTargetPath = targetPaths.find((filePath) => {
    if (!fs.existsSync(filePath)) {
      return true;
    }

    return fs.readFileSync(filePath, "utf8") !== desiredContent;
  });

  if (!changedTargetPath) {
    return {
      scope,
      targets: displayTargets,
      status: "unchanged"
    };
  }

  const before = fs.existsSync(changedTargetPath) ? fs.readFileSync(changedTargetPath, "utf8") : "";
  const displayPath = toDisplayPath(rootDir, changedTargetPath);

  return {
    scope,
    targets: displayTargets,
    status: "updated",
    patch: createTwoFilesPatch(
      `a/${displayPath}`,
      `b/${displayPath}`,
      before,
      desiredContent,
      "",
      "",
      { context: 3 }
    )
  };
};

type RulePart = { name: string; content: string };

const buildRulePart = (rulePath: string, context: SourceContext, rulesetDir: string): RulePart => {
  const body = normalizeTrailingWhitespace(fs.readFileSync(rulePath, "utf8"));
  const sourcePath = formatRuleSourcePath(rulePath, context, rulesetDir);
  return {
    name: path.basename(rulePath),
    content: `Source: ${sourcePath}\n\n${body}`
  };
};

// Collects global rule parts across every source, in source order. Sources
// without a `rules/global` directory are skipped.
const collectGlobalParts = (sourceContexts: SourceContext[], rulesetDir: string): RulePart[] => {
  const parts: RulePart[] = [];
  for (const context of sourceContexts) {
    const globalRoot = path.join(context.rulesRoot, "global");
    if (!isExistingDirectory(globalRoot)) {
      continue;
    }
    for (const rulePath of collectMarkdownFiles(globalRoot)) {
      parts.push(buildRulePart(rulePath, context, rulesetDir));
    }
  }
  return parts;
};

// Collects repository (domain) rule parts. Domains are chosen by the profile
// manifest of each source. Overlays are preserved: the same domain in multiple
// sources contributes each source's content in source order (no de-duplication).
const collectRepositoryParts = (
  sourceContexts: SourceContext[],
  profile: string,
  rulesetDir: string
): RulePart[] => {
  const sourceRoots = sourceContexts.map((context) => context.sourceRoot);
  const selections = resolveProfileSelections(sourceRoots, profile);

  if (selections.length === 0) {
    throw new Error(
      `Profile "${profile}" is not defined by any source ` +
        `(checked: ${sourceContexts.map((context) => context.source).join(", ")}). ` +
        `Define it under "profiles" in an agent-profiles.json at a source root.`
    );
  }

  const parts: RulePart[] = [];
  for (const selection of selections) {
    const context = sourceContexts[selection.index];
    const domainsRoot = path.join(context.rulesRoot, "domains");
    for (const domain of selection.domains) {
      const domainRoot = path.resolve(domainsRoot, domain);
      if (!isSubPath(domainsRoot, domainRoot)) {
        throw new Error(
          `Domain "${domain}" for profile "${profile}" resolves outside rules/domains in ` +
            `source ${context.source}. Use a safe domain directory name.`
        );
      }
      // Refuse symlinked/junction domain directories: a malicious source could
      // point rules/domains/<domain> at any location on disk and bypass the
      // declared rules boundary even though the path resolves under it.
      let domainLstat: fs.Stats | null = null;
      try {
        domainLstat = fs.lstatSync(domainRoot);
      } catch {
        domainLstat = null;
      }
      if (domainLstat?.isSymbolicLink()) {
        throw new Error(
          `Domain directory "${domain}" for profile "${profile}" is a symbolic link: ` +
            `${normalizePath(domainRoot)}. ` +
            `Use a real directory under rules/domains/${domain} in source ${context.source}.`
        );
      }
      if (!isExistingDirectory(domainRoot)) {
        throw new Error(
          `Domain directory "${domain}" for profile "${profile}" not found: ` +
            `${normalizePath(domainRoot)}. ` +
            `Ensure rules/domains/${domain} exists in source ${context.source}.`
        );
      }
      for (const rulePath of collectMarkdownFiles(domainRoot)) {
        parts.push(buildRulePart(rulePath, context, rulesetDir));
      }
    }
  }

  return parts;
};

const composeRuleset = (
  rulesetPath: string,
  rootDir: string,
  options: ComposeOptions
): ComposeResult => {
  const rulesetDir = path.dirname(rulesetPath);
  const projectRuleset = readProjectRuleset(rulesetPath);
  const { primaryOutputPath, companionOutputPath, globalOutputPaths } = resolveOutputPaths(
    rulesetDir,
    projectRuleset
  );
  const composedOutputPath = toDisplayPath(rootDir, primaryOutputPath);

  const sourceContexts = resolveSourceContexts(
    rulesetDir,
    projectRuleset.sources,
    options.refresh ?? false
  );

  const globalParts =
    projectRuleset.global !== false ? collectGlobalParts(sourceContexts, rulesetDir) : [];
  const repositoryParts = collectRepositoryParts(
    sourceContexts,
    projectRuleset.profile,
    rulesetDir
  );

  const totalBudget = projectRuleset.budget?.totalTokens ?? DEFAULT_TOTAL_BUDGET;
  const moduleBudget = projectRuleset.budget?.moduleTokens ?? DEFAULT_MODULE_BUDGET;

  const repositoryContentParts = repositoryParts.map((part) => part.content);
  const globalContentParts = globalParts.map((part) => part.content);
  const primaryOutputContent = buildInstructionContent(repositoryContentParts, true);
  const globalOutputContent = buildInstructionContent(globalContentParts, false);
  const moduleTokenCounts = globalParts.map((part) => ({
    name: part.name,
    tokens: countBudgetTokens(part.content)
  }));
  const totalTokens = countBudgetTokens(globalOutputContent);
  const overBudgetModules = moduleTokenCounts.filter((module) => module.tokens > moduleBudget);
  const budgetResult: BudgetCheckResult = {
    tokenizer: BUDGET_TOKENIZER,
    totalTokens,
    totalBudget,
    moduleBudget,
    overBudgetModules,
    totalExceeded: totalTokens > totalBudget,
    moduleReviewTriggered: overBudgetModules.length > 0
  };
  const repositoryOutputs: string[] = [toDisplayPath(rootDir, primaryOutputPath)];
  const globalOutputs = globalOutputPaths.map((filePath) => toDisplayPath(rootDir, filePath));
  const repositoryFiles: RepositoryComposedFile[] = [
    {
      absolutePath: primaryOutputPath,
      displayPath: toDisplayPath(rootDir, primaryOutputPath),
      content: primaryOutputContent
    }
  ];
  const composedFiles: Array<{
    absolutePath: string;
    relativePath: string;
    content: string;
    scope: OutputScope;
  }> = [
    {
      absolutePath: primaryOutputPath,
      relativePath: toDisplayPath(rootDir, primaryOutputPath),
      content: primaryOutputContent,
      scope: "repository"
    }
  ];

  if (companionOutputPath) {
    const companionDisplayPath = toDisplayPath(rootDir, companionOutputPath);
    const companionContent = buildClaudeCompanionContent(primaryOutputPath, companionOutputPath);
    repositoryOutputs.push(companionDisplayPath);
    repositoryFiles.push({
      absolutePath: companionOutputPath,
      displayPath: companionDisplayPath,
      content: companionContent
    });
    composedFiles.push({
      absolutePath: companionOutputPath,
      relativePath: companionDisplayPath,
      content: companionContent,
      scope: "repository"
    });
  }

  for (const globalOutputPath of globalOutputPaths) {
    composedFiles.push({
      absolutePath: globalOutputPath,
      relativePath: toDisplayPath(rootDir, globalOutputPath),
      content: globalOutputContent,
      scope: "global"
    });
  }

  const outputDiffs: OutputGroupDiff[] = [];
  if (options.emitDiffs) {
    const repositoryDiff = buildScopeDiff(
      "repository",
      [primaryOutputPath],
      primaryOutputContent,
      rootDir
    );
    if (repositoryDiff) {
      repositoryDiff.targets = repositoryOutputs;
      outputDiffs.push(repositoryDiff);
    }

    if (options.emitGlobalDiffs !== false) {
      const globalDiff = buildScopeDiff("global", globalOutputPaths, globalOutputContent, rootDir);
      if (globalDiff) {
        outputDiffs.push(globalDiff);
      }
    }
  }

  if (!options.dryRun) {
    for (const file of composedFiles) {
      fs.mkdirSync(path.dirname(file.absolutePath), { recursive: true });
      fs.writeFileSync(file.absolutePath, file.content, "utf8");
    }
  }

  return {
    output: composedOutputPath,
    outputs: [...repositoryOutputs, ...globalOutputs],
    repositoryOutputs,
    globalOutputs,
    repositoryFiles,
    outputDiffs,
    budgetResult
  };
};

const writeOutputDiff = (diff: OutputGroupDiff): void => {
  const scopeLabel = diff.scope === "global" ? "Global outputs" : "Repository outputs";
  if (diff.status === "unchanged") {
    process.stdout.write(`${scopeLabel} unchanged.\n`);
    return;
  }

  process.stdout.write(
    `${scopeLabel} updated. ACTION (agent): refresh rule recognition from the diff below.\n`
  );
  process.stdout.write(`Targets:\n${diff.targets.map((target) => `- ${target}`).join("\n")}\n`);
  process.stdout.write(`--- BEGIN ${diff.scope.toUpperCase()} DIFF ---\n`);
  if (diff.patch) {
    process.stdout.write(diff.patch);
    if (!diff.patch.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  process.stdout.write(`--- END ${diff.scope.toUpperCase()} DIFF ---\n`);
};

const printOutputDiffs = (result: ComposeResult): void => {
  for (const diff of result.outputDiffs) {
    writeOutputDiff(diff);
  }
};

const formatComposedOutputs = (result: ComposeResult): string => {
  const lines = ["Composed instruction files:"];
  if (result.repositoryOutputs.length > 0) {
    lines.push("Repository:");
    lines.push(...result.repositoryOutputs.map((filePath) => `- ${filePath}`));
  }
  if (result.globalOutputs.length > 0) {
    lines.push("Global:");
    lines.push(...result.globalOutputs.map((filePath) => `- ${filePath}`));
  }

  return `${lines.join("\n")}\n`;
};

const formatBudgetReport = (result: BudgetCheckResult): string => {
  const lines: string[] = [];
  if (result.totalExceeded) {
    lines.push(
      `⚠ Global rules budget exceeded (${result.tokenizer}): ` +
        `${result.totalTokens}/${result.totalBudget} tokens`
    );
  }
  if (result.moduleReviewTriggered) {
    lines.push(
      `ℹ Modules over per-module review threshold (> ${result.moduleBudget} tokens, advisory):`
    );
    for (const mod of result.overBudgetModules) {
      lines.push(`    ${mod.name}: ${mod.tokens} tokens`);
    }
    lines.push(
      "  Review whether listed modules contain procedural content that should move to skills."
    );
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
};

const emitBudgetReport = (args: CliArgs, budgetResult: BudgetCheckResult): void => {
  if (args.quiet) {
    return;
  }
  if (budgetResult.totalExceeded || budgetResult.moduleReviewTriggered) {
    process.stderr.write(formatBudgetReport(budgetResult));
  }
};

type InitPlanItem = {
  action: "create" | "overwrite";
  path: string;
};

const buildInitRuleset = (args: CliArgs): ProjectRuleset => {
  const ruleset: ProjectRuleset = {
    sources: [...DEFAULT_INIT_SOURCES],
    profile: args.profile ?? DEFAULT_INIT_PROFILE,
    output: args.output ?? DEFAULT_OUTPUT,
    claude: {
      enabled: true,
      output: DEFAULT_CLAUDE_OUTPUT
    }
  };

  if (args.global === false) {
    ruleset.global = false;
  }

  return ruleset;
};

const formatInitRuleset = (ruleset: ProjectRuleset): string => {
  const sourcesValue = JSON.stringify(ruleset.sources);
  const claudeEnabled = ruleset.claude?.enabled ?? true;
  const claudeOutput = ruleset.claude?.output ?? DEFAULT_CLAUDE_OUTPUT;
  const lines = [
    "{",
    "  // Rules sources. Each entry is github:owner/repo@ref or a local path.",
    `  "sources": ${sourcesValue},`,
    "  // Profile name defined by a source's agent-profiles.json.",
    `  "profile": "${ruleset.profile}",`
  ];

  if (ruleset.global === false) {
    lines.push("  // Write shared global rules to user-level instruction files.");
    lines.push('  "global": false,');
  }

  lines.push("  // Claude Code companion output settings.");
  lines.push('  "claude": {');
  lines.push(`    "enabled": ${claudeEnabled ? "true" : "false"},`);
  lines.push(`    "output": "${claudeOutput}"`);
  lines.push("  },");
  lines.push("  // Output file name.");
  lines.push(`  "output": "${ruleset.output ?? DEFAULT_OUTPUT}"`);
  lines.push("}");

  return `${lines.join("\n")}\n`;
};

const formatPlan = (items: InitPlanItem[], rootDir: string): string => {
  const lines = items.map((item) => {
    const verb = item.action === "overwrite" ? "Overwrite" : "Create";
    const relative = toDisplayPath(rootDir, item.path);
    return `- ${verb}: ${relative}`;
  });

  return `Init plan:\n${lines.join("\n")}\n`;
};

const confirmInit = async (args: CliArgs): Promise<void> => {
  if (args.dryRun || args.yes) {
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error("Confirmation required. Re-run with --yes to continue.");
  }

  const answer = await askQuestion("Proceed with init? [y/N] ");
  if (!/^y(es)?$/iu.test(answer.trim())) {
    throw new Error("Init aborted.");
  }
};

const initProject = async (args: CliArgs, rootDir: string, rulesetName: string): Promise<void> => {
  const rulesetPath = args.ruleset
    ? resolveFrom(rootDir, args.ruleset)
    : path.join(rootDir, rulesetName);
  const rulesetDir = path.dirname(rulesetPath);
  const ruleset = buildInitRuleset(args);
  const outputPaths = resolveOutputPaths(rulesetDir, ruleset);

  const plan: InitPlanItem[] = [];

  if (fs.existsSync(rulesetPath)) {
    if (!args.force) {
      throw new Error(`Ruleset already exists: ${normalizePath(rulesetPath)}`);
    }
    plan.push({ action: "overwrite", path: rulesetPath });
  } else {
    plan.push({ action: "create", path: rulesetPath });
  }

  if (args.compose) {
    const composedTargets = [
      { path: outputPaths.primaryOutputPath, requireForce: true },
      ...outputPaths.globalOutputPaths.map((outputPath) => ({
        path: outputPath,
        requireForce: false
      }))
    ];
    if (outputPaths.companionOutputPath) {
      composedTargets.push({ path: outputPaths.companionOutputPath, requireForce: true });
    }

    for (const composedTarget of composedTargets) {
      if (fs.existsSync(composedTarget.path)) {
        if (composedTarget.requireForce && !args.force) {
          throw new Error(
            `Output already exists: ${normalizePath(composedTarget.path)} (use --force to overwrite)`
          );
        }
        plan.push({ action: "overwrite", path: composedTarget.path });
      } else {
        plan.push({ action: "create", path: composedTarget.path });
      }
    }
  }

  if (!args.quiet && !args.json) {
    process.stdout.write(formatPlan(plan, rootDir));
  }

  if (args.dryRun) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            dryRun: true,
            plan: plan.map((item) => ({
              action: item.action,
              path: toDisplayPath(rootDir, item.path)
            }))
          },
          null,
          2
        ) + "\n"
      );
    } else if (!args.quiet) {
      process.stdout.write("Dry run: no changes made.\n");
    }
    return;
  }

  await confirmInit(args);

  fs.mkdirSync(path.dirname(rulesetPath), { recursive: true });
  fs.writeFileSync(`${rulesetPath}`, formatInitRuleset(ruleset), "utf8");

  let composedOutput: ComposeResult | undefined;
  if (args.compose) {
    composedOutput = composeRuleset(rulesetPath, rootDir, {
      refresh: args.refresh ?? false,
      emitDiffs: !args.quiet && !args.json
    });
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          initialized: [toDisplayPath(rootDir, rulesetPath)],
          composed: composedOutput ? composedOutput.outputs : [],
          repositoryOutputs: composedOutput ? composedOutput.repositoryOutputs : [],
          globalOutputs: composedOutput ? composedOutput.globalOutputs : [],
          dryRun: false,
          ...(composedOutput ? { budget: composedOutput.budgetResult } : {})
        },
        null,
        2
      ) + "\n"
    );
  } else if (!args.quiet) {
    process.stdout.write(`Initialized ruleset:\n- ${toDisplayPath(rootDir, rulesetPath)}\n`);
    if (composedOutput) {
      process.stdout.write(formatComposedOutputs(composedOutput));
      printOutputDiffs(composedOutput);
      emitBudgetReport(args, composedOutput.budgetResult);
    }
  }
};

const getRulesetFiles = (
  rootDir: string,
  specificRuleset: string | undefined,
  rulesetName: string
): string[] => {
  if (specificRuleset) {
    const resolved = resolveFrom(rootDir, specificRuleset);
    ensureFileExists(resolved);
    return [resolved];
  }

  const defaultRuleset = path.join(rootDir, rulesetName);
  if (!fs.existsSync(defaultRuleset)) {
    return [];
  }
  return [defaultRuleset];
};

const ensureSingleRuleset = (
  rulesetFiles: string[],
  rootDir: string,
  rulesetName: string
): string => {
  if (rulesetFiles.length === 0) {
    const expectedPath = normalizePath(path.join(rootDir, rulesetName));
    throw new Error(`Missing ruleset file: ${expectedPath}`);
  }

  return rulesetFiles[0];
};

// Verifies that the generated repository outputs (AGENTS.md and, when enabled,
// the Claude companion) match what compose would produce. Never writes files
// and never inspects the user-global outputs. Exits non-zero when stale.
const runCheck = (rulesetPath: string, rootDir: string, args: CliArgs): void => {
  const result = composeRuleset(rulesetPath, rootDir, {
    refresh: args.refresh ?? false,
    dryRun: true,
    emitDiffs: true,
    emitGlobalDiffs: false
  });

  const staleFiles = result.repositoryFiles.filter((file) => {
    const current = fs.existsSync(file.absolutePath)
      ? fs.readFileSync(file.absolutePath, "utf8")
      : null;
    return current !== file.content;
  });

  const upToDate = staleFiles.length === 0;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          check: true,
          upToDate,
          repositoryOutputs: result.repositoryOutputs,
          stale: staleFiles.map((file) => file.displayPath)
        },
        null,
        2
      ) + "\n"
    );
  } else if (!args.quiet) {
    if (upToDate) {
      process.stdout.write(
        `Repository outputs are up to date:\n${result.repositoryOutputs
          .map((filePath) => `- ${filePath}`)
          .join("\n")}\n`
      );
    } else {
      process.stdout.write(
        `Stale repository outputs (run compose-agentsmd to regenerate):\n${staleFiles
          .map((file) => `- ${file.displayPath}`)
          .join("\n")}\n`
      );
      for (const diff of result.outputDiffs) {
        if (diff.scope === "repository" && diff.status === "updated") {
          writeOutputDiff(diff);
        }
      }
    }
  }

  if (!upToDate) {
    process.exitCode = 1;
  }
};

const printEditRulesGuidance = (rulesetDir: string, ruleset: ProjectRuleset): void => {
  const lines: string[] = [];
  for (const source of ruleset.sources) {
    let workspaceRoot = resolveWorkspaceRoot(rulesetDir, source);
    if (source.startsWith("github:")) {
      workspaceRoot = ensureWorkspaceForGithubSource(source);
    }

    const rulesDirectory = source.startsWith("github:")
      ? path.join(workspaceRoot, "rules")
      : resolveLocalRulesRoot(rulesetDir, source);

    lines.push(`Rules workspace: ${workspaceRoot}`);
    lines.push(`Rules directory: ${rulesDirectory}`);
  }

  lines.push("Next steps:");
  lines.push("- Edit rule files under the listed rules directories.");
  lines.push("- If a source is GitHub, commit and push the workspace changes before apply-rules.");
  lines.push(
    "- Run compose-agentsmd apply-rules from your project root to apply updates and regenerate instruction files."
  );

  process.stdout.write(lines.join("\n") + "\n");
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }

  if (args.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  if (args.clearCache) {
    clearCache();
    process.stdout.write("Cache cleared.\n");
    return;
  }

  const rootDir = args.root ? path.resolve(args.root) : process.cwd();
  const rulesetName = args.rulesetName || DEFAULT_RULESET_NAME;
  const rulesetFiles = getRulesetFiles(rootDir, args.ruleset, rulesetName);
  const command = args.command ?? "compose";
  const logVerbose = (message: string): void => {
    if (args.verbose) {
      process.stdout.write(`${message}\n`);
    }
  };

  logVerbose("Verbose:");
  logVerbose(`- Root: ${rootDir}`);
  logVerbose(`- Ruleset name: ${rulesetName}`);
  logVerbose(
    `- Ruleset files:\n${rulesetFiles.map((file) => `  - ${normalizePath(path.relative(rootDir, file))}`).join("\n")}`
  );

  if (command === "edit-rules") {
    const rulesetPath = ensureSingleRuleset(rulesetFiles, rootDir, rulesetName);
    const rulesetDir = path.dirname(rulesetPath);
    const ruleset = readProjectRuleset(rulesetPath);
    printEditRulesGuidance(rulesetDir, ruleset);
    return;
  }

  if (command === "init") {
    await initProject(args, rootDir, rulesetName);
    return;
  }

  if (command === "check") {
    const rulesetPath = ensureSingleRuleset(rulesetFiles, rootDir, rulesetName);
    runCheck(rulesetPath, rootDir, args);
    return;
  }

  if (command === "apply-rules") {
    const rulesetPath = ensureSingleRuleset(rulesetFiles, rootDir, rulesetName);
    const ruleset = readProjectRuleset(rulesetPath);

    for (const source of ruleset.sources) {
      applyRulesFromWorkspace(source);
    }

    const output = composeRuleset(rulesetPath, rootDir, {
      refresh: true,
      dryRun: args.dryRun,
      emitDiffs: !args.quiet && !args.json
    });
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            composed: output.outputs,
            repositoryOutputs: output.repositoryOutputs,
            globalOutputs: output.globalOutputs,
            dryRun: !!args.dryRun,
            budget: output.budgetResult
          },
          null,
          2
        ) + "\n"
      );
    } else if (!args.quiet) {
      process.stdout.write(formatComposedOutputs(output));
      printOutputDiffs(output);
      emitBudgetReport(args, output.budgetResult);
    }
    return;
  }

  if (rulesetFiles.length === 0) {
    const expectedPath = normalizePath(path.join(rootDir, rulesetName));
    throw new Error(`Missing ruleset file: ${expectedPath}`);
  }

  const outputs = rulesetFiles.sort().map((rulesetPath) =>
    composeRuleset(rulesetPath, rootDir, {
      refresh: args.refresh,
      dryRun: args.dryRun,
      emitDiffs: !args.quiet && !args.json
    })
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          composed: outputs.flatMap((result) => result.outputs),
          repositoryOutputs: outputs.flatMap((result) => result.repositoryOutputs),
          globalOutputs: outputs.flatMap((result) => result.globalOutputs),
          dryRun: !!args.dryRun,
          budget: outputs[0].budgetResult
        },
        null,
        2
      ) + "\n"
    );
  } else if (!args.quiet) {
    process.stdout.write(
      formatComposedOutputs({
        output: outputs[0].output,
        outputs: outputs.flatMap((result) => result.outputs),
        repositoryOutputs: outputs.flatMap((result) => result.repositoryOutputs),
        globalOutputs: outputs.flatMap((result) => result.globalOutputs),
        repositoryFiles: outputs.flatMap((result) => result.repositoryFiles),
        outputDiffs: [],
        budgetResult: outputs[0].budgetResult
      })
    );
    for (const result of outputs) {
      printOutputDiffs(result);
    }
    for (const result of outputs) {
      emitBudgetReport(args, result.budgetResult);
    }
  }
};

const run = async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
};

void run();
