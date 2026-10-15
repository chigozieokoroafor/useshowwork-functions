-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('DELIVERED', 'APPROVED', 'PAID');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'DELIVERED';
