import fs from "node:fs";

export const prepareGitFallbackDestination = (destination: string): void => {
  if (fs.existsSync(destination)) {
    fs.rmSync(destination, { recursive: true, force: true });
  }
  fs.mkdirSync(destination, { recursive: true });
};
