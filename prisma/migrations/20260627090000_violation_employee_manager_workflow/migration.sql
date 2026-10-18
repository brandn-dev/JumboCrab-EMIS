DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'EmployeeViolationStatus'
      AND e.enumlabel = 'PENDING_EMPLOYEE'
  ) THEN
    ALTER TYPE "EmployeeViolationStatus" ADD VALUE 'PENDING_EMPLOYEE' BEFORE 'DRAFT';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'EmployeeViolationStatus'
      AND e.enumlabel = 'PENDING_MANAGER_REVIEW'
  ) THEN
    ALTER TYPE "EmployeeViolationStatus" ADD VALUE 'PENDING_MANAGER_REVIEW' BEFORE 'DRAFT';
  END IF;
END $$;
