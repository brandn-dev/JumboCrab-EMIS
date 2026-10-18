DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ViolationResetFrequency'
      AND e.enumlabel = 'QUARTERLY'
  ) THEN
    ALTER TYPE "ViolationResetFrequency" ADD VALUE 'QUARTERLY';
  END IF;
END $$;
