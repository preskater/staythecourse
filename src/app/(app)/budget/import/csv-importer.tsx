"use client";

import Decimal from "decimal.js";
import { useMemo, useState, useTransition } from "react";
import { Notice, inputClass, submitClass, tdClass, thClass, TableShell } from "@/components/ui";
import { formatMoney, type Currency } from "@/lib/money";
import {
  buildImportRows,
  detectDelimiter,
  emptyMapping,
  guessMapping,
  IMPORT_TARGETS,
  IMPORT_TARGET_LABELS,
  IMPORT_ROW_LIMIT,
  missingMappingReasons,
  parseCsv,
  type ImportActionResult,
  type ImportMapping,
  type ImportTarget,
} from "@/modules/budget/import";
import { importTransactionsAction } from "./actions";
import { plural } from "@/lib/word";

/**
 * CSV import, browser side: pick a file, map its columns, check the preview, submit.
 *
 * The file is read with `File.text()` and parsed here — nothing is uploaded before the
 * owner has seen what will be created. Only the normalised rows travel to the Server
 * Action, which validates every field again (a browser preview is a comfort, never a
 * permission). The mapping selects are plain labelled controls: they work with the
 * keyboard, and every guess stays visible and editable.
 */

const FILE_SIZE_LIMIT_BYTES = 2_000_000;
const PREVIEW_ROW_COUNT = 5;
const ERROR_ROW_COUNT = 10;

/** The mapping targets a column can be assigned to, in form order. */
const MAPPING_KEYS = [
  "date",
  "label",
  "amount",
  "debit",
  "credit",
  "reference",
  "category",
  "notes",
] as const;

type ImportColumnTarget = Exclude<ImportTarget, "ignore">;

function targetOfColumn(mapping: ImportMapping, columnIndex: number): ImportTarget {
  for (const key of MAPPING_KEYS) {
    if (mapping[key] === columnIndex) {
      return key;
    }
  }

  return "ignore";
}

function withColumnTarget(
  mapping: ImportMapping,
  columnIndex: number,
  target: ImportTarget,
): ImportMapping {
  const next = emptyMapping();

  for (const key of MAPPING_KEYS) {
    const current = mapping[key];
    if (current !== null && current !== columnIndex && key !== target) {
      next[key] = current;
    }
  }

  if (target !== "ignore") {
    next[target as ImportColumnTarget] = columnIndex;
  }

  return next;
}

