import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/modules/identity/workspace";

/**
 * Server Actions are public endpoints: these tests call them as a forged request would.
 * A member without the right reaches no flow, and the secret never ends up in the
 * redirect URL. The secret is fictitious.
 */

let role: WorkspaceRole = "OWNER";
const redirectMock = vi.fn();
const flows = { connectAiProvider: vi.fn(), revalidateAiConnection: vi.fn(), revokeAiConnection: vi.fn() };

vi.mock("@/lib/auth/guard", () => ({
  requireModule: async () => ({ id: "user-1", workspace: { id: "ws-1", role } }),
}));
vi.mock("@/modules/ai-costs/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/ai-costs/connections")>()),
  ...flows,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectMock(url);
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { connectAiProviderAction, revalidateAiConnectionAction, revokeAiConnectionAction } = await import("./actions");

const SECRET = "sk-ant-admin01-fictitious-secret-value";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  Object.entries(fields).forEach(([key, value]) => data.set(key, value));
  return data;
};

async function redirectedTo(action: (data: FormData) => Promise<void>, data: FormData): Promise<string> {
  await expect(action(data)).rejects.toThrow(/^redirect:/);
  return redirectMock.mock.calls.at(-1)![0] as string;
}

beforeEach(() => {
  role = "OWNER";
  vi.clearAllMocks();
});

describe("AI connection actions", () => {
  it("refuses a member before any flow runs", async () => {
    role = "MEMBER";
    const url = await redirectedTo(connectAiProviderAction, form({ provider: "ANTHROPIC", secret: SECRET }));

    expect(url).toBe("/ai-costs/connections?status=forbidden");
    expect(flows.connectAiProvider).not.toHaveBeenCalled();
  });

  it("passes the secret to the flow only, never to the redirect URL", async () => {
    flows.connectAiProvider.mockResolvedValue({ status: "rejected", code: "UNAUTHORIZED" });
    const url = await redirectedTo(connectAiProviderAction, form({ provider: "ANTHROPIC", secret: SECRET }));

    expect(flows.connectAiProvider).toHaveBeenCalledWith({ workspaceId: "ws-1", actorId: "user-1", provider: "ANTHROPIC", secret: SECRET });
    expect(url).toBe("/ai-costs/connections?status=rejected&code=UNAUTHORIZED");
    expect(url).not.toContain(SECRET);
  });

  it("rejects a malformed form without calling the provider", async () => {
    const url = await redirectedTo(connectAiProviderAction, form({ provider: "CUSTOM", secret: SECRET }));

    expect(url).toBe("/ai-costs/connections?status=invalid");
    expect(flows.connectAiProvider).not.toHaveBeenCalled();
  });

  it("does not revoke without an explicit confirmation", async () => {
    const url = await redirectedTo(revokeAiConnectionAction, form({ connectionId: "conn-1" }));

    expect(url).toBe("/ai-costs/connections?status=unconfirmed");
    expect(flows.revokeAiConnection).not.toHaveBeenCalled();
  });

  it("revokes a confirmed connection of the signed-in workspace", async () => {
    flows.revokeAiConnection.mockResolvedValue({ status: "revoked" });
    const url = await redirectedTo(revokeAiConnectionAction, form({ connectionId: "conn-1", confirm: "yes" }));

    expect(flows.revokeAiConnection).toHaveBeenCalledWith({ workspaceId: "ws-1", actorId: "user-1", connectionId: "conn-1" });
    expect(url).toBe("/ai-costs/connections?status=revoked");
  });

  it("reports a re-test outcome with its code", async () => {
    flows.revalidateAiConnection.mockResolvedValue({ status: "unavailable", code: "RATE_LIMITED" });
    const url = await redirectedTo(revalidateAiConnectionAction, form({ connectionId: "conn-1" }));

    expect(url).toBe("/ai-costs/connections?status=unavailable&code=RATE_LIMITED");
  });
});
