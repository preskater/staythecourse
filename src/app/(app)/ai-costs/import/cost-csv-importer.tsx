"use client";

import { useMemo, useState, useTransition } from "react";
import { Badge, Notice, TableShell, inputClass, submitClass, tdClass, thClass } from "@/components/ui";
import {
  buildCostImportRows,
  COST_IMPORT_FIELDS,
  COST_IMPORT_FIELD_LABELS,
  COST_IMPORT_ROW_LIMIT,
  emptyCostMapping,
  guessCostMapping,
  mappingFromSaved,
  missingCostMappingReasons,
  toSavedColumns,
  type CostImportActionResult,
  type CostImportField,
  type CostImportMapping,
  type CostImportRowOutcome,
} from "@/modules/ai-costs/import";
import { detectDelimiter, parseCsv } from "@/modules/budget/import";
import { importCostsAction } from "./actions";

/**
 * CSV cost import, browser side: source, file, mapping, preview, import.
 *
 * The preview asks the server which rows are new, duplicates or rejected — the browser
 * never decides a duplicate. Each row can be left out before importing. Any change to
 * the file, the mapping or the selection discards the preview, so what is imported is
 * always what was just checked.
 */

const FILE_SIZE_LIMIT_BYTES = 2_000_000;
const DELIMITERS = [";", ",", "\t", "|"] as const;
type Delimiter = (typeof DELIMITERS)[number];

type SavedMapping = {
  source: string;
  delimiter: string;
  hasHeader: boolean;
  columns: Record<string, string>;
  defaultCurrency: string | null;
};

