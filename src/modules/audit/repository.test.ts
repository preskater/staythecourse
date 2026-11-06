import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The audit write is scoped to its workspace and only stores redacted metadata.
 * The database is mocked: what matters is the data handed to it, not Prisma itself.
 */
const createMock = vi.fn();
const findManyMock = vi.fn();
const prisma = {
  auditEvent: {
    create: (...args: unknown[]) => createMock(...args),
    findMany: (...args: unknown[]) => findManyMock(...args),
  },
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const {
  AUDIT_EVENT_PAGE_SIZE,
  listAuditEvents,
  recordAuditEvent,
  recordAuditEventSafely,
} = await import("./repository");

describe("recordAuditEvent", () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue({ id: "audit-1" });
  });

  it("writes one owner-scoped entry with redacted metadata", async () => {
    await recordAuditEvent({
      workspaceId: "ws-1",
      actorId: "owner-1",
      action: "export.transactions",
      entityType: "EXPORT",
      outcome: "SUCCESS",
      metadata: { entity: "transactions", rows: 12, label: "Loyer" },
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const [call] = createMock.mock.calls[0] as [{ data: Record<string, unknown> }];

    expect(call.data).toMatchObject({
      workspaceId: "ws-1",
      actorId: "owner-1",
      action: "export.transactions",
      entityType: "EXPORT",
      entityId: null,
      outcome: "SUCCESS",
    });
    // The label is dropped, the count stays: the trail never becomes a second ledger.
    expect(call.data.metadata).toEqual({ entity: "transactions", rows: 12 });
  });

  it("keeps an entry without an actor, for a job or a scheduler", async () => {
    await recordAuditEvent({
      workspaceId: "ws-1",
      actorId: null,
      action: "export.alerts",
      entityType: "EXPORT",
      entityId: "alerts",
      outcome: "REFUSED",
    });

    const [call] = createMock.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(call.data).toMatchObject({ actorId: null, entityId: "alerts", outcome: "REFUSED" });
    expect(call.data.metadata).toEqual({});
  });

  it("lets a write failure reach the caller, which decides whether to proceed", async () => {
    createMock.mockRejectedValue(new Error("audit table unavailable"));

    await expect(
      recordAuditEvent({
        workspaceId: "ws-1",
        actorId: "owner-1",
        action: "export.goals",
        entityType: "EXPORT",
        outcome: "SUCCESS",
      }),
    ).rejects.toThrow("audit table unavailable");
  });

  it("drops an entity reference that is really free text or a credential", async () => {
    for (const entityId of [
      "Loyer septembre, charges comprises",
      "ghp_abcdefghijklmnopqrstuvwxyz",
    ]) {
      createMock.mockClear();
      await recordAuditEvent({
        workspaceId: "ws-1",
        actorId: "owner-1",
        action: "transaction.update",
        entityType: "TRANSACTION",
        entityId,
        outcome: "SUCCESS",
      });

      const [call] = createMock.mock.calls[0] as [{ data: Record<string, unknown> }];
      expect(call.data.entityId).toBeNull();
    }
  });
});

describe("recordAuditEventSafely", () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue({ id: "audit-1" });
  });

  it("swallows a write failure after the change is committed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createMock.mockRejectedValue(new Error("password=hunter2 token=ghp_x"));

    await expect(
      recordAuditEventSafely({
        workspaceId: "ws-1",
        actorId: "owner-1",
        action: "transaction.create",
        entityType: "TRANSACTION",
        entityId: "tx-1",
        outcome: "SUCCESS",
      }),
    ).resolves.toBeUndefined();

    // The log line keeps the error type only: not the message a driver may have built
    // from the payload.
    expect(errorSpy).toHaveBeenCalledWith("[audit] Error");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("hunter2");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("ghp_x");
    errorSpy.mockRestore();
  });
});

describe("listAuditEvents", () => {
  beforeEach(() => {
    findManyMock.mockReset().mockResolvedValue([
      {
        id: "audit-1",
        createdAt: new Date(Date.UTC(2026, 9, 5, 12, 0, 0)),
        action: "transaction.create",
        entityType: "TRANSACTION",
        entityId: "tx-1",
        outcome: "SUCCESS",
        actorId: "owner-1",
        metadata: { type: "EXPENSE", currency: "EUR" },
      },
    ]);
  });

  it("reads one workspace only, most recent first", async () => {
    const rows = await listAuditEvents("ws-1", { action: "transaction.create" });

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1", action: "transaction.create" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: AUDIT_EVENT_PAGE_SIZE,
      }),
    );
    expect(rows[0]).toMatchObject({ action: "transaction.create", metadata: { currency: "EUR" } });
  });

  it("caps the page and never asks for an unbounded read", async () => {
    await listAuditEvents("ws-1", { take: 10_000 });

    const [call] = findManyMock.mock.calls[0] as [{ take: number; where: unknown }];
    expect(call.take).toBe(AUDIT_EVENT_PAGE_SIZE);
    expect(call.where).toEqual({ workspaceId: "ws-1" });
  });
});
