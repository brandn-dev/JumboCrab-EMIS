UPDATE "User"
SET "role" = 'Manager'
WHERE "role" = 'Clerk';

CREATE TYPE "Roles_new" AS ENUM (
  'Admin',
  'GeneralManager',
  'Manager',
  'Supervisor',
  'Employee'
);

ALTER TABLE "User"
ALTER COLUMN "role" TYPE "Roles_new"
USING ("role"::text::"Roles_new");

ALTER TYPE "Roles" RENAME TO "Roles_old";
ALTER TYPE "Roles_new" RENAME TO "Roles";

DROP TYPE "Roles_old";
