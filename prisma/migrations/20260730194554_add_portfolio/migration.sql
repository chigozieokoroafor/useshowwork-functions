-- DropForeignKey
ALTER TABLE "Media" DROP CONSTRAINT "Media_sectionId_fkey";

-- CreateTable
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "heroTagline" TEXT,
    "heroMediaId" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "bgColor" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "creatorId" TEXT NOT NULL,

    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSection" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioMedia" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "sectionId" TEXT,
    "type" "MediaType" NOT NULL,
    "fileKey" TEXT NOT NULL,
    "caption" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Portfolio_slug_key" ON "Portfolio"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Portfolio_creatorId_key" ON "Portfolio"("creatorId");

-- CreateIndex
CREATE INDEX "PortfolioSection_portfolioId_idx" ON "PortfolioSection"("portfolioId");

-- CreateIndex
CREATE INDEX "PortfolioMedia_portfolioId_idx" ON "PortfolioMedia"("portfolioId");

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "MediaSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Portfolio" ADD CONSTRAINT "Portfolio_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSection" ADD CONSTRAINT "PortfolioSection_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioMedia" ADD CONSTRAINT "PortfolioMedia_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioMedia" ADD CONSTRAINT "PortfolioMedia_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "PortfolioSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
