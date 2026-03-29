import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { prepareGitFallbackDestination } from "../src/git-fallback.ts";

it("prepareGitFallbackDestination removes a partially cloned repo before fallback fetch", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-agentsmd-fallback-"));

  try {
    const destination = path.join(tempRoot, "cache");
    fs.mkdirSync(path.join(destination, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(destination, ".git", "config"),
      '[remote "origin"]\n\turl = https://example.com/repo.git\n',
      "utf8"
    );
    fs.writeFileSync(path.join(destination, "leftover.txt"), "partial clone", "utf8");

    prepareGitFallbackDestination(destination);

    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.readdirSync(destination)).toEqual([]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
