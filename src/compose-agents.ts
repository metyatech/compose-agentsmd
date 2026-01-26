#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";

const DEFAULT_RULESET_NAME = "agent-ruleset.json";
const DEFAULT_RULES_ROOT = "agent-rules/rules";
const DEFAULT_GLOBAL_DIR = "global";
const DEFAULT_DOMAINS_DIR = "domains";
const RULES_ROOT_ENV_VAR = "AGENT_RULES_ROOT";
const DEFAULT_OUTPUT = "AGENTS.md";
const RULESET_SCHEMA_PATH = new URL("../agent-ruleset.schema.json", import.meta.url);
const TOOL_RULES = [
  "# Tool Rules (compose-agentsmd)",
  "- Before starting any work, run `compose-agentsmd` from the project root.",
  "- To update rules, update the source rule modules or ruleset, then rerun `compose-agentsmd`.",
  "- Do not edit `AGENTS.md` directly; update the source rules and regenerate."
].join("\n");

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "agent-rules",
  "agent-rules-private",
  "agent-rules-local",
  "agent-rules-tools",
  "compose-agentsmd",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage"
]);

type CliArgs = {
  help?: boolean;
  root?: string;
  ruleset?: string;
  rulesetName?: string;
  rulesRoot?: string;
};

const usage = `Usage: compose-agentsmd [--root <path>] [--ruleset <path>] [--ruleset-name <name>] [--rules-root <path>]

Options:
  --root <path>         Project root directory (default: current working directory)
  --ruleset <path>      Only compose a single ruleset file
  --ruleset-name <name> Ruleset filename to search for (default: agent-ruleset.json)
  --rules-root <path>   Override rules root directory for all rulesets (or set ${RULES_ROOT_ENV_VAR})
`;

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --root");
      }
      args.root = value;
      i += 1;
      continue;
    }

    if (arg === "--ruleset") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --ruleset");
      }
      args.ruleset = value;
      i += 1;
      continue;
    }

    if (arg === "--ruleset-name") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --ruleset-name");
      }
      args.rulesetName = value;
      i += 1;
      continue;
    }

    if (arg === "--rules-root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --rules-root");
      }
      args.rulesRoot = value;
      i += 1;
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

const rulesetSchema = JSON.parse(fs.readFileSync(RULESET_SCHEMA_PATH, "utf8"));
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

const readJsonFile = (filePath: string): unknown => {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
};

type ProjectRuleset = {
  output?: string;
  domains?: string[];
  rules?: string[];
  rulesRoot?: string;
  globalDir?: string;
  domainsDir?: string;
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

  return ruleset;
};

type RulesRootOptions = {
  cliRulesRoot?: string;
};

const resolveRulesRoot = (
  rulesetDir: string,
  projectRuleset: ProjectRuleset,
  options: RulesRootOptions
): string => {
  if (isNonEmptyString(options.cliRulesRoot)) {
    return resolveFrom(rulesetDir, options.cliRulesRoot);
  }

  const envRulesRoot = process.env[RULES_ROOT_ENV_VAR];
  if (isNonEmptyString(envRulesRoot)) {
    return resolveFrom(rulesetDir, envRulesRoot);
  }

  if (isNonEmptyString(projectRuleset.rulesRoot)) {
    return resolveFrom(rulesetDir, projectRuleset.rulesRoot);
  }

  return path.resolve(rulesetDir, DEFAULT_RULES_ROOT);
};

const resolveGlobalRoot = (rulesRoot: string, projectRuleset: ProjectRuleset): string => {
  const globalDirName = isNonEmptyString(projectRuleset.globalDir)
    ? projectRuleset.globalDir
    : DEFAULT_GLOBAL_DIR;
  return path.resolve(rulesRoot, globalDirName);
};

