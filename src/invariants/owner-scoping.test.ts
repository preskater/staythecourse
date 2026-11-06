import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";

/**
 * Invariant 1 — owner scoping.
 *
 * Every repository function that reaches the database must open with a query scoped to
 * the owner: `workspaceId` (M7-04) or `userId` in its `where` (or in the `data` it
 * creates), directly or through a relation (`account: { userId }`). An identifier sent by a browser is then simply
 * not found for anyone else. Writes keyed by a row id are fine *after* such a check,
 * which is why only the first wave of queries is examined: the fake client records the
 * queries a function issues, then stops it.
 */

const OWNER = "owner-invariant";

type RecordedQuery = { model: string; method: string; args: unknown };
const recorded: RecordedQuery[] = [];

class StopAfterQuery extends Error {}

function fakeModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => (args: unknown) => {
        recorded.push({ model, method, args });
        return Promise.reject(new StopAfterQuery());
      },
    },
  );
}

const fakeClient: unknown = new Proxy(
  {},
  {
    get: (_target, key: string) => {
      if (key === "$transaction") {
        return (work: unknown) =>
          typeof work === "function" ? work(fakeClient) : Promise.all(work as unknown[]);
      }
      if (key.startsWith("$")) return () => Promise.reject(new StopAfterQuery());
      return fakeModel(key);
    },
  },
);

vi.mock("@/lib/db", () => ({ getPrisma: () => fakeClient }));
// A fictitious key, only so `upsertConnection` can encrypt its placeholder token.
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  getServerEnv: () => ({ INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }),
}));

/** Keys that scope a row: the owner, or since M7-04 the workspace the guard resolved. */
const SCOPE_KEYS = new Set(["userId", "workspaceId"]);

/** True when `userId: OWNER` or `workspaceId: OWNER` appears anywhere in the value. */
function mentionsOwner(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => (SCOPE_KEYS.has(key) && item === OWNER) || mentionsOwner(item),
  );
}

function isScoped(query: RecordedQuery): boolean {
  const args = (query.args ?? {}) as Record<string, unknown>;
  // On the user table the owner is the row itself.
  if (query.model === "user" && (args.where as { id?: unknown } | undefined)?.id === OWNER) {
    return true;
  }
  return mentionsOwner(args.where) || mentionsOwner(args.data) || mentionsOwner(args.create);
}

/**
 * Functions that legitimately do not open with an owner-scoped query, each with its
 * reason. Anything new must either be scoped or be added here deliberately.
 */
const NOT_OWNER_SCOPED: Record<string, string> = {
  // Identity: these find *who* the owner is, before any owner exists in the request.
  "identity.findOwnerByEmail": "sign-in lookup by email",
  "identity.findOwnerById": "session lookup by the id of a signed token",
  "identity.countOwners": "single-owner bootstrap check",
  "identity.upsertOwner": "seed script, keyed by email",
  "identity.ensureDefaultWorkspace": "workspace id derived from the owner id; membership keyed by userId",
  // Synchronisation writes run after `findConnectionForSync(userId, id)`, keyed by the
  // connection or run that check returned.
  "integrations.saveSnapshots": "keyed by an owner-checked connection",
  "integrations.saveIssues": "keyed by an owner-checked connection",
  "integrations.saveMilestones": "keyed by an owner-checked connection",
  "integrations.markSyncSuccess": "keyed by an owner-checked connection",
  "integrations.markSyncFailure": "keyed by an owner-checked connection",
  "integrations.startSyncRun": "keyed by an owner-checked connection",
  "integrations.finishSyncRun": "keyed by a run started for an owner-checked connection",
  "integrations.listCacheEntries": "keyed by an owner-checked connection (DA-04 cache)",
  "integrations.saveCacheChecks": "keyed by an owner-checked connection (DA-04 cache)",
  "integrations.saveCiRuns": "keyed by an owner-checked connection (DA-03 CI)",
  // Rows already resolved for the owner by the calling action.
  "budget.createImportedTransactions": "rows carry the owner id, validated by the import action",
  "realEstate.createCashflow": "keyed by a property the action found with findProperty(userId, id)",
  "realEstate.createLoan": "keyed by a property the action found with findProperty(userId, id)",
};

/**
 * Arguments for one call: the owner first (as an `input` object for functions taking
 * one), then tolerant placeholders.
 */
