import { z } from "zod";

/**
 * Repository-to-project mapping (M14-01): pure resolution, no I/O.
 *
 * A mapping ties one selector of one repository to one commercial project. An item of
 * delivery activity (an issue, a pull request) is resolved by walking the levels below,
 * most specific first; the first level with a match decides:
 *
 *   1. PATH_PREFIX — a changed file under the prefix (pull requests). The longest
 *      matching prefix of each file wins; files under no prefix are ignored here.
 *   2. BRANCH      — the head branch, exactly (pull requests).
 *   3. LABEL       — one of the item's labels, case-insensitively.
 *   4. MILESTONE   — the item's milestone title, exactly.
 *   5. REPOSITORY  — the whole repository.
 *
 * At the deciding level, one project means **resolved**; several projects mean
 * **ambiguous**: the item goes to the review queue, never to a guess. No match at any
 * level means **unmapped**, reviewed too. Repository names compare case-insensitively,
 * like the providers treat them.
 */

export const MAPPING_SELECTORS = ["PATH_PREFIX", "BRANCH", "LABEL", "MILESTONE", "REPOSITORY"] as const;
export type MappingSelector = (typeof MAPPING_SELECTORS)[number];

export const MAPPING_SELECTOR_LABELS: Record<MappingSelector, string> = {
  PATH_PREFIX: "Dossier",
  BRANCH: "Branche",
  LABEL: "Étiquette",
  MILESTONE: "Jalon",
  REPOSITORY: "Dépôt entier",
};

export type ProjectMapping = {
  id: string;
  projectId: string;
  /** Normalised: lowercase full name, for example "owner/repo". */
  repository: string;
  selector: MappingSelector;
  /** Normalised selector value; `""` for REPOSITORY. */
  value: string;
};

export type ActivityItem = {
  repository: string;
  labels: readonly string[];
  milestone: string | null;
  /** Head branch, pull requests only. */
  branch: string | null;
  /** Changed file paths, pull requests only. */
  paths: readonly string[];
};

export type MappingMatch = { projectId: string; selector: MappingSelector; value: string };

export type Resolution =
  | { status: "resolved"; projectId: string; match: MappingMatch }
  | { status: "ambiguous"; selector: MappingSelector; candidates: MappingMatch[] }
  | { status: "unmapped" };

export function normalizeRepository(value: string): string {
  return value.trim().toLowerCase();
}

/** `apps/web/` and `/apps/web` both read `apps/web`. */
export function normalizePathPrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The matches of one level, deduplicated, in a stable order. */
function matchesAt(selector: MappingSelector, mappings: readonly ProjectMapping[], item: ActivityItem): MappingMatch[] {
  const ofLevel = mappings.filter((mapping) => mapping.selector === selector);
  const toMatch = (mapping: ProjectMapping): MappingMatch => ({ projectId: mapping.projectId, selector, value: mapping.value });

  switch (selector) {
    case "PATH_PREFIX":
      // Each file keeps only its longest prefix: a deeper folder overrides its parent.
      return item.paths.flatMap((path) => {
        const best = ofLevel
          .filter((mapping) => underPrefix(path, mapping.value))
          .sort((a, b) => b.value.length - a.value.length);
        const longest = best.filter((mapping) => mapping.value.length === best[0]?.value.length);
        return longest.map(toMatch);
      });
    case "BRANCH":
      return item.branch === null ? [] : ofLevel.filter((mapping) => mapping.value === item.branch).map(toMatch);
    case "LABEL": {
      const labels = new Set(item.labels.map((label) => label.toLowerCase()));
      return ofLevel.filter((mapping) => labels.has(mapping.value.toLowerCase())).map(toMatch);
    }
    case "MILESTONE":
      return item.milestone === null ? [] : ofLevel.filter((mapping) => mapping.value === item.milestone).map(toMatch);
    case "REPOSITORY":
      return ofLevel.map(toMatch);
  }
}

export function resolveProject(mappings: readonly ProjectMapping[], item: ActivityItem): Resolution {
  const repository = normalizeRepository(item.repository);
  const ofRepository = mappings.filter((mapping) => mapping.repository === repository);

  for (const selector of MAPPING_SELECTORS) {
    const matches = matchesAt(selector, ofRepository, item);
    if (matches.length === 0) continue;

    const byProject = new Map<string, MappingMatch>();
    for (const match of matches) {
      if (!byProject.has(match.projectId)) byProject.set(match.projectId, match);
    }
    const candidates = [...byProject.values()].sort(
      (a, b) => a.projectId.localeCompare(b.projectId) || a.value.localeCompare(b.value),
    );

    return candidates.length === 1
      ? { status: "resolved", projectId: candidates[0].projectId, match: candidates[0] }
      : { status: "ambiguous", selector, candidates };
  }

  return { status: "unmapped" };
}

/* -------------------------------------------------------------------- Form contract */

export const projectMappingInputSchema = z
  .object({
    projectId: z.string().trim().min(1, "Projet requis."),
    repository: z
      .string()
      .trim()
      .min(3, "Dépôt requis, au format propriétaire/nom.")
      .max(255, "255 caractères au plus.")
      .regex(/^[^\s/]+(\/[^\s/]+)+$/, "Format attendu : propriétaire/nom.")
      .transform(normalizeRepository),
    selector: z.enum(MAPPING_SELECTORS, { message: "Sélecteur inconnu." }),
    value: z.string().trim().max(255, "255 caractères au plus."),
  })
  .transform((input) => ({
    ...input,
    value:
      input.selector === "REPOSITORY" ? "" : input.selector === "PATH_PREFIX" ? normalizePathPrefix(input.value) : input.value,
  }))
  .superRefine((input, ctx) => {
    if (input.selector !== "REPOSITORY" && input.value === "") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Valeur requise pour ce sélecteur." });
    }
  });

export type ProjectMappingFormValues = z.input<typeof projectMappingInputSchema>;
export type ProjectMappingInput = z.output<typeof projectMappingInputSchema>;
