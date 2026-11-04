import { describe, expect, it } from "vitest";
import {
  activeModules,
  DEFAULT_MODULES,
  isModuleKey,
  MODULE_CATALOG,
  MODULE_KEYS,
  moduleNavLinks,
  parseModuleSelection,
  validateModuleChange,
  type ModuleKey,
} from "./catalog";

const rows = (...keys: string[]) => keys.map((moduleKey) => ({ moduleKey, enabled: true }));

describe("module catalog", () => {
  it.each(MODULE_KEYS)("%s is a known key whose prerequisites are known keys", (key) => {
    expect(isModuleKey(key)).toBe(true);
    for (const required of MODULE_CATALOG[key].requires) {
      expect(MODULE_KEYS).toContain(required);
      expect(required).not.toBe(key);
    }
  });

  it("has no prerequisite cycle: every key enabled with everything activates", () => {
    expect(activeModules(rows(...MODULE_KEYS))).toEqual([...MODULE_KEYS]);
  });

  it.each(["", "Budget", "billing", "__proto__", "budget ", null, 42])(
    "refuses the unknown key %j",
    (key) => {
      expect(isModuleKey(key)).toBe(false);
    },
  );

  it("defaults to the modules that predate the catalog", () => {
    expect(DEFAULT_MODULES).toEqual(["budget", "real-estate", "development"]);
  });
});

describe("parseModuleSelection", () => {
  it("reads a comma-separated list into catalog order", () => {
    expect(parseModuleSelection("development, budget")).toEqual({
      status: "ok",
      modules: ["budget", "development"],
    });
  });

  it("accepts spaces, duplicates and another case", () => {
    expect(parseModuleSelection("Budget  budget\nREAL-ESTATE")).toEqual({
      status: "ok",
      modules: ["budget", "real-estate"],
    });
  });

  it("accepts an empty list: a workspace may enable nothing", () => {
    expect(parseModuleSelection("   ")).toEqual({ status: "ok", modules: [] });
  });

  it("reads the documented default value back as the default set", () => {
    expect(parseModuleSelection(DEFAULT_MODULES.join(","))).toEqual({
      status: "ok",
      modules: [...DEFAULT_MODULES],
    });
  });

  it("reports every unknown key together, instead of dropping them", () => {
    expect(parseModuleSelection("budget, billing, __proto__")).toEqual({
      status: "unknown_module",
      keys: ["billing", "__proto__"],
    });
  });

  it("refuses a selection that leaves a prerequisite out", () => {
    expect(parseModuleSelection("profitability")).toEqual({
      status: "missing_prerequisites",
      missing: ["budget", "real-estate"],
    });
  });

  it("accepts a module once its prerequisites are part of the same list", () => {
    expect(parseModuleSelection("profitability,budget,real-estate")).toEqual({
      status: "ok",
      modules: ["budget", "real-estate", "profitability"],
    });
  });
});

describe("activeModules", () => {
  it.each<[string, string[], ModuleKey[]]>([
    ["nothing enabled", [], []],
    ["one module", ["budget"], ["budget"]],
    ["catalog order, whatever the row order", ["development", "budget"], ["budget", "development"]],
    ["unknown keys ignored", ["budget", "billing"], ["budget"]],
    ["prerequisites met", ["budget", "real-estate", "profitability"], ["budget", "real-estate", "profitability"]],
    ["prerequisite missing", ["budget", "profitability"], ["budget"]],
  ])("%s", (_case, keys, expected) => {
    expect(activeModules(rows(...keys))).toEqual(expected);
  });

  it("drops a disabled row, and the dependants with it, while their rows stay stored", () => {
    const stored = [
      { moduleKey: "budget", enabled: false },
      { moduleKey: "real-estate", enabled: true },
      { moduleKey: "profitability", enabled: true },
    ];

    expect(activeModules(stored)).toEqual(["real-estate"]);
  });
});

describe("moduleNavLinks", () => {
  it("lists only the active modules that have a page", () => {
    expect(moduleNavLinks(["budget", "family", "development"])).toEqual([
      { href: "/budget", label: "Budget" },
      { href: "/integrations", label: "Intégrations" },
    ]);
  });
});

describe("validateModuleChange", () => {
  it("accepts a known key", () => {
    expect(validateModuleChange({ key: "budget", enabled: true }, [])).toEqual({
      status: "ok",
      key: "budget",
      enabled: true,
      config: undefined,
    });
  });

  it("refuses an unknown key, even to disable it", () => {
    expect(validateModuleChange({ key: "billing", enabled: false }, [])).toEqual({
      status: "unknown_module",
    });
  });

  it("refuses to enable a module whose prerequisites are not active", () => {
    expect(validateModuleChange({ key: "profitability", enabled: true }, ["budget"])).toEqual({
      status: "missing_prerequisites",
      missing: ["real-estate"],
    });
  });

  it("lets a prerequisite be disabled: the dependants only go inactive", () => {
    expect(
      validateModuleChange({ key: "budget", enabled: false }, ["budget", "real-estate", "profitability"]),
    ).toMatchObject({ status: "ok", enabled: false });
  });

  it.each<[string, unknown]>([
    ["an unknown field", { color: "red" }],
    ["a non-object", "on"],
    ["an array", []],
    ["null", null],
  ])("refuses a configuration with %s", (_case, config) => {
    expect(validateModuleChange({ key: "budget", enabled: true, config }, []).status).toBe(
      "invalid_config",
    );
  });

  it("accepts an empty configuration", () => {
    expect(validateModuleChange({ key: "budget", enabled: true, config: {} }, [])).toMatchObject({
      status: "ok",
      config: {},
    });
  });
});
