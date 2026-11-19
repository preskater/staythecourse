import { z } from "zod";

/**
 * Result contract shared by the write Server Actions.
 *
 * Every action answers with the same three shapes, so the forms never have to
 * guess: `ok` means the row was written, `invalid` carries per-field messages to
 * show next to the inputs, and `error` carries a message that reveals nothing
 * about the database. A frontend validation is a comfort, not a protection: the
 * action validates again with the same schema, because a request body can always
 * be replayed by hand.
 */
export type ActionResult =
  | { status: "ok"; message?: string }
  | { status: "invalid"; message: string; fieldErrors: Record<string, string[]> }
  | { status: "error"; message: string };

export function invalidResult(
  error: z.ZodError,
): Extract<ActionResult, { status: "invalid" }> {
  return {
    status: "invalid",
    message: "Certaines valeurs sont invalides. Rien n'a été enregistré.",
    fieldErrors: groupIssuesByField(error),
  };
}

/** A single business rule refusal, reported on the field that caused it. */
export function rejectedResult(
  field: string,
  message: string,
): Extract<ActionResult, { status: "invalid" }> {
  return { status: "invalid", message, fieldErrors: { [field]: [message] } };
}

/*
 * Logs the technical detail server-side and answers with a message the user can act
 * on.
 *
 * The log line carries no payload: amounts, labels and identifiers stay out of it,
 * only the error type and its code reach it. An unreadable log line is what makes a
 * `P2003` take an afternoon to diagnose; the code is safe to print, unlike the row
 * values in the driver's message.
 */
export function unexpectedResult(
  context: string,
  error: unknown,
): Extract<ActionResult, { status: "error" }> {
  const code = prismaErrorCode(error);

  console.error(
    `[${context}] ${error instanceof Error ? error.name : typeof error}${code ? ` (${code})` : ""}`,
  );

  if (code === "P2003") {
    // Foreign key: the owner row named by the session no longer exists, typically
    // because the database was recreated. Only signing in again fixes it.
    return {
      status: "error",
      message:
        "Votre session ne correspond plus à un compte existant. Déconnectez-vous, puis reconnectez-vous.",
    };
  }

  return {
    status: "error",
    message: "Enregistrement impossible pour le moment. Réessayez dans un instant.",
  };
}

/**
 * Detects a Prisma unique-constraint violation without importing the generated
 * client here: this module is also loaded by client components for its type.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return prismaErrorCode(error) === "P2002";
}

/** Prisma error code, when the thrown value carries one. */
function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function groupIssuesByField(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const field = issue.path.join(".") || "root";
    const messages = fieldErrors[field] ?? [];
    messages.push(issue.message);
    fieldErrors[field] = messages;
  }

  return fieldErrors;
}
