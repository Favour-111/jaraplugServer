-- AlterTable
-- Additive and backwards-compatible: every existing profile starts opted OUT of search-engine indexing.
ALTER TABLE "ProviderProfile" ADD COLUMN     "searchIndexingEnabled" BOOLEAN NOT NULL DEFAULT false;
