-- CreateEnum
CREATE TYPE "CreditEntryType" AS ENUM ('TOPUP', 'PURCHASE', 'REFUND');

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'CREDIT_TOPUP';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "creditBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CreditEntryType" NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "transactionId" TEXT,
    "contentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_transactionId_type_key" ON "CreditLedger"("transactionId", "type");

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
