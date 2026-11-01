-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'VIDEO';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "viewOnce" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "viewedAt" TIMESTAMP(3);