function asDelimiter(value: string): Delimiter {
  return (DELIMITERS as readonly string[]).includes(value) ? (value as Delimiter) : ";";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? "s" : ""}`;
}

const STATUS: Record<CostImportRowOutcome["status"], { label: string; tone: "neutral" | "positive" | "negative" | "warning" }> = {
  new: { label: "Nouvelle", tone: "neutral" },
  created: { label: "Créée", tone: "positive" },
  duplicate: { label: "Doublon", tone: "warning" },
  rejected: { label: "Rejetée", tone: "negative" },
};

export function CostCsvImporter({
  mappings,
  currencies,
}: {
  mappings: SavedMapping[];
  currencies: string[];
}) {
  const [source, setSource] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState<Delimiter>(";");
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<CostImportMapping>(emptyCostMapping);
  const [defaultCurrency, setDefaultCurrency] = useState<string>("");
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<CostImportActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const table = useMemo(() => (rawText === null ? null : parseCsv(rawText, delimiter)), [rawText, delimiter]);
  const header = table?.[0] ?? null;
  const saved = mappings.find((candidate) => candidate.source.toLowerCase() === source.trim().toLowerCase()) ?? null;

  const build = useMemo(
    () =>
      table
        ? buildCostImportRows({ table, mapping, hasHeader, defaultCurrency: defaultCurrency || null })
        : null,
    [table, mapping, hasHeader, defaultCurrency],
  );

  const errorRows = build?.rows.filter((row) => row.errors.length > 0) ?? [];
  const selectedRows = build?.rows.filter((row) => row.errors.length === 0 && !excluded.has(row.line)) ?? [];
  const mappingReasons = missingCostMappingReasons(mapping, defaultCurrency || null);
  const outcomeByLine = new Map(
    result?.status === "ok" ? result.outcomes.map((outcome) => [outcome.line, outcome]) : [],
  );
  const preview = result?.status === "ok" && result.dryRun ? result : null;
  const committed = result?.status === "ok" && !result.dryRun ? result : null;
  const ready = source.trim() !== "" && mappingReasons.length === 0 && selectedRows.length > 0 && !isPending;

  // Every input change invalidates the server's answer.
  function changed<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setResult(null);
    };
  }

  function applySaved(target: SavedMapping, text: string) {
    const nextDelimiter = asDelimiter(target.delimiter);
    const parsed = parseCsv(text, nextDelimiter);
    setDelimiter(nextDelimiter);
    setHasHeader(target.hasHeader);
    setDefaultCurrency(target.defaultCurrency ?? "");
    setMapping(mappingFromSaved(parsed[0] ?? [], target.columns));
  }

  async function onFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setResult(null);
    setReadError(null);
    setExcluded(new Set());

    if (!selected) return;

    if (selected.size > FILE_SIZE_LIMIT_BYTES) {
      setReadError("Fichier trop volumineux : l'import est limité à 2 Mo. Découpez-le par période.");
      return;
    }

    try {
      const text = await selected.text();
      setRawText(text);
      setFileName(selected.name);

      if (saved) {
        applySaved(saved, text);
      } else {
        const detected = asDelimiter(detectDelimiter(text));
        const parsed = parseCsv(text, detected);
        const guessed = guessCostMapping(parsed[0] ?? []);
        setDelimiter(detected);
        setMapping(guessed);
        setHasHeader(guessed.date !== null || guessed.label !== null);
      }
    } catch {
      setReadError("Fichier illisible : vérifiez qu'il s'agit bien d'un export CSV texte.");
    }
  }

  function onSourceChange(value: string) {
    setSource(value);
    setResult(null);
    const match = mappings.find((candidate) => candidate.source.toLowerCase() === value.trim().toLowerCase());
    if (match && rawText !== null) applySaved(match, rawText);
  }

  function setColumn(index: number, field: CostImportField | "ignore") {
    const next = emptyCostMapping();
    for (const key of COST_IMPORT_FIELDS) {
      if (mapping[key] !== null && mapping[key] !== index && key !== field) next[key] = mapping[key];
    }
    if (field !== "ignore") next[field] = index;
    setMapping(next);
    setResult(null);
  }

  function toggleRow(line: number) {
    const next = new Set(excluded);
    if (next.has(line)) next.delete(line);
    else next.add(line);
    setExcluded(next);
    setResult(null);
  }

  function submit(dryRun: boolean) {
    if (!ready || !header) return;

    startTransition(async () => {
      setResult(
        await importCostsAction({
          source: source.trim(),
          delimiter,
          hasHeader,
          columns: hasHeader ? toSavedColumns(header, mapping) : {},
          defaultCurrency: defaultCurrency || null,
          dryRun,
          rejectedInFile: errorRows.length,
          rows: selectedRows.map((row) => ({
            line: row.line,
            date: row.date,
            periodEnd: row.periodEnd,
            label: row.label,
            amount: row.amount,
            currency: row.currency,
            reference: row.reference,
            notes: row.notes,
          })),
        }),
      );
    });
  }

  const columnOf = (index: number): CostImportField | "ignore" =>
    COST_IMPORT_FIELDS.find((field) => mapping[field] === index) ?? "ignore";
  const firstData = table?.[hasHeader ? 1 : 0] ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Source</span>
          <input
            className={inputClass}
            list="cost-import-sources"
            value={source}
            maxLength={80}
            placeholder="ex. OpenAI factures"
            onChange={(event) => onSourceChange(event.target.value)}
          />
          <datalist id="cost-import-sources">
            {mappings.map((candidate) => (
              <option key={candidate.source} value={candidate.source} />
            ))}
          </datalist>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Fichier CSV</span>
          <input type="file" accept=".csv,text/csv,text/plain" onChange={onFileSelected} />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Séparateur</span>
          <select
            className={inputClass}
            value={delimiter}
            onChange={(event) => changed(setDelimiter)(asDelimiter(event.target.value))}
          >
            <option value=";">point-virgule ( ; )</option>
            <option value=",">virgule ( , )</option>
            <option value={"\t"}>tabulation</option>
            <option value="|">barre verticale ( | )</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Devise par défaut</span>
          <select
            className={inputClass}
            value={defaultCurrency}
            onChange={(event) => changed(setDefaultCurrency)(event.target.value)}
          >
            <option value="">Aucune (colonne « Devise » requise)</option>
            {currencies.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={hasHeader}
          onChange={(event) => changed(setHasHeader)(event.target.checked)}
        />
        La première ligne du fichier est un en-tête de colonnes (nécessaire pour réutiliser
        l&apos;association)
      </label>

      {saved && rawText !== null ? (
        <Notice tone="info">Association enregistrée pour « {saved.source} » appliquée : vérifiez-la ci-dessous.</Notice>
      ) : null}
      {readError ? <Notice tone="error">{readError}</Notice> : null}
      {build?.truncated ? (
        <Notice tone="warning">
          Fichier limité aux {COST_IMPORT_ROW_LIMIT} premières lignes : découpez-le pour importer le reste.
        </Notice>
      ) : null}

      {table && header ? (
        <TableShell caption="Association des colonnes">
          <thead>
            <tr>
              <th scope="col" className={thClass}>Colonne</th>
              <th scope="col" className={thClass}>Exemple</th>
              <th scope="col" className={thClass}>Signification</th>
            </tr>
          </thead>
          <tbody>
            {header.map((column, index) => (
              <tr key={index}>
                <td className={tdClass}>{hasHeader ? column || `Colonne ${index + 1}` : `Colonne ${index + 1}`}</td>
                <td className={`${tdClass} text-zinc-500 dark:text-zinc-400`}>{firstData[index]?.trim() || "—"}</td>
                <td className={tdClass}>
                  <select
                    className={inputClass}
                    aria-label={`Signification de la colonne ${index + 1}`}
                    value={columnOf(index)}
                    onChange={(event) => setColumn(index, event.target.value as CostImportField | "ignore")}
                  >
                    {(["ignore", ...COST_IMPORT_FIELDS] as const).map((field) => (
                      <option key={field} value={field}>
                        {COST_IMPORT_FIELD_LABELS[field]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      ) : null}

      {table && mappingReasons.length > 0 ? <Notice tone="warning">{mappingReasons.join(" ")}</Notice> : null}

      {build && build.rows.length > 0 && mappingReasons.length === 0 ? (
        <>
          <div className="max-h-[32rem] overflow-y-auto">
            <TableShell caption="Aperçu ligne par ligne">
              <thead>
                <tr>
                  <th scope="col" className={thClass}>Importer</th>
                  <th scope="col" className={thClass}>Ligne</th>
                  <th scope="col" className={thClass}>Période</th>
                  <th scope="col" className={thClass}>Libellé</th>
                  <th scope="col" className={`${thClass} text-right`}>Montant</th>
                  <th scope="col" className={thClass}>Statut</th>
                </tr>
              </thead>
              <tbody>
                {build.rows.map((row) => {
                  const outcome = outcomeByLine.get(row.line);
                  const rejectedHere = row.errors.length > 0;
                  return (
                    <tr key={row.line}>
                      <td className={tdClass}>
                        <input
                          type="checkbox"
                          aria-label={`Importer la ligne ${row.line}`}
                          disabled={rejectedHere || committed !== null}
                          checked={!rejectedHere && !excluded.has(row.line)}
                          onChange={() => toggleRow(row.line)}
                        />
                      </td>
                      <td className={`${tdClass} tabular-nums`}>{row.line}</td>
                      <td className={`${tdClass} whitespace-nowrap tabular-nums`}>
                        {row.date ?? "—"}
                        {row.periodEnd && row.periodEnd !== row.date ? ` → ${row.periodEnd}` : ""}
                      </td>
                      <td className={tdClass}>{row.label || "—"}</td>
                      <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>
                        {row.amount ? `${row.amount} ${row.currency ?? ""}` : "—"}
                        {row.rounded ? <span className="block text-xs text-zinc-500">arrondi au centime</span> : null}
                      </td>
                      <td className={tdClass}>
                        {rejectedHere ? (
                          <>
                            <Badge tone="negative">Rejetée</Badge> <span className="text-xs">{row.errors.join(" ")}</span>
                          </>
                        ) : excluded.has(row.line) ? (
                          <Badge>Écartée par vous</Badge>
                        ) : outcome ? (
                          <>
                            <Badge tone={STATUS[outcome.status].tone}>{STATUS[outcome.status].label}</Badge>{" "}
                            {outcome.reason ? <span className="text-xs">{outcome.reason}</span> : null}
                          </>
                        ) : (
                          <span className="text-xs text-zinc-500">À vérifier</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableShell>
          </div>

          {committed === null ? (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={submitClass} disabled={!ready} onClick={() => submit(true)}>
                {isPending && !preview ? "Vérification..." : "Vérifier les doublons"}
              </button>
              <button
                type="button"
                className={submitClass}
                disabled={!ready || preview === null || preview.outcomes.every((outcome) => outcome.status !== "new")}
                onClick={() => submit(false)}
              >
                {isPending && preview ? "Import en cours..." : `Importer ${plural(preview?.outcomes.filter((outcome) => outcome.status === "new").length ?? 0, "ligne")}`}
              </button>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Rien n&apos;est enregistré avant « Importer ». {source.trim() === "" ? "Nommez d'abord la source." : ""}
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {fileName && build ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {fileName} — {plural(build.rows.length, "ligne")} lue{build.rows.length > 1 ? "s" : ""},{" "}
          {plural(errorRows.length, "rejet")} à la lecture, {plural(excluded.size, "ligne")} écartée{excluded.size > 1 ? "s" : ""}.
        </p>
      ) : null}

      {committed ? (
        <Notice tone="info">
          Import {committed.summary.importId} : {plural(committed.summary.created, "coût")} créé
          {committed.summary.created > 1 ? "s" : ""}, {plural(committed.summary.duplicates, "doublon")} ignoré
          {committed.summary.duplicates > 1 ? "s" : ""}, {committed.summary.rejected + committed.summary.rejectedInFile} ligne
          {committed.summary.rejected + committed.summary.rejectedInFile > 1 ? "s" : ""} rejetée
          {committed.summary.rejected + committed.summary.rejectedInFile > 1 ? "s" : ""} (motif dans le tableau). L&apos;association
          des colonnes est enregistrée pour « {source.trim()} ».
        </Notice>
      ) : null}
      {result?.status === "invalid" || result?.status === "error" ? (
        <Notice tone="error">{result.message}</Notice>
      ) : null}
    </div>
  );
}