export function CsvImporter({
  accounts,
}: {
  accounts: { id: string; name: string; currency: Currency }[];
}) {
  const [rawText, setRawText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState<string>(";");
  const [table, setTable] = useState<string[][] | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<ImportMapping>(emptyMapping);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const account = accounts.find((candidate) => candidate.id === accountId) ?? null;

  function reset() {
    setRawText(null);
    setFileName(null);
    setTable(null);
    setHasHeader(true);
    setMapping(emptyMapping());
    setSkipDuplicates(true);
    setReadError(null);
    setResult(null);
  }

  async function onFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setResult(null);
    setReadError(null);

    if (!selected) {
      return;
    }

    if (selected.size > FILE_SIZE_LIMIT_BYTES) {
      setReadError(
        "Fichier trop volumineux : l'import est limité à 2 Mo. Découpez le relevé par période.",
      );
      return;
    }

    try {
      const text = await selected.text();
      const detected = detectDelimiter(text);
      const parsed = parseCsv(text, detected);
      setRawText(text);
      setFileName(selected.name);
      setDelimiter(detected);
      setTable(parsed);

      // The guesses are a starting point, shown in the selects below: nothing imports
      // until the owner confirms them by submitting.
      const guessed = guessMapping(parsed[0] ?? []);
      setMapping(guessed);
      setHasHeader(guessed.date !== null || guessed.label !== null);
    } catch {
      setReadError("Fichier illisible : vérifiez qu'il s'agit bien d'un export CSV texte.");
    }
  }

  function onDelimiterChange(nextDelimiter: string) {
    setDelimiter(nextDelimiter);
    if (rawText !== null) {
      setTable(parseCsv(rawText, nextDelimiter));
    }
  }

  const build = useMemo(
    () => (table ? buildImportRows({ table, mapping, hasHeader }) : null),
    [table, mapping, hasHeader],
  );

  const validRows = build?.rows.filter((row) => row.errors.length === 0) ?? [];
  const errorRows = build?.rows.filter((row) => row.errors.length > 0) ?? [];
  const mappingReasons = missingMappingReasons(mapping);
  const canSubmit =
    build !== null &&
    account !== null &&
    mappingReasons.length === 0 &&
    validRows.length > 0 &&
    !isPending;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || account === null) {
      return;
    }

    startTransition(async () => {
      const outcome = await importTransactionsAction({
        accountId: account.id,
        skipDuplicates: skipDuplicates ? "true" : "false",
        rows: validRows.map((row) => ({
          date: row.date!,
          label: row.label,
          amount: row.amount!,
          reference: row.reference,
          categoryName: row.categoryName,
          notes: row.notes,
        })),
      });

      setResult(outcome);
    });
  }

  const header = table?.[0] ?? null;
  const previewStart = hasHeader ? 1 : 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Fichier CSV</span>
          <input type="file" accept=".csv,text/csv,text/plain" onChange={onFileSelected} />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Compte de destination</span>
          <select
            className={inputClass}
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {accounts.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} — {candidate.currency}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Séparateur</span>
          <select
            className={inputClass}
            value={delimiter}
            onChange={(event) => onDelimiterChange(event.target.value)}
          >
            <option value=";">point-virgule ( ; )</option>
            <option value=",">virgule ( , )</option>
            <option value={"\t"}>tabulation</option>
            <option value="|">barre verticale ( | )</option>
          </select>
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={hasHeader}
          onChange={(event) => setHasHeader(event.target.checked)}
        />
        La première ligne du fichier est un en-tête de colonnes
      </label>

      {readError ? <Notice tone="error">{readError}</Notice> : null}

      {fileNotices(build, fileName)}

      {table && header ? (
        <>
          <div>
            <h3 className="text-sm font-semibold">Association des colonnes</h3>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Associez chaque colonne à sa signification. « Montant » seul, ou « Débit » et
              « Crédit » séparés — pas les deux à la fois pour la même colonne.
            </p>
          </div>

          <TableShell caption="Colonnes du fichier et association">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Colonne
                </th>
                <th scope="col" className={thClass}>
                  Exemple
                </th>
                <th scope="col" className={thClass}>
                  Signification
                </th>
              </tr>
            </thead>
            <tbody>
              {header.map((column, index) => (
                <tr key={index}>
                  <td className={tdClass}>
                    {hasHeader ? column || `Colonne ${index + 1}` : `Colonne ${index + 1}`}
                  </td>
                  <td className={`${tdClass} text-zinc-500 dark:text-zinc-400`}>
                    {table[previewStart]?.[index]?.trim() || "—"}
                  </td>
                  <td className={tdClass}>
                    <select
                      className={inputClass}
                      aria-label={`Signification de la colonne ${index + 1}`}
                      value={targetOfColumn(mapping, index)}
                      onChange={(event) =>
                        setMapping(
                          withColumnTarget(
                            mapping,
                            index,
                            event.target.value as ImportTarget,
                          ),
                        )
                      }
                    >
                      {IMPORT_TARGETS.map((target) => (
                        <option key={target} value={target}>
                          {IMPORT_TARGET_LABELS[target]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </>
      ) : null}

      {mappingReasons.length > 0 && table ? (
        <Notice tone="warning">
          {mappingReasons.join(" ")}
        </Notice>
      ) : null}

      {build && errorRows.length > 0 ? (
        <Notice tone="error">
          <span className="font-medium">
            {plural(errorRows.length, "ligne")} en erreur, qui ne seront pas importées :
          </span>{" "}
          {errorRows
            .slice(0, ERROR_ROW_COUNT)
            .map((row) => `ligne ${row.line} — ${row.errors.join(" ")}`)
            .join(" · ")}
          {errorRows.length > ERROR_ROW_COUNT
            ? ` · … et ${errorRows.length - ERROR_ROW_COUNT} autre${errorRows.length - ERROR_ROW_COUNT > 1 ? "s" : ""}`
            : ""}
        </Notice>
      ) : null}

      {build && validRows.length > 0 ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-semibold">
              Aperçu des {Math.min(validRows.length, PREVIEW_ROW_COUNT)} premières lignes
              prêtes à importer
            </h3>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Montants affichés dans la devise du compte
              {account ? ` (${account.currency})` : ""}. Rien n&apos;est enregistré avant le
              clic sur « Importer ».
            </p>
          </div>

          <TableShell caption="Aperçu des lignes à importer">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Ligne
                </th>
                <th scope="col" className={thClass}>
                  Date
                </th>
                <th scope="col" className={thClass}>
                  Libellé
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Montant
                </th>
              </tr>
            </thead>
            <tbody>
              {validRows.slice(0, PREVIEW_ROW_COUNT).map((row) => (
                <tr key={row.line}>
                  <td className={`${tdClass} tabular-nums`}>{row.line}</td>
                  <td className={`${tdClass} whitespace-nowrap tabular-nums`}>
                    {new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", dateStyle: "short" }).format(
                      new Date(`${row.date}T00:00:00.000Z`),
                    )}
                  </td>
                  <td className={tdClass}>{row.label}</td>
                  <td
                    className={`${tdClass} whitespace-nowrap text-right tabular-nums ${
                      new Decimal(row.amount ?? "0").isNegative()
                        ? "text-rose-700 dark:text-rose-400"
                        : ""
                    }`}
                  >
                    {account
                      ? formatMoney({
                          amount: new Decimal(row.amount ?? "0"),
                          currency: account.currency,
                        })
                      : row.amount}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={skipDuplicates}
              onChange={(event) => setSkipDuplicates(event.target.checked)}
            />
            Ignorer les doublons détectés (même date, même libellé, même montant)
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={submitClass} disabled={!canSubmit}>
              {isPending
                ? "Import en cours..."
                : `Importer ${plural(validRows.length, "opération")}`}
            </button>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Le compte de destination porte la devise : aucune conversion n&apos;est faite.
            </p>
          </div>
        </form>
      ) : null}

      {result?.status === "ok" ? (
        <Notice tone="info">
          <span className="font-medium">
            {plural(result.summary.imported, "opération")} importée
            {result.summary.imported > 1 ? "s" : ""}
          </span>{" "}
          sur {plural(result.summary.received, "ligne")} reçue
          {result.summary.received > 1 ? "s" : ""}.
          {result.summary.duplicatesSkipped > 0
            ? ` ${plural(result.summary.duplicatesSkipped, "doublon")} ignoré${
                result.summary.duplicatesSkipped > 1 ? "s" : ""
              }.`
            : ""}
          {result.summary.unknownCategories > 0
            ? ` ${plural(result.summary.unknownCategories, "ligne")} sans catégorie correspondante — catégorie laissée vide.`
            : ""}
          <button type="button" onClick={reset} className="ml-2 underline underline-offset-2">
            Importer un autre fichier
          </button>
        </Notice>
      ) : null}

      {result?.status === "invalid" ? <Notice tone="error">{result.message}</Notice> : null}
      {result?.status === "error" ? <Notice tone="error">{result.message}</Notice> : null}
    </div>
  );
}

/** Honest notes about what the file holds, before any write. */
function fileNotices(
  build: ReturnType<typeof buildImportRows> | null,
  fileName: string | null,
): React.ReactNode {
  if (!build || fileName === null) {
    return null;
  }

  const valid = build.rows.filter((row) => row.errors.length === 0).length;

  return (
    <Notice tone="info">
      <span className="font-medium">{fileName}</span> — {plural(build.dataLineCount, "ligne")}{" "}
      lue{build.dataLineCount > 1 ? "s" : ""}, {plural(valid, "ligne")} prête
      {valid > 1 ? "s" : ""} à importer.
      {build.truncated
        ? ` Fichier limité aux ${IMPORT_ROW_LIMIT} premières lignes : découpez-le pour importer le reste.`
        : ""}
      {build.labelTruncatedCount > 0
        ? ` ${plural(build.labelTruncatedCount, "libellé")} dépassant 200 caractères ont été tronqués.`
        : ""}
    </Notice>
  );
}
