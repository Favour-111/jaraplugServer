-- CreateTable
CREATE TABLE "DailyVisitor" (
    "day" TEXT NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyVisitor_pkey" PRIMARY KEY ("day","visitorHash")
);
