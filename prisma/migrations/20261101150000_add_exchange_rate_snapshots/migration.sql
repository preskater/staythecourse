-- M9-04: frozen exchange-rate snapshots.
--
-- A snapshot is the evidence behind a converted amount: it is never edited and never
-- deleted, and every converted figure references the row it used. Recording a newer
-- rate therefore only affects later conversions; no value already computed is rewritten.
--
-- `baseCurrency`/`quoteCurrency` read "1 base is worth `rate` quote". The rate is an
-- exact decimal with ten places, `rateDate` is the calendar day it is in force for, and
-- `recordedAt` is the instant the row was written (the tie-break between two snapshots of
-- one day). `source` holds the ledger's frozen source reference (kind, identifiers and
-- capture instant only), re-validated in code on read.
CREATE TABLE "ExchangeRateSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "baseCurrency" CHAR(3) NOT NULL,
    "quoteCurrency" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,10) NOT NULL,
    "rateDate" DATE NOT NULL,
    "source" JSONB NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRateSnapshot_pkey" PRIMARY KEY ("id"),
    -- A rate of zero or below would turn any amount into zero or a negative figure.
    CONSTRAINT "ExchangeRateSnapshot_rate_check" CHECK ("rate" > 0),
    CONSTRAINT "ExchangeRateSnapshot_pair_check" CHECK ("baseCurrency" <> "quoteCurrency")
);

-- Every lookup is "the latest snapshot of this pair on or before this day", inside one
-- workspace: the composite index serves it without scanning the whole rate history.
CREATE INDEX "ExchangeRateSnapshot_workspace_pair_rateDate_idx"
    ON "ExchangeRateSnapshot"("workspaceId", "baseCurrency", "quoteCurrency", "rateDate");

ALTER TABLE "ExchangeRateSnapshot"
    ADD CONSTRAINT "ExchangeRateSnapshot_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
