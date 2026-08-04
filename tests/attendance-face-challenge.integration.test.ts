import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  AttendanceFaceChallengeStatus,
  CIVIL_STATUS,
  CURRENT_STATUS,
  EMPLOYMENT_STATUS,
  GENDER,
  PrismaClient,
  PUNCH_TYPE,
  Roles,
} from "@prisma/client";

const connectionString = process.env.ATTENDANCE_SECURITY_TEST_DATABASE_URL;

test(
  "two concurrent challenge claims can commit only one punch",
  { skip: !connectionString },
  async () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
    });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const userId = `security-user-${suffix}`;
    const employeeId = `security-employee-${suffix}`;
    try {
      await prisma.user.create({
        data: {
          userId,
          username: `security-${suffix}`,
          email: `security-${suffix}@example.invalid`,
          password: "not-used",
          salt: "not-used",
          role: Roles.Employee,
        },
      });
      await prisma.employee.create({
        data: {
          employeeId,
          employeeCode: `SEC-${suffix}`,
          firstName: "Security",
          lastName: "Test",
          sex: GENDER.MALE,
          civilStatus: CIVIL_STATUS.SINGLE,
          birthdate: new Date("1990-01-01T00:00:00.000Z"),
          startDate: new Date("2020-01-01T00:00:00.000Z"),
          employmentStatus: EMPLOYMENT_STATUS.REGULAR,
          currentStatus: CURRENT_STATUS.ACTIVE,
          userId,
        },
      });
      const challenge = await prisma.attendanceFaceChallenge.create({
        data: {
          employeeId,
          kioskId: "TEST-KIOSK",
          kioskBindingHash: `binding-${suffix}`,
          nonceHash: `nonce-${suffix}`,
          actions: ["BLINK", "TURN_LEFT"],
          expectedPunchType: PUNCH_TYPE.TIME_IN,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const tokenHash = `token-${suffix}`;
      await prisma.attendanceQrRedemption.create({
        data: {
          tokenHash,
          employeeId,
          challengeId: challenge.id,
          kioskBindingHash: `binding-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const claims = await Promise.all(
        [1, 2].map(() =>
          prisma.attendanceFaceChallenge.updateMany({
            where: {
              id: challenge.id,
              status: AttendanceFaceChallengeStatus.PENDING,
            },
            data: {
              status: AttendanceFaceChallengeStatus.PROCESSING,
              processingStartedAt: new Date(),
            },
          }),
        ),
      );
      assert.equal(claims.reduce((total, claim) => total + claim.count, 0), 1);

      await prisma.$transaction(async (tx) => {
        const current = await tx.attendanceFaceChallenge.findUniqueOrThrow({
          where: { id: challenge.id },
        });
        assert.equal(current.status, AttendanceFaceChallengeStatus.PROCESSING);
        const punch = await tx.punch.create({
          data: {
            employeeId,
            punchType: PUNCH_TYPE.TIME_IN,
            punchTime: new Date(),
            source: "INTEGRATION_TEST",
          },
        });
        await tx.attendanceFaceChallenge.update({
          where: { id: challenge.id },
          data: {
            status: AttendanceFaceChallengeStatus.PASSED,
            usedAt: new Date(),
            punchId: punch.id,
          },
        });
        await tx.attendanceQrRedemption.update({
          where: { tokenHash },
          data: { usedAt: new Date(), punchId: punch.id },
        });
      });

      assert.equal(await prisma.punch.count({ where: { employeeId } }), 1);
      const consumed = await prisma.attendanceFaceChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
        include: { qrRedemption: true },
      });
      assert.equal(consumed.status, AttendanceFaceChallengeStatus.PASSED);
      assert.ok(consumed.punchId);
      assert.ok(consumed.qrRedemption?.usedAt);
    } finally {
      await prisma.employee.deleteMany({ where: { employeeId } });
      await prisma.user.deleteMany({ where: { userId } });
      await prisma.$disconnect();
    }
  },
);
