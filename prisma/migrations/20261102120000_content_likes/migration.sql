-- CreateTable
-- Additive: "loves" on gallery posts.
CREATE TABLE "ContentLike" (
    "userId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentLike_pkey" PRIMARY KEY ("userId","contentId")
);

-- CreateIndex
CREATE INDEX "ContentLike_contentId_idx" ON "ContentLike"("contentId");

-- AddForeignKey
ALTER TABLE "ContentLike" ADD CONSTRAINT "ContentLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentLike" ADD CONSTRAINT "ContentLike_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "MediaContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
