-- CreateTable
CREATE TABLE "PortfolioTestimonial" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientRole" TEXT,
    "quote" TEXT NOT NULL,
    "rating" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioTestimonial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortfolioTestimonial_portfolioId_idx" ON "PortfolioTestimonial"("portfolioId");

-- AddForeignKey
ALTER TABLE "PortfolioTestimonial" ADD CONSTRAINT "PortfolioTestimonial_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
