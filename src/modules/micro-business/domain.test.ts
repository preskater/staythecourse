import { describe, expect, it } from "vitest";
import {
  archiveInputSchema,
  BILLING_MODELS,
  BILLING_MODEL_LABELS,
  billingBehaviour,
  clientInputSchema,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  projectInputSchema,
  toClientFormInitialValues,
  toProjectFormInitialValues,
  type BillingModel,
  type ClientSummary,
  type ProjectSummary,
} from "./domain";

/** A valid billable project; each test changes only what it is about. */
const project = {
  name: "Refonte du site",
  clientId: "client-1",
  billingModel: "FIXED_PRICE",
  status: "ACTIVE",
  currency: "EUR",
  startDate: "2026-01-05",
  endDate: "2026-03-31",
  notes: "",
} as const;

describe("billing models", () => {
  it("labels every model and status", () => {
    for (const model of BILLING_MODELS) {
      expect(BILLING_MODEL_LABELS[model]).toBeTruthy();
    }
    for (const status of PROJECT_STATUSES) {
      expect(PROJECT_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("treats only fixed-price, time-and-materials and retainer work as billable", () => {
    const billable = BILLING_MODELS.filter((model) => billingBehaviour(model).billable);

    expect(billable).toEqual(["FIXED_PRICE", "TIME_AND_MATERIALS", "RETAINER"]);
  });

  it.each<BillingModel>(["INTERNAL", "NON_BILLABLE"])(
    "never expects revenue from %s",
    (model) => {
      expect(billingBehaviour(model)).toEqual({ billable: false, clientRequired: false });
    },
  );

  it("requires a client exactly when the model is billable", () => {
    for (const model of BILLING_MODELS) {
      expect(billingBehaviour(model).clientRequired).toBe(billingBehaviour(model).billable);
    }
  });
});

describe("project input", () => {
  it("accepts a billable project with a client and a sane period", () => {
    const parsed = projectInputSchema.safeParse(project);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.endDate?.toISOString().slice(0, 10)).toBe("2026-03-31");
  });

  it("refuses a billable project without a client", () => {
    const parsed = projectInputSchema.safeParse({ ...project, clientId: "" });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["clientId"],
        message: "Un projet facturable doit être rattaché à un client.",
      }),
    );
  });

  it.each<BillingModel>(["INTERNAL", "NON_BILLABLE"])(
    "accepts %s work without a client",
    (model) => {
      const parsed = projectInputSchema.safeParse({ ...project, billingModel: model, clientId: "" });

      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.clientId).toBeNull();
    },
  );

  it("refuses an end date before the start date, but allows the same day", () => {
    const reversed = projectInputSchema.safeParse({ ...project, endDate: "2026-01-04" });
    expect(reversed.success).toBe(false);
    expect(reversed.success ? [] : reversed.error.issues).toContainEqual(
      expect.objectContaining({ path: ["endDate"] }),
    );

    const sameDay = projectInputSchema.safeParse({ ...project, endDate: "2026-01-05" });
    expect(sameDay.success).toBe(true);
  });

  it("defaults the currency to EUR and trims the name", () => {
    const parsed = projectInputSchema.safeParse({ ...project, name: "  Refonte  ", currency: undefined });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ name: "Refonte", currency: "EUR" });
  });

  it("refuses an unknown billing model or status", () => {
    expect(projectInputSchema.safeParse({ ...project, billingModel: "HOURLY" }).success).toBe(false);
    expect(projectInputSchema.safeParse({ ...project, status: "ARCHIVED" }).success).toBe(false);
  });
});

describe("client input", () => {
  it("normalises an empty email and contact to null", () => {
    const parsed = clientInputSchema.safeParse({
      name: "  Studio Lumen ",
      contactName: "",
      email: "",
      notes: "",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      name: "Studio Lumen",
      contactName: null,
      email: null,
      notes: null,
    });
  });

  it("refuses a malformed email but keeps a valid one", () => {
    expect(
      clientInputSchema.safeParse({ name: "Studio", contactName: "", email: "not-an-email", notes: "" })
        .success,
    ).toBe(false);

    const parsed = clientInputSchema.safeParse({
      name: "Studio",
      contactName: "",
      email: "contact@example.test",
      notes: "",
    });
    expect(parsed.success && parsed.data.email).toBe("contact@example.test");
  });
});

describe("archive input", () => {
  it("converts the form value into the requested state", () => {
    expect(archiveInputSchema.parse({ id: "project-1", archived: "true" })).toEqual({
      id: "project-1",
      archived: true,
    });
    expect(archiveInputSchema.parse({ id: "project-1", archived: "false" })).toEqual({
      id: "project-1",
      archived: false,
    });
  });

  it("refuses a state that is not the two expected strings", () => {
    expect(archiveInputSchema.safeParse({ id: "project-1", archived: "yes" }).success).toBe(false);
    expect(archiveInputSchema.safeParse({ id: "", archived: "true" }).success).toBe(false);
  });
});

describe("form initial values", () => {
  const projectSummary: ProjectSummary = {
    id: "project-1",
    name: "Refonte",
    clientId: null,
    clientName: null,
    billingModel: "INTERNAL",
    status: "ACTIVE",
    currency: "EUR",
    startDate: new Date("2026-01-05T00:00:00.000Z"),
    endDate: null,
    notes: null,
    archived: false,
  };

  const clientSummary: ClientSummary = {
    id: "client-1",
    name: "Studio",
    contactName: null,
    email: null,
    notes: null,
    archived: false,
    projectCount: 0,
    activeProjectCount: 0,
  };

  it("serialises dates to YYYY-MM-DD and missing values to empty strings", () => {
    expect(toProjectFormInitialValues(projectSummary)).toMatchObject({
      clientId: "",
      startDate: "2026-01-05",
      endDate: "",
      notes: "",
    });
  });

  it("keeps the archived flag out of the editable fields", () => {
    expect(toClientFormInitialValues({ ...clientSummary, archived: true })).toEqual({
      id: "client-1",
      name: "Studio",
      contactName: "",
      email: "",
      notes: "",
    });
  });
});
