-- M11-04: token classes on imported AI usage lines.
--
-- Additive only: two nullable columns, `NULL` meaning "not reported by the provider".
-- Existing rows keep `NULL` until the next synchronisation rewrites them.
-- Rollback: drop both columns.
ALTER TABLE "AiUsageLine" ADD COLUMN "cachedInputTokens" BIGINT,
ADD COLUMN "reasoningTokens" BIGINT;
