import fs from "node:fs";
import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";

// A profile manifest lives at the root of a rules source (next to `rules/`)
// as `agent-profiles.json`. It maps profile names to the rule domains that a
// consuming repository selects by naming the profile in its ruleset.
export type ProfileEntry = {
  domains: string[];
};

export type ProfileManifest = {
  profiles: Record<string, ProfileEntry>;
};

export const PROFILE_MANIFEST_NAME = "agent-profiles.json";
const DOMAIN_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

const profileManifestSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Agent rules profile manifest",
  type: "object",
  additionalProperties: false,
  required: ["profiles"],
  properties: {
    profiles: {
      type: "object",
      propertyNames: {
        minLength: 1
      },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["domains"],
        properties: {
          domains: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
              pattern: DOMAIN_NAME_PATTERN
            }
          }
        }
      }
    }
  }
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateProfileManifestSchema = ajv.compile(profileManifestSchema);

const formatManifestErrors = (errors: ErrorObject[] | null | undefined): string => {
  if (!errors || errors.length === 0) {
    return "Unknown profile manifest validation error";
  }

  return errors
    .map((error) => {
      const pathLabel = error.instancePath ? error.instancePath : "(root)";
      return `${pathLabel} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
};

// Reads and validates the profile manifest at a source root. Returns null when
// the source does not define a manifest (a legitimate, skippable state).
export const readProfileManifest = (sourceRoot: string): ProfileManifest | null => {
  const manifestPath = path.join(sourceRoot, PROFILE_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!validateProfileManifestSchema(parsed)) {
    const message = formatManifestErrors(validateProfileManifestSchema.errors);
    throw new Error(`Invalid profile manifest in ${manifestPath}: ${message}`);
  }

  return parsed as ProfileManifest;
};

export type ProfileSelection = {
  // Index into the original ordered `sourceRoots` array.
  index: number;
  domains: string[];
};

// Resolves which sources define the requested profile, preserving source order.
// Sources without a manifest, or whose manifest lacks the profile, are skipped.
export const resolveProfileSelections = (
  sourceRoots: string[],
  profile: string
): ProfileSelection[] => {
  const selections: ProfileSelection[] = [];

  sourceRoots.forEach((sourceRoot, index) => {
    const manifest = readProfileManifest(sourceRoot);
    if (!manifest) {
      return;
    }

    const entry = manifest.profiles[profile];
    if (!entry) {
      return;
    }

    selections.push({ index, domains: entry.domains });
  });

  return selections;
};
