-- CreateEnum
CREATE TYPE "CalendarRole" AS ENUM ('VIEW_ONLY', 'ADD_CONTENT', 'EDIT_CALENDAR');

-- AlterTable
ALTER TABLE "CalendarCollaborator" ADD COLUMN     "role" "CalendarRole" NOT NULL DEFAULT 'ADD_CONTENT';

-- AlterTable
ALTER TABLE "CalendarInvite" ADD COLUMN     "role" "CalendarRole" NOT NULL DEFAULT 'ADD_CONTENT';
