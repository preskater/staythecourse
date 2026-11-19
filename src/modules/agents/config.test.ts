import { describe, expect, it } from "vitest";
import {
  agentConfigFingerprint,
  InvalidAgentConfigError,
  validateAgentConfig,
  validateAgentName,
  validateAgentStatus,
  type AgentConfigInput,
} from "./config";

const base: AgentConfigInput = {
  modelPolicy: {
    primary: { provider: "anthropic", model: "claude-sonnet-5-5" },
    fallbacks: [
      { provider: "anthropic", model: "claude-haiku-5-5" },
      { provider: "openai", model: "gpt-x" },
    ],
  },
  tools: ["git", "bash", "read"],
  ownerId: "user-1",
  repositoryScopes: ["org/api", "org/web"],
};

describe("agentConfigFingerprint", () => {
  it("is a 64-character hex SHA-256", () => {
    expect(agentConfigFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across serialization, key order, set order, duplicates and casing of the provider", () => {
    const reordered = JSON.parse(
      JSON.stringify({
        repositoryScopes: ["org/web", "org/api", "org/web"],
        ownerId: " user-1 ",
        tools: ["read", "bash", "git", "git"],
        modelPolicy: {
          fallbacks: [
            { model: "claude-haiku-5-5", provider: "Anthropic" },
            { model: "gpt-x", provider: "openai" },
          ],
          primary: { model: "claude-sonnet-5-5", provider: "anthropic" },
        },
      }),
    );

    expect(agentConfigFingerprint(reordered)).toBe(agentConfigFingerprint(base));
    expect(agentConfigFingerprint(validateAgentConfig(base))).toBe(agentConfigFingerprint(base));
  });

  it("changes when behaviour changes, including the fallback order", () => {
    const fingerprint = agentConfigFingerprint(base);
    const variants: AgentConfigInput[] = [
      { ...base, modelPolicy: { ...base.modelPolicy, primary: { provider: "anthropic", model: "claude-opus-5-5" } } },
      {
        ...base,
        modelPolicy: {
          ...base.modelPolicy,
          fallbacks: [
            { provider: "openai", model: "gpt-x" },
            { provider: "anthropic", model: "claude-haiku-5-5" },
          ],
        },
      },
      { ...base, tools: ["git"] },
      { ...base, ownerId: "user-2" },
      { ...base, repositoryScopes: ["org/api"] },
    ];

    for (const variant of variants) {
      expect(agentConfigFingerprint(variant)).not.toBe(fingerprint);
    }
  });

  it("pins the recipe: a known configuration keeps a known fingerprint", () => {
    // Changing this value means every stored fingerprint changes: bump the prefix instead.
    // Computed independently from the documented recipe:
    // sha256('agent-config/v1\n{"modelPolicy":{"fallbacks":[],"primary":{"model":"m","provider":"p"}},"ownerId":"u","repositoryScopes":[],"tools":[]}')
    expect(
      agentConfigFingerprint({ modelPolicy: { primary: { provider: "p", model: "m" } }, ownerId: "u" }),
    ).toBe("57aafe9d0574993fab535333f21a4994ba6bbe44fcb8f6269b5da0ffc7db307e");
  });
});

describe("validateAgentConfig", () => {
  it("defaults tools, fallbacks and scopes to empty lists", () => {
    const config = validateAgentConfig({ modelPolicy: { primary: { provider: "p", model: "m" } }, ownerId: "u" });
    expect(config).toEqual({
      modelPolicy: { primary: { provider: "p", model: "m" }, fallbacks: [] },
      tools: [],
      ownerId: "u",
      repositoryScopes: [],
    });
  });

  it("refuses a fallback that repeats the primary or another fallback", () => {
    expect(() =>
      validateAgentConfig({
        ...base,
        modelPolicy: { primary: { provider: "p", model: "m" }, fallbacks: [{ provider: "P", model: "m" }] },
      }),
    ).toThrow(/already listed/);
  });

  it("refuses credentials and non-repository values in scopes", () => {
    expect(() => validateAgentConfig({ ...base, repositoryScopes: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789/x"] })).toThrow(
      InvalidAgentConfigError,
    );
    expect(() => validateAgentConfig({ ...base, repositoryScopes: ["https://github.com/org/api"] })).toThrow(/owner\/repository/);
    expect(() => validateAgentConfig({ ...base, repositoryScopes: ["just-a-name"] })).toThrow(/owner\/repository/);
    expect(validateAgentConfig({ ...base, repositoryScopes: ["group/sub/project"] }).repositoryScopes).toEqual(["group/sub/project"]);
  });

  it("refuses invalid identifiers, oversized lists and a missing owner", () => {
    expect(() => validateAgentConfig({ ...base, modelPolicy: { primary: { provider: "", model: "m" } } })).toThrow(/provider/);
    expect(() => validateAgentConfig({ ...base, modelPolicy: { primary: { provider: "p", model: "a b" } } })).toThrow(/model/);
    expect(() => validateAgentConfig({ ...base, tools: ["rm -rf"] })).toThrow(/invalid tool/);
    expect(() => validateAgentConfig({ ...base, tools: Array.from({ length: 51 }, (_, i) => `t${i}`) })).toThrow(/at most/);
    expect(() => validateAgentConfig({ ...base, ownerId: "  " })).toThrow(/member/);
  });
});

describe("name and status", () => {
  it("validates them apart from the configuration", () => {
    expect(validateAgentName("  Revue de PR ")).toBe("Revue de PR");
    expect(() => validateAgentName("")).toThrow(/required/);
    expect(validateAgentStatus("PAUSED")).toBe("PAUSED");
    expect(() => validateAgentStatus("DELETED")).toThrow(/unknown/);
  });
});