function argumentsFor(name: string, fn: (...args: unknown[]) => unknown): unknown[] {
  const date = new Date("2026-01-15T00:00:00.000Z");
  const input = new Proxy(
    { userId: OWNER, workspaceId: OWNER },
    {
      get: (target, key) => {
        if (key in target) return target[key as keyof typeof target];
        if (typeof key !== "string" || key === "then") return undefined;
        return placeholderFor(key, date);
      },
    },
  );
  const special: Record<string, unknown[]> = {
    deleteWorkDay: [OWNER, date],
    dismissAlert: [OWNER, "fixture", date],
    createImportedTransactions: [[{ userId: OWNER }]],
    applyAlertPlan: [
      OWNER,
      { creates: [{ kind: "fixture", fingerprint: "fixture", inputs: {} }], refreshes: [], reopens: [], resolves: [] },
      date,
    ],
    saveAlertRules: [OWNER, [{ kind: "fixture", enabled: true }]],
    listCostEntries: [OWNER, {}],
    createCostEntry: [
      OWNER,
      {
        amount: new Decimal("12.34"),
        currency: "EUR",
        actuality: "observed",
        source: { kind: "manual", enteredBy: "fixture", capturedAt: date },
        periodStart: date,
        periodEnd: date,
        notes: null,
        dimensions: { projectId: "fixture" },
      },
    ],
    updateCostEntry: [
      OWNER,
      "fixture",
      {
        amount: new Decimal("12.34"),
        currency: "EUR",
        actuality: "observed",
        source: { kind: "manual", enteredBy: "fixture", capturedAt: date },
        periodStart: date,
        periodEnd: date,
        notes: null,
        dimensions: { projectId: "fixture" },
      },
    ],
    createCostAllocation: [
      OWNER,
      {
        entryId: "fixture",
        amount: new Decimal("1.00"),
        dimensions: { projectId: "fixture" },
      },
    ],
    updateCostAllocation: [
      OWNER,
      "fixture",
      { amount: new Decimal("1.00"), dimensions: { projectId: "fixture" } },
    ],
  };
  if (special[name]) return special[name];
  return /^async function \w+\(\s*input\b/.test(fn.toString())
    ? [input]
    : [OWNER, "fixture", input, "fixture", date];
}

/** A value of the right shape for a field, guessed from its name. */
function placeholderFor(key: string, date: Date): unknown {
  if (/amount|rate|hours|target|threshold|principal|price|value|cost|balance/i.test(key)) {
    return new Decimal("12.34");
  }
  if (/date|day|at$|on$|asof$|^from$|^to$|^now$|start|end|until/i.test(key)) return date;
  if (/^(is|has)[A-Z]|reconciled|archived|enabled|prune/.test(key)) return false;
  if (/s$/.test(key)) return [];
  if (/currency/i.test(key)) return "EUR";
  if (/count|limit|take|skip|number|^months?$|^year$/i.test(key)) return 1;
  return "fixture";
}

const MODULES = {
  budget: () => import("@/modules/budget/repository"),
  realEstate: () => import("@/modules/real-estate/repository"),
  microBusiness: () => import("@/modules/micro-business/repository"),
  alerts: () => import("@/modules/alerts/repository"),
  identity: () => import("@/modules/identity/repository"),
  integrations: () => import("@/modules/integrations/repository"),
  aiCosts: () => import("@/modules/ai-costs/repository"),
};

async function firstQueriesOf(fn: (...args: unknown[]) => unknown, name: string) {
  recorded.length = 0;
  try {
    await fn(...argumentsFor(name, fn));
  } catch (error) {
    // The stop signal, or a function giving up on a placeholder before any query.
    void error;
  }
  return [...recorded];
}

describe("invariant: owner scoping of repository access", () => {
  for (const [moduleName, load] of Object.entries(MODULES)) {
    it(`${moduleName}: every function opens with an owner-scoped query`, async () => {
      const exported = Object.entries(await load()).filter(
        (entry): entry is [string, (...args: unknown[]) => unknown] => typeof entry[1] === "function",
      );
      expect(exported.length).toBeGreaterThan(0);

      const unscoped: string[] = [];
      const unexercised: string[] = [];

      for (const [name, fn] of exported) {
        const key = `${moduleName}.${name}`;
        if (key in NOT_OWNER_SCOPED) continue;

        const queries = await firstQueriesOf(fn, name);
        if (queries.length === 0) {
          // Pure helpers exported next to the queries (no database access at all).
          if (fn.length === 0 || /getPrisma/.test(fn.toString()) === false) continue;
          unexercised.push(key);
          continue;
        }
        for (const query of queries) {
          if (!isScoped(query)) unscoped.push(`${key} → ${query.model}.${query.method}`);
        }
      }

      expect(unscoped, "queries without the owner").toEqual([]);
      expect(unexercised, "functions the fake client never reached").toEqual([]);
    });
  }

  it("lists only functions that exist (no stale exemption)", async () => {
    const existing = new Set<string>();
    for (const [moduleName, load] of Object.entries(MODULES)) {
      for (const name of Object.keys(await load())) existing.add(`${moduleName}.${name}`);
    }
    expect(Object.keys(NOT_OWNER_SCOPED).filter((key) => !existing.has(key))).toEqual([]);
  });

  it("negative control: a repository function reading by id alone is caught end to end", async () => {
    const { getPrisma } = await import("@/lib/db");
    async function leakyFindTransaction(userId: string, transactionId: string) {
      void userId;
      return getPrisma().transaction.findFirst({ where: { id: transactionId } });
    }

    const queries = await firstQueriesOf(leakyFindTransaction as (...args: unknown[]) => unknown, "leaky");
    expect(queries).toHaveLength(1);
    expect(queries.every(isScoped)).toBe(false);
  });

  it("negative control: a query keyed by id alone is flagged", () => {
    expect(isScoped({ model: "transaction", method: "findFirst", args: { where: { id: "x" } } })).toBe(false);
    expect(
      isScoped({ model: "transaction", method: "findFirst", args: { where: { id: "x", userId: "someone-else" } } }),
    ).toBe(false);
    expect(
      isScoped({ model: "transaction", method: "findFirst", args: { where: { account: { userId: OWNER } } } }),
    ).toBe(true);
  });
});
