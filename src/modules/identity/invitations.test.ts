import { describe, expect, it } from "vitest";
import {
  INVITATION_TTL_DAYS,
  acceptInvitationSchema,
  createInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  invitationStatus,
  inviteMemberSchema,
} from "./invitations";

const NOW = new Date("2026-11-13T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("invitation tokens", () => {
  it("creates a 256-bit base64url token and stores only its digest", () => {
    const { token, tokenHash } = createInvitationToken();

    // 32 bytes → 43 base64url characters, no padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashInvitationToken(token));
    // The digest must not reveal the token.
    expect(tokenHash).not.toContain(token);
  });

  it("never repeats a token", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createInvitationToken().token));

    expect(tokens.size).toBe(50);
  });
});

describe("invitationStatus", () => {
  const base = {
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  };

  it("reads a live invitation as pending", () => {
    expect(invitationStatus(base, NOW)).toBe("PENDING");
  });

  it("refuses an expired invitation at the expiry instant", () => {
    expect(invitationStatus({ ...base, expiresAt: NOW }, NOW)).toBe("EXPIRED");
  });

  it("reads a revoked invitation as revoked, and acceptance wins over a later stamp", () => {
    expect(invitationStatus({ ...base, revokedAt: NOW }, NOW)).toBe("REVOKED");
    expect(invitationStatus({ ...base, revokedAt: NOW, acceptedAt: NOW }, NOW)).toBe("ACCEPTED");
  });
});

describe("invitationExpiry", () => {
  it("expires after the documented window", () => {
    expect(invitationExpiry(NOW).getTime()).toBe(NOW.getTime() + INVITATION_TTL_DAYS * DAY_MS);
  });
});

describe("inviteMemberSchema", () => {
  it("accepts the three invitable roles", () => {
    for (const role of ["ADMIN", "MEMBER", "VIEWER"] as const) {
      expect(inviteMemberSchema.safeParse({ email: "person@example.test", role }).success).toBe(
        true,
      );
    }
  });

  it("never accepts OWNER or a malformed address", () => {
    expect(
      inviteMemberSchema.safeParse({ email: "person@example.test", role: "OWNER" }).success,
    ).toBe(false);
    expect(inviteMemberSchema.safeParse({ email: "not-an-address", role: "MEMBER" }).success).toBe(
      false,
    );
  });
});

describe("acceptInvitationSchema", () => {
  const token = "A".repeat(43);

  it("requires a well-formed token and the password rules", () => {
    expect(acceptInvitationSchema.safeParse({ token, password: "Fictitious-Password-2026" }).success).toBe(
      true,
    );
    expect(acceptInvitationSchema.safeParse({ token: "short", password: "Fictitious-Password-2026" }).success).toBe(
      false,
    );
    expect(acceptInvitationSchema.safeParse({ token, password: "too-short" }).success).toBe(false);
  });

  it("keeps the name optional and trims it", () => {
    const parsed = acceptInvitationSchema.safeParse({
      token,
      password: "Fictitious-Password-2026",
      name: "  Camille  ",
    });

    expect(parsed.success && parsed.data.name).toBe("Camille");
  });
});