const resolveDomainsRoot = (rulesRoot: string, projectRuleset: ProjectRuleset): string => {
  const domainsDirName = isNonEmptyString(projectRuleset.domainsDir)
    ? projectRuleset.domainsDir
    : DEFAULT_DOMAINS_DIR;
  return path.resolve(rulesRoot, domainsDirName);
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

const addRulePaths = (rulePaths: string[], resolvedRules: string[], seenRules: Set<string>): void => {
  for (const rulePath of rulePaths) {
    const resolvedRulePath = path.resolve(rulePath);
    if (seenRules.has(resolvedRulePath)) {
      continue;
    }
    ensureFileExists(resolvedRulePath);
    resolvedRules.push(resolvedRulePath);
    seenRules.add(resolvedRulePath);
  }
};

type ComposeOptions = {
  cliRulesRoot?: string;
};

const composeRuleset = (rulesetPath: string, rootDir: string, options: ComposeOptions): string => {
  const rulesetDir = path.dirname(rulesetPath);
  const projectRuleset = readProjectRuleset(rulesetPath);
  const outputFileName = projectRuleset.output ?? DEFAULT_OUTPUT;
  const outputPath = resolveFrom(rulesetDir, outputFileName);

  const rulesRoot = resolveRulesRoot(rulesetDir, projectRuleset, {
    cliRulesRoot: options.cliRulesRoot
  });
  const globalRoot = resolveGlobalRoot(rulesRoot, projectRuleset);
  const domainsRoot = resolveDomainsRoot(rulesRoot, projectRuleset);

  const resolvedRules: string[] = [];
  const seenRules = new Set<string>();

  // Global rules always apply.
  addRulePaths(collectMarkdownFiles(globalRoot), resolvedRules, seenRules);

  const domains = Array.isArray(projectRuleset.domains) ? projectRuleset.domains : [];
  for (const domain of domains) {
    const domainRoot = path.resolve(domainsRoot, domain);
    addRulePaths(collectMarkdownFiles(domainRoot), resolvedRules, seenRules);
  }

  const directRules = Array.isArray(projectRuleset.rules) ? projectRuleset.rules : [];
  const directRulePaths = directRules.map((rulePath) => resolveFrom(rulesetDir, rulePath));
  addRulePaths(directRulePaths, resolvedRules, seenRules);

  const parts = resolvedRules.map((rulePath) =>
    normalizeTrailingWhitespace(fs.readFileSync(rulePath, "utf8"))
  );

  const lintHeader = "<!-- markdownlint-disable MD025 -->";
  const toolRules = normalizeTrailingWhitespace(TOOL_RULES);
  const output = `${lintHeader}\n${[toolRules, ...parts].join("\n\n")}\n`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, "utf8");

  return normalizePath(path.relative(rootDir, outputPath));
};

const findRulesetFiles = (rootDir: string, rulesetName: string): string[] => {
  const results: string[] = [];
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
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) {
          continue;
        }
        pending.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name === rulesetName) {
        results.push(entryPath);
      }
    }
  }

  return results;
};

const getRulesetFiles = (rootDir: string, specificRuleset: string | undefined, rulesetName: string): string[] => {
  if (specificRuleset) {
    const resolved = resolveFrom(rootDir, specificRuleset);
    ensureFileExists(resolved);
    return [resolved];
  }

  return findRulesetFiles(rootDir, rulesetName);
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const rootDir = args.root ? path.resolve(args.root) : process.cwd();
  const rulesetName = args.rulesetName || DEFAULT_RULESET_NAME;
  const rulesetFiles = getRulesetFiles(rootDir, args.ruleset, rulesetName);

  if (rulesetFiles.length === 0) {
    throw new Error(`No ruleset files named ${rulesetName} found under ${rootDir}`);
  }

  const outputs = rulesetFiles
    .sort()
    .map((rulesetPath) => composeRuleset(rulesetPath, rootDir, { cliRulesRoot: args.rulesRoot }));

  process.stdout.write(`Composed AGENTS.md:\n${outputs.map((file) => `- ${file}`).join("\n")}\n`);
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${usage}\n`);
  process.exit(1);
}
