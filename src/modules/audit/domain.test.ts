import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  isAuditAction,
  isAuditOutcome,
  REDACTED_METADATA_VALUE,
  redactAuditMetadata,
} from "./domain";

/**
 * What these tests pin down: nothing that identifies a row's content reaches the trail.
 * Counts and codes pass, free text and sensitive keys do not.
 */
describe("redactAuditMetadata", () => {
  it("keeps the counts and codes an export entry is made of", () => {
    expect(
      redactAuditMetadata({
        entity: "transactions",
        scope: "range",
        from: "2026-09-01",
        to: "2026-09-30",
        rows: 42,
        truncated: false,
      }),
    ).toEqual({
      entity: "transactions",
      scope: "range",
      from: "2026-09-01",
      to: "2026-09-30",
      rows: 42,
      truncated: false,
    });
  });

  it("drops a sensitive key entirely, rather than storing a placeholder", () => {
    const metadata = redactAuditMetadata({
      token: "ghp_abcdef",
      password: "hunter2",
      email: "owner@example.test",
      label: "Loyer septembre",
      amount: 900,
    });

    expect(metadata).toEqual({});
  });

  it("matches a sensitive key whatever its case and position", () => {
    expect(redactAuditMetadata({ accessToken: "abc", userEmail: "a@b.c" })).toEqual({});
  });

  it("drops a stored credential or a password fingerprint, whatever it is called", () => {
    expect(
      redactAuditMetadata({
        passwordHash: "$2b$12$abcdefghijklmnop",
        credentialsCiphertext: "v1:AAAA",
        apiKey: "sk-live-fictitious",
        privateKey: "-----BEGIN",
        accessKey: "AKIAFICTITIOUS",
        instanceUrl: "https://gitlab.example.test",
        login: "owner",
      }),
    ).toEqual({});
  });

  it("redacts free text, because half a label is still a label", () => {
    expect(redactAuditMetadata({ note: "Remboursement", memo: "Loyer, charges" })).toEqual({
      memo: REDACTED_METADATA_VALUE,
    });
  });

  it("drops a credential that arrived under an innocent key", () => {
    expect(
      redactAuditMetadata({
        id: "ghp_abcdefghijklmnopqrstuvwxyz",
        reference: "glpat-abcdefghijklmnopqrst",
        memo: "-----BEGIN RSA PRIVATE KEY-----",
      }),
    ).toEqual({});
  });

  it("drops values that are not a flat code, count or flag", () => {
    expect(
      redactAuditMetadata({
        rows: 3,
        truncated: true,
        nothing: null,
        nested: { id: "tx-1" },
        list: ["a", "b"],
      }),
    ).toEqual({ rows: 3, truncated: true });
  });

  it("drops a non-finite number and a key that is not a code", () => {
    expect(redactAuditMetadata({ rows: Number.NaN, "not a key": 1, "x": Infinity })).toEqual({});
  });

  it("returns an empty map when there is nothing to store", () => {
    expect(redactAuditMetadata()).toEqual({});
  });
});

describe("AUDIT_ACTIONS", () => {
  it("keeps one stable code per action, exports first", () => {
    expect(AUDIT_ACTIONS).toEqual([
      "export.transactions",
      "export.properties",
      "export.budgets",
      "export.goals",
      "export.alerts",
      "auth.sign_in",
      "auth.sign_in_refused",
      "auth.sign_out",
      "auth.password_change",
      "auth.password_change_refused",
      "auth.session_revoke",
      "transaction.create",
      "transaction.update",
      "transaction.delete",
      "transaction.transfer",
      "transaction.reconcile",
      "transaction.salary_book",
      "revenue.invoice",
      "revenue.credit_note",
      "revenue.payment",
      "revenue.refund",
      "revenue.write_off",
      "rate.write",
      "module.enable",
      "module.disable",
      "integration.connect",
      "integration.sync",
      "backup.run",
      "restore.run",
    ]);
  });

  it("rejects a code that is not in the vocabulary", () => {
    expect(isAuditAction("transaction.create")).toBe(true);
    expect(isAuditAction("transaction.create.again")).toBe(false);
    expect(isAuditAction(null)).toBe(false);
    expect(isAuditOutcome("REFUSED")).toBe(true);
    expect(isAuditOutcome("SKIPPED")).toBe(false);
  });
});
