-- Add OFF_CYCLE as a first-class payroll type.
ALTER TYPE "PayrollType" ADD VALUE IF NOT EXISTS 'OFF_CYCLE';
