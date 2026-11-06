import { describe, expect, it } from "vitest";
import {
  canChangeMemberRole,
  canRemoveMember,
  hasPermission,
  PERMISSIONS,
  type Permission,
} from "./permissions";
import type { WorkspaceRole } from "./workspace";

const ROLES: WorkspaceRole[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

/**
 * The whole preset, stated once. Changing a role means changing this table and the
 * implementation together, which is the point of pinning the matrix in a test.
 */
const EXPECTED: Record<WorkspaceRole, Permission[]> = {
  OWNER: ["read", "write", "export", "manage-modules", "manage-members"],
  ADMIN: ["read", "write", "export", "manage-modules", "manage-members"],
  MEMBER: ["read", "write", "export"],
  VIEWER: ["read"],
};

describe("hasPermission", () => {
  it.each(ROLES.flatMap((role) => PERMISSIONS.map((permission) => [role, permission] as const)))(
    "answers the matrix for %s × %s",
    (role, permission) => {
      expect(hasPermission(role, permission)).toBe(EXPECTED[role].includes(permission));
    },
  );

  it("denies an unknown permission rather than defaulting to allowed", () => {
    expect(hasPermission("OWNER", "delete-everything" as Permission)).toBe(false);
  });

  it("denies an unknown role rather than defaulting to allowed", () => {
    expect(hasPermission("SUPERUSER" as WorkspaceRole, "read")).toBe(false);
  });

  it("gives a viewer read access and nothing that changes the workspace", () => {
    expect(hasPermission("VIEWER", "read")).toBe(true);
    expect(hasPermission("VIEWER", "write")).toBe(false);
    expect(hasPermission("VIEWER", "export")).toBe(false);
    expect(hasPermission("VIEWER", "manage-modules")).toBe(false);
    expect(hasPermission("VIEWER", "manage-members")).toBe(false);
  });
});

describe("canRemoveMember", () => {
  it("never lets an admin remove the owner", () => {
    expect(canRemoveMember("ADMIN", "OWNER")).toBe(false);
  });

  it("never lets anyone remove the owner through member management", () => {
    for (const role of ROLES) {
      expect(canRemoveMember(role, "OWNER")).toBe(false);
    }
  });

  it("lets the owner remove an admin, member or viewer", () => {
    expect(canRemoveMember("OWNER", "ADMIN")).toBe(true);
    expect(canRemoveMember("OWNER", "MEMBER")).toBe(true);
    expect(canRemoveMember("OWNER", "VIEWER")).toBe(true);
  });

  it("lets an admin remove members and viewers, but not another admin", () => {
    expect(canRemoveMember("ADMIN", "MEMBER")).toBe(true);
    expect(canRemoveMember("ADMIN", "VIEWER")).toBe(true);
    expect(canRemoveMember("ADMIN", "ADMIN")).toBe(false);
  });

  it("refuses members and viewers, who hold no member-management permission", () => {
    expect(canRemoveMember("MEMBER", "VIEWER")).toBe(false);
    expect(canRemoveMember("VIEWER", "MEMBER")).toBe(false);
  });
});

describe("canChangeMemberRole", () => {
  it("never lets an admin demote or promote the owner", () => {
    for (const nextRole of ROLES) {
      expect(canChangeMemberRole("ADMIN", "OWNER", nextRole)).toBe(false);
    }
  });

  it("never lets anyone demote the owner, including the owner itself", () => {
    for (const actorRole of ROLES) {
      expect(canChangeMemberRole(actorRole, "OWNER", "MEMBER")).toBe(false);
    }
  });

  it("never grants the owner role through member management", () => {
    for (const actorRole of ROLES) {
      expect(canChangeMemberRole(actorRole, "MEMBER", "OWNER")).toBe(false);
    }
  });

  it("lets the owner move a member to admin, member or viewer", () => {
    expect(canChangeMemberRole("OWNER", "MEMBER", "ADMIN")).toBe(true);
    expect(canChangeMemberRole("OWNER", "ADMIN", "MEMBER")).toBe(true);
    expect(canChangeMemberRole("OWNER", "MEMBER", "VIEWER")).toBe(true);
  });

  it("lets an admin move a member to viewer and back, but not to admin", () => {
    expect(canChangeMemberRole("ADMIN", "MEMBER", "VIEWER")).toBe(true);
    expect(canChangeMemberRole("ADMIN", "VIEWER", "MEMBER")).toBe(true);
    expect(canChangeMemberRole("ADMIN", "MEMBER", "ADMIN")).toBe(false);
  });

  it("refuses an admin acting on another admin", () => {
    expect(canChangeMemberRole("ADMIN", "ADMIN", "MEMBER")).toBe(false);
  });
});
