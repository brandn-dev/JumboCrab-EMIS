# Schema normalization contract gate

`schema-normalization-contract.sql` is intentionally not an automatic Prisma migration.

Keep `ATTENDANCE_CONTEXT_LOG_DUAL_WRITE` unset or set to `true` during one complete attendance/payroll cycle after deploying the expand migration. New security context is stored on `Punch` and mirrored to the legacy table.

Before contract:

1. Export `AttendanceContextLog` as a recoverable backup.
2. Verify every legacy row has a unique `punchId` and matching context values on `Punch`.
3. Deploy with `ATTENDANCE_CONTEXT_LOG_DUAL_WRITE=false`.
4. Run the guarded contract SQL. It aborts before dropping anything when verification fails.
5. Remove ignored legacy fields/model from `prisma/schema.prisma` in the same contract release, then regenerate Prisma Client.

Never place the contract SQL under `prisma/migrations` before the monitoring gate passes; doing so would make `prisma migrate deploy` apply it automatically.
