import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAttendanceWorkdayWindow,
  getTimeInRestriction,
  isActiveOvernightCarryover,
  normalizeScheduledEndMinutes,
} from "../src/lib/attendance-workday";

const august4ManilaStart = new Date("2026-08-03T16:00:00.000Z");
const graveyardShift = {
  startMinutes: 22 * 60,
  endMinutes: 7 * 60,
  spansMidnight: true,
};

test("overnight shift end is normalized onto next calendar day", () => {
  assert.equal(normalizeScheduledEndMinutes(graveyardShift), 31 * 60);
  assert.equal(
    normalizeScheduledEndMinutes({ ...graveyardShift, spansMidnight: false }),
    7 * 60,
  );
});

test("10:35 PM can clock in for a 10 PM to 7 AM shift", () => {
  const window = buildAttendanceWorkdayWindow(
    august4ManilaStart,
    graveyardShift,
  );
  const tenThirtyFivePmManila = new Date("2026-08-04T14:35:00.000Z");

  assert.equal(window.normalizedEndMinutes, 31 * 60);
  assert.equal(getTimeInRestriction(window, tenThirtyFivePmManila), null);
});

test("after-midnight punches stay attached to prior overnight workday", () => {
  const window = buildAttendanceWorkdayWindow(
    august4ManilaStart,
    graveyardShift,
  );
  const oneAmManilaNextDay = new Date("2026-08-04T17:00:00.000Z");
  const eightOhOneAmManilaNextDay = new Date("2026-08-05T00:01:00.000Z");

  assert.equal(isActiveOvernightCarryover(window, oneAmManilaNextDay), true);
  assert.equal(
    isActiveOvernightCarryover(window, eightOhOneAmManilaNextDay),
    false,
  );
});

test("overnight time-in is rejected only after next-day scheduled end", () => {
  const window = buildAttendanceWorkdayWindow(
    august4ManilaStart,
    graveyardShift,
  );
  const sevenOhOneAmManilaNextDay = new Date("2026-08-04T23:01:00.000Z");

  assert.equal(
    getTimeInRestriction(window, sevenOhOneAmManilaNextDay),
    "too_late",
  );
});

test("ordinary daytime shift keeps same-day boundaries", () => {
  const window = buildAttendanceWorkdayWindow(august4ManilaStart, {
    startMinutes: 9 * 60,
    endMinutes: 18 * 60,
    spansMidnight: false,
  });
  const tenThirtyFivePmManila = new Date("2026-08-04T14:35:00.000Z");

  assert.equal(window.normalizedEndMinutes, 18 * 60);
  assert.equal(
    getTimeInRestriction(window, tenThirtyFivePmManila),
    "too_late",
  );
});
