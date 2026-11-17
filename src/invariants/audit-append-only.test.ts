import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/**
 * Invariant — the audit trail is append-only from the application's point of view.
 *
 * Only the audit repository may insert a row, and only the operator retention job may
 * delete one. Every other writer (Server Action, job) imports the one helper, so a
 * review can find every write in one place and the browser has no SQL surface at all.
 */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (entry === "generated" || entry === "node_modules") continue;
      if (statSync(path).isDirectory()) walk(path);
      // Test files contain deliberate negative-control strings; the application
      // surface is what this invariant guards.
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        found.push(relative(ROOT, path));
      }
    }
  };
  walk(join(ROOT, "src"));
  return found.sort();
}

const WRITE = /auditEvent\.(create|upsert|update|updateMany|delete|deleteMany)\b/g;

const ALLOWED_WRITES: Record<string, Set<string>> = {
  "src/modules/audit/repository.ts": new Set(["create"]),
  "src/jobs/retention.ts": new Set(["deleteMany"]),
};

function auditWrites(file: string, source: string): string[] {
  const allowed = ALLOWED_WRITES[file] ?? new Set<string>();
  return [...source.matchAll(WRITE)]
    .map((match) => match[1])
    .filter((method) => !allowed.has(method))
    .map((method) => `${file}: auditEvent.${method}`);
}

describe("invariant: append-only audit trail", () => {
  it("lets only the repository insert and only the retention job delete", () => {
    const offenders = sourceFiles().flatMap((file) =>
      auditWrites(file, readFileSync(join(ROOT, file), "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("exposes no write from a client component", () => {
    const clientOffenders = sourceFiles().filter((file) => {
      const source = readFileSync(join(ROOT, file), "utf8");
      if (!/^["']use client["']/.test(source)) return false;
      return /auditEvent|modules\/audit\/repository/.test(source);
    });

    expect(clientOffenders).toEqual([]);
  });

  it("negative control: a direct update from an action is flagged", () => {
    expect(
      auditWrites(
        "src/app/(app)/budget/actions.ts",
        "await getPrisma().auditEvent.update({ where: { id } });",
      ),
    ).toEqual(["src/app/(app)/budget/actions.ts: auditEvent.update"]);
    expect(
      auditWrites(
        "src/modules/audit/repository.ts",
        "await getPrisma().auditEvent.create({ data: {} });",
      ),
    ).toEqual([]);
  });
});
