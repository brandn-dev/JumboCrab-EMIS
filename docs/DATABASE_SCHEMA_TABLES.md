# Database Schema — Simple Table View

Generated from `prisma/schema.prisma`. Contains 41 tables. Shows 598 of 650 stored fields.

> Prisma relation helper fields are omitted because they are not stored columns. Foreign-key scalar fields remain and are marked `FK`. Optional fields are marked `nullable` in their descriptions.
>
> Redundant snapshot value columns are intentionally hidden from this documentation. Snapshot identifier columns (`*IdSnapshot`) remain visible. Hidden columns still exist in the database and Prisma schema.

## Table index

- [User](#user)
- [Notification](#notification)
- [UserNotification](#usernotification)
- [Employee](#employee)
- [Department](#department)
- [Position](#position)
- [GovernmentId](#governmentid)
- [ContributionBracketVersion](#contributionbracketversion)
- [ContributionBracket](#contributionbracket)
- [PositionRateHistory](#positionratehistory)
- [EmployeePositionHistory](#employeepositionhistory)
- [Shift](#shift)
- [WeeklySchedule](#weeklyschedule)
- [EmployeeShiftOverride](#employeeshiftoverride)
- [Attendance](#attendance)
- [Punch](#punch)
- [AttendanceSecuritySetting](#attendancesecuritysetting)
- [EmployeeFaceEnrollment](#employeefaceenrollment)
- [FaceVerificationAttempt](#faceverificationattempt)
- [AttendanceContextLog](#attendancecontextlog)
- [EmployeeViolation](#employeeviolation)
- [Violation](#violation)
- [EmployeeViolationReset](#employeeviolationreset)
- [ViolationAutoResetPolicy](#violationautoresetpolicy)
- [DeductionType](#deductiontype)
- [EmployeeDeductionAssignment](#employeedeductionassignment)
- [CashAdvanceRequest](#cashadvancerequest)
- [GovernmentLoanAssistanceRequest](#governmentloanassistancerequest)
- [SilEncashmentRequest](#silencashmentrequest)
- [LeaveRequest](#leaverequest)
- [LeaveCreditPolicy](#leavecreditpolicy)
- [LeaveCreditResetRun](#leavecreditresetrun)
- [EmployeeLeaveCreditLedger](#employeeleavecreditledger)
- [DayOffRequest](#dayoffrequest)
- [ScheduleChangeRequest](#schedulechangerequest)
- [ScheduleSwapRequest](#scheduleswaprequest)
- [EmployeeDeductionPayment](#employeedeductionpayment)
- [Payroll](#payroll)
- [PayrollEmployee](#payrollemployee)
- [PayrollEarning](#payrollearning)
- [PayrollDeduction](#payrolldeduction)

## User

This table stores application user accounts, including sign-in credentials, assigned roles, account status, password controls, and the optional link to an employee profile.

| Field | Data Type | Description |
|---|---|---|
| `userId (PK)` | STRING | Unique identifier for user record. (default: cuid()) |
| `username (UNIQUE)` | STRING | Sign-in username. |
| `email (UNIQUE)` | STRING | Email address. |
| `password` | STRING | Hashed password. |
| `salt` | STRING | Password-hashing salt. |
| `role` | ENUM (`Roles`) | Assigned application role. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |
| `isDisabled` | BOOLEAN | Whether account is disabled. Default: false. |
| `mustChangePassword` | BOOLEAN | Whether password change is required at next sign-in. Default: false. |
| `passwordChangedAt` | DATETIME | Date and time password was last changed. Nullable. |
| `employeeProfileId (FK, UNIQUE)` | STRING | References Employee.employeeId. Nullable. |

## Notification

This table stores system-generated notifications, including the event type, module, message, severity, related entity information, email eligibility, and creation details.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for notification record. (default: cuid()) |
| `eventType` | ENUM (`NotificationEventType`) | Selected event type. |
| `module` | ENUM (`NotificationModule`) | Module value. |
| `title` | STRING | Title value. |
| `message` | STRING | Message value. |
| `severity` | ENUM (`NotificationSeverity`) | Severity value. Default: INFO. |
| `actorUserId (FK)` | STRING | References User.userId. Nullable. |
| `entityType` | STRING | Entity type value. Nullable. |
| `entityId` | STRING | Entity id value. Nullable. |
| `linkHref` | STRING | Link href value. |
| `metadata` | JSON | Metadata value. Nullable. |
| `emailEligible` | BOOLEAN | Whether email eligible. Default: false. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## UserNotification

This table links notifications to individual users and tracks whether each notification has been read, archived, or emailed, including its email delivery status and any error details.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for user notification record. (default: cuid()) |
| `notificationId (FK, part of UNIQUE: notificationId + userId)` | STRING | References Notification.id. Part of unique constraint (notificationId, userId). |
| `userId (FK, part of UNIQUE: notificationId + userId)` | STRING | References User.userId. Part of unique constraint (notificationId, userId). |
| `readAt` | DATETIME | Date and time for read. Nullable. |
| `archivedAt` | DATETIME | Date and time for archived. Nullable. |
| `emailedAt` | DATETIME | Date and time for emailed. Nullable. |
| `emailStatus` | ENUM (`NotificationEmailStatus`) | Selected email status. Default: PENDING. |
| `emailError` | STRING | Email error value. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## Employee

This table stores the main employee profile, including personal information, contact and emergency details, employment dates and status, organizational assignment, supervisor, and linked user account.

| Field | Data Type | Description |
|---|---|---|
| `employeeId (PK)` | STRING | Unique identifier for employee record. (default: cuid()) |
| `employeeCode (UNIQUE)` | STRING | Company-issued employee code. |
| `firstName` | STRING | Employee's first name. |
| `lastName` | STRING | Employee's last name. |
| `middleName` | STRING | Employee's middle name. Nullable. |
| `suffix` | ENUM (`SUFFIX`) | Name suffix (for example, Jr., Sr., or III). Nullable. |
| `sex` | ENUM (`GENDER`) | Employee's sex. |
| `civilStatus` | ENUM (`CIVIL_STATUS`) | Employee's civil status. |
| `nationality` | STRING | Employee's nationality. Nullable. |
| `birthdate` | DATETIME | Employee's date of birth. |
| `address` | STRING | Street address. Nullable. |
| `city` | STRING | City or municipality. Nullable. |
| `state` | STRING | State or province. Nullable. |
| `postalCode` | STRING | ZIP or postal code. Nullable. |
| `country` | STRING | Country. Nullable. |
| `img` | STRING | Img value. Nullable. |
| `startDate` | DATETIME | Start date. |
| `isEnded` | BOOLEAN | Whether it has ended. Nullable. Default: false. |
| `endDate` | DATETIME | End date. Nullable. |
| `employmentStatus` | ENUM (`EMPLOYMENT_STATUS`) | Selected employment status. |
| `currentStatus` | ENUM (`CURRENT_STATUS`) | Selected current status. |
| `email` | STRING | Email address. Nullable. |
| `phone` | STRING | Phone number. Nullable. |
| `emergencyContactName` | STRING | Emergency contact name value. Nullable. |
| `emergencyContactRelationship` | STRING | Emergency contact relationship value. Nullable. |
| `emergencyContactPhone` | STRING | Emergency contact phone value. Nullable. |
| `emergencyContactEmail` | STRING | Emergency contact email value. Nullable. |
| `description` | STRING | Descriptive details. Nullable. |
| `isArchived` | BOOLEAN | Whether archived. Default: false. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |
| `userId (FK, UNIQUE)` | STRING | References User.userId. Nullable. |
| `departmentId (FK)` | STRING | References Department.departmentId. Nullable. |
| `positionId (FK)` | STRING | References Position.positionId. Nullable. |
| `supervisorUserId (FK)` | STRING | References User.userId. Nullable. |

## Department

This table stores the organization’s departments, including each department name, description, active status, and record creation and update dates.

| Field | Data Type | Description |
|---|---|---|
| `departmentId (PK)` | STRING | Unique identifier for department record. (default: cuid()) |
| `name (UNIQUE)` | STRING | Name value. |
| `description` | STRING | Descriptive details. Nullable. |
| `isActive` | BOOLEAN | Whether record is active. Default: true. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## Position

This table stores job positions within departments, including position names, descriptions, daily, hourly, and monthly pay rates, currency, and active status.

| Field | Data Type | Description |
|---|---|---|
| `positionId (PK)` | STRING | Unique identifier for position record. (default: cuid()) |
| `name (part of UNIQUE: name + departmentId)` | STRING | Name value. Part of unique constraint (name, departmentId). |
| `description` | STRING | Descriptive details. Nullable. |
| `dailyRate` | DECIMAL | Daily rate rate or percentage. Nullable. |
| `hourlyRate` | DECIMAL | Hourly rate rate or percentage. Nullable. |
| `monthlyRate` | DECIMAL | Monthly rate rate or percentage. Nullable. |
| `currencyCode` | STRING | Currency code value. Default: "PHP". |
| `isActive` | BOOLEAN | Whether record is active. Default: true. |
| `departmentId (FK, part of UNIQUE: name + departmentId)` | STRING | References Department.departmentId. Part of unique constraint (name, departmentId). |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## GovernmentId

This table stores an employee’s government identification numbers and controls whether SSS, PhilHealth, Pag-IBIG, and withholding tax are included in payroll processing.

| Field | Data Type | Description |
|---|---|---|
| `governmentId (PK)` | STRING | Unique identifier for government id record. (default: cuid()) |
| `sssNumber` | STRING | Sss number value. Nullable. |
| `isSssIncludedInPayroll` | BOOLEAN | Whether sss included in payroll. Default: true. |
| `philHealthNumber` | STRING | Phil health number value. Nullable. |
| `isPhilHealthIncludedInPayroll` | BOOLEAN | Whether phil health included in payroll. Default: true. |
| `tinNumber` | STRING | Tin number value. Nullable. |
| `isWithholdingIncludedInPayroll` | BOOLEAN | Whether withholding included in payroll. Default: true. |
| `pagIbigNumber` | STRING | Pag ibig number value. Nullable. |
| `isPagIbigIncludedInPayroll` | BOOLEAN | Whether pag ibig included in payroll. Default: true. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |
| `employeeId (FK, UNIQUE)` | STRING | References Employee.employeeId. |

## ContributionBracketVersion

This table stores version records for government contribution and tax brackets, including contribution type, payroll frequency, effective dates, reference codes, and the reason for each change.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for contribution bracket version record. (default: cuid()) |
| `contributionType` | ENUM (`ContributionType`) | Selected contribution type. |
| `payrollFrequency` | ENUM (`PayrollFrequency`) | Selected payroll frequency. Nullable. |
| `effectiveFrom` | DATETIME | Date and time value becomes effective. |
| `effectiveTo` | DATETIME | Date and time value stops being effective. Nullable. |
| `referenceCode` | STRING | Reference code value. Nullable. |
| `changeReason` | STRING | Change reason value. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## ContributionBracket

This table stores the detailed rules used to calculate government contributions and withholding tax, including salary bounds, fixed amounts, rates, tax values, effective dates, and related metadata.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for contribution bracket record. (default: cuid()) |
| `versionId (FK)` | STRING | References ContributionBracketVersion.id. Nullable. |
| `contributionType` | ENUM (`ContributionType`) | Selected contribution type. |
| `calculationMethod` | ENUM (`ContributionCalculationMethod`) | Selected calculation method. |
| `baseKind` | ENUM (`ContributionBaseKind`) | Selected base kind. |
| `payrollFrequency` | ENUM (`PayrollFrequency`) | Selected payroll frequency. Nullable. |
| `lowerBound` | DECIMAL | Lower bound value. |
| `upperBound` | DECIMAL | Upper bound value. Nullable. |
| `employeeFixedAmount` | DECIMAL | Employee fixed amount monetary value. Nullable. |
| `employerFixedAmount` | DECIMAL | Employer fixed amount monetary value. Nullable. |
| `employeeRate` | DECIMAL | Employee rate rate or percentage. Nullable. |
| `employerRate` | DECIMAL | Employer rate rate or percentage. Nullable. |
| `baseTax` | DECIMAL | Base tax value. Nullable. |
| `marginalRate` | DECIMAL | Marginal rate rate or percentage. Nullable. |
| `effectiveFrom` | DATETIME | Date and time value becomes effective. |
| `effectiveTo` | DATETIME | Date and time value stops being effective. Nullable. |
| `referenceCode` | STRING | Reference code value. Nullable. |
| `metadata` | JSON | Structured metadata. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## PositionRateHistory

This table stores historical changes to a position’s daily, hourly, and monthly pay rates, including effective dates, reasons, metadata, and the user who created the change.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for position rate history record. (default: cuid()) |
| `positionId (FK, part of UNIQUE: positionId + effectiveFrom)` | STRING | References Position.positionId. Part of unique constraint (positionId, effectiveFrom). |
| `dailyRate` | DECIMAL | Daily rate rate or percentage. Nullable. |
| `hourlyRate` | DECIMAL | Hourly rate rate or percentage. Nullable. |
| `monthlyRate` | DECIMAL | Monthly rate rate or percentage. Nullable. |
| `currencyCode` | STRING | Currency code value. Default: "PHP". |
| `effectiveFrom (part of UNIQUE: positionId + effectiveFrom)` | DATETIME | Date and time value becomes effective. Part of unique constraint (positionId, effectiveFrom). |
| `effectiveTo` | DATETIME | Date and time value stops being effective. Nullable. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `metadata` | JSON | Metadata value. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## EmployeePositionHistory

This table stores an employee’s department and position assignment history, including effective dates, reasons, metadata, and the user responsible for recording the change.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for employee position history record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `departmentId (FK)` | STRING | References Department.departmentId. Nullable. |
| `positionId (FK)` | STRING | References Position.positionId. Nullable. |
| `effectiveFrom` | DATETIME | Date and time value becomes effective. (default: now()) |
| `effectiveTo` | DATETIME | Date and time value stops being effective. Nullable. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `metadata` | JSON | Structured metadata. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## Shift

This table stores reusable work-shift definitions, including shift codes, start and end times, break schedules, paid hours, overnight status, day-off designation, and active status.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | INTEGER | Unique identifier for shift record. (default: autoincrement()) |
| `code (UNIQUE)` | STRING | Code value. |
| `name` | STRING | Name value. |
| `colorHex` | STRING | Color hex value. Nullable. |
| `isDayOff` | BOOLEAN | Whether it's a day off. Default: false. |
| `startMinutes` | INTEGER | Start minutes value. |
| `endMinutes` | INTEGER | End minutes value. |
| `spansMidnight` | BOOLEAN | Whether it spans midnight. Default: false. |
| `breakStartMinutes` | INTEGER | Break start minutes value. Nullable. |
| `breakEndMinutes` | INTEGER | Break end minutes value. Nullable. |
| `breakMinutesUnpaid` | INTEGER | Break minutes unpaid value. Default: 0. |
| `paidHoursPerDay` | DECIMAL | Paid hours per day value. |
| `isActive` | BOOLEAN | Whether the record is active. Default: true. |
| `notes` | STRING | Additional notes. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## WeeklySchedule

This table stores an employee’s assigned shifts for each day of a specific workweek, from Monday through Sunday, together with creation and update timestamps.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for weekly schedule record. (default: cuid()) |
| `employeeId (FK, part of UNIQUE: employeeId + weekStart)` | STRING | References Employee.employeeId. Part of unique constraint (employeeId, weekStart). |
| `weekStart (part of UNIQUE: employeeId + weekStart)` | DATETIME | Week start value. Part of unique constraint (employeeId, weekStart). |
| `monShiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `tueShiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `wedShiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `thuShiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `friShiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `satShiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `sunShiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## EmployeeShiftOverride

This table stores date-specific schedule overrides for employees, including the replacement shift, source of the override, notes, and record timestamps.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for employee shift override record. (default: cuid()) |
| `employeeId (FK, part of UNIQUE: employeeId + workDate)` | STRING | References Employee.employeeId. Part of unique constraint (employeeId, workDate). |
| `workDate (part of UNIQUE: employeeId + workDate)` | DATETIME | Work date. Part of unique constraint (employeeId, workDate). |
| `shiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `source` | STRING | Source value. |
| `note` | STRING | Note value. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## Attendance

This table stores an employee’s daily attendance summary, including the expected shift, actual time in and out, worked and break minutes, lateness, undertime, overtime, night work, leave status, and payroll links.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for attendance record. (default: cuid()) |
| `employeeId (FK, part of UNIQUE: employeeId + workDate)` | STRING | References Employee.employeeId. Part of unique constraint (employeeId, workDate). |
| `workDate (part of UNIQUE: employeeId + workDate)` | DATETIME | Work date. Part of unique constraint (employeeId, workDate). |
| `status` | ENUM (`ATTENDANCE_STATUS`) | Current workflow status. |
| `isPaidLeave` | BOOLEAN | Whether paid leave. Default: false. |
| `leaveRequestId (FK)` | STRING | References LeaveRequest.id. Nullable. |
| `expectedShiftId (FK)` | INTEGER | References Shift.id. Nullable. |
| `scheduledStartMinutes` | INTEGER | Scheduled start minutes value. Nullable. |
| `scheduledEndMinutes` | INTEGER | Scheduled end minutes value. Nullable. |
| `paidHoursPerDay` | DECIMAL | Paid hours per day value. Nullable. |
| `actualInAt` | DATETIME | Date and time for actual in. Nullable. |
| `actualOutAt` | DATETIME | Date and time for actual out. Nullable. |
| `workedMinutes` | INTEGER | Worked minutes value. Nullable. |
| `breakMinutes` | INTEGER | Break minutes value. Default: 0. |
| `deductedBreakMinutes` | INTEGER | Deducted break minutes value. Default: 0. |
| `netWorkedMinutes` | INTEGER | Net worked minutes value. Nullable. |
| `breakCount` | INTEGER | Break count value. Default: 0. |
| `lateMinutes` | INTEGER | Late minutes value. Default: 0. |
| `undertimeMinutes` | INTEGER | Undertime minutes value. Default: 0. |
| `overtimeMinutesRaw` | INTEGER | Overtime minutes raw value. Default: 0. |
| `overtimeMinutesApproved` | INTEGER | Overtime minutes approved value. Default: 0. |
| `nightMinutes` | INTEGER | Night minutes value. Default: 0. |
| `isLocked` | BOOLEAN | Whether locked. Default: false. |
| `payrollPeriodId (FK)` | STRING | References Payroll.payrollId. Nullable. |
| `payrollEmployeeId (FK)` | STRING | References PayrollEmployee.id. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## Punch

This table stores individual attendance punches, such as time in, time out, break start, and break end, together with the employee, attendance record, timestamp, and punch source.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for punch record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `attendanceId (FK)` | STRING | References Attendance.id. Nullable. |
| `punchTime` | DATETIME | Punch time value. |
| `punchType` | ENUM (`PUNCH_TYPE`) | Selected punch type. |
| `source` | STRING | Source value. Nullable. |
| `ipAddress` | STRING | Ip address value. Nullable. |
| `userAgent` | STRING | User agent value. Nullable. |
| `latitude` | DECIMAL | Latitude value. Nullable. |
| `longitude` | DECIMAL | Longitude value. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## AttendanceSecuritySetting

This table stores the system-wide security settings used for attendance punching, including GPS validation, QR and face-recognition requirements, liveness checks, match thresholds, and failure behavior.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for attendance security setting record. Default: "default". |
| `gpsValidationEnabled` | BOOLEAN | Whether gps validation enabled. Default: false. |
| `attendancePunchMode` | STRING | Selected attendance punch mode. Default: "QR_ONLY". |
| `faceRecognitionEnabled` | BOOLEAN | Whether face recognition enabled. Default: false. |
| `faceRequiredForQrPunch` | BOOLEAN | Whether face required for qr punch. Default: false. |
| `faceLivenessRequired` | BOOLEAN | Whether face liveness required. Default: true. |
| `faceMatchMaxDistance` | DECIMAL | Face match max distance value. Default: 0.35. |
| `faceFailureMode` | STRING | Selected face failure mode. Default: "BLOCK". |
| `updatedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## EmployeeFaceEnrollment

This table stores an employee’s face-recognition enrollment data, including the biometric embedding, sample count, model version, consent details, enrollment and revocation information, and active status.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for employee face enrollment record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `embedding` | BYTES | Embedding value. |
| `sampleCount` | INTEGER | Sample count value. Default: 0. |
| `modelVersion` | STRING | Model version value. |
| `consentText` | STRING | Consent text value. Nullable. |
| `consentedAt` | DATETIME | Date and time for consented. Nullable. |
| `enrolledByUserId (FK)` | STRING | References User.userId. Nullable. |
| `revokedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `revokedAt` | DATETIME | Date and time for revoked. Nullable. |
| `revokeReason` | STRING | Revoke reason value. Nullable. |
| `isActive` | BOOLEAN | Whether record is active. Default: true. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## FaceVerificationAttempt

This table stores each face-verification attempt made during attendance punching, including status, match distance, threshold, liveness result, kiosk details, model information, latency, and diagnostic data.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for face verification attempt record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `attendanceId (FK)` | STRING | References Attendance.id. Nullable. |
| `punchId (FK)` | STRING | References Punch.id. Nullable. |
| `kioskId` | STRING | Kiosk id value. Nullable. |
| `kioskNonce` | STRING | Kiosk nonce value. Nullable. |
| `punchType` | ENUM (`PUNCH_TYPE`) | Selected punch type. Nullable. |
| `status` | STRING | Current workflow status. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `distance` | DECIMAL | Distance value. Nullable. |
| `threshold` | DECIMAL | Threshold value. Nullable. |
| `livenessPassed` | BOOLEAN | Whether liveness passed. Nullable. |
| `livenessPrompt` | STRING | Liveness prompt value. Nullable. |
| `faceCount` | INTEGER | Face count value. Nullable. |
| `modelVersion` | STRING | Model version value. Nullable. |
| `serviceLatencyMs` | INTEGER | Service latency ms value. Nullable. |
| `details` | JSON | Details value. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## AttendanceContextLog

This table stores contextual information captured with an attendance action, including the employee, attendance record, IP address, user agent, GPS coordinates, and creation time.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for attendance context log record. (default: cuid()) |
| `punchId (UNIQUE)` | STRING | Punch id value. Nullable. |
| `attendanceId` | STRING | References Attendance.id. |
| `employeeId` | STRING | References Employee.employeeId. |
| `ipAddress` | STRING | Ip address value. Nullable. |
| `userAgent` | STRING | User agent value. Nullable. |
| `latitude` | DECIMAL | Latitude value. Nullable. |
| `longitude` | DECIMAL | Longitude value. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## EmployeeViolation

This table stores violations assigned to employees, including the violation date, strike points, workflow status, acknowledgment and appeal tracking, review details, remarks, and voiding information.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for employee violation record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `violationId (FK)` | STRING | References Violation.violationId. |
| `violationDate` | DATETIME | Violation date. |
| `status` | ENUM (`EmployeeViolationStatus`) | Current workflow status. Default: DRAFT. |
| `draftedById (FK)` | STRING | References User.userId. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. Nullable. |
| `reviewedById (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `reviewRemarks` | STRING | Review remarks value. Nullable. |
| `isAcknowledged` | BOOLEAN | Whether acknowledged. Default: false. |
| `acknowledgedAt` | DATETIME | Date and time for acknowledged. Nullable. |
| `appealPaperSecuredAt` | DATETIME | Date and time for appeal paper secured. Nullable. |
| `appealPaperFilledAt` | DATETIME | Date and time for appeal paper filled. Nullable. |
| `appealPaperSubmittedToManagerAt` | DATETIME | Date and time for appeal paper submitted to manager. Nullable. |
| `appealSubmittedAt` | DATETIME | Date and time for appeal submitted. Nullable. |
| `remarks` | STRING | Additional remarks. Nullable. |
| `isCountedForStrike` | BOOLEAN | Whether counted for strike. Default: true. |
| `voidedAt` | DATETIME | Date and time for voided. Nullable. |
| `voidReason` | STRING | Void reason value. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## Violation

This table stores the master list of violation types, including their names, descriptions, default strike points, maximum strikes per employee, active status, and record timestamps.

| Field | Data Type | Description |
|---|---|---|
| `violationId (PK)` | STRING | Unique identifier for violation record. (default: cuid()) |
| `name` | STRING | Name value. |
| `description` | STRING | Descriptive details. |
| `defaultStrikePoints` | INTEGER | Default strike points value. Default: 1. |
| `maxStrikesPerEmployee` | INTEGER | Max strikes per employee value. Default: 3. |
| `isActive` | BOOLEAN | Whether record is active. Default: true. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. (default: now()) |

## EmployeeViolationReset

This table stores manual or policy-based resets of employee violation records, including the employee, optional violation type, effective date, reason, policy reference, and responsible user.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for employee violation reset record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `violationId (FK)` | STRING | References Violation.violationId. Nullable. |
| `effectiveFrom` | DATETIME | Date and time value becomes effective. |
| `reason` | STRING | Reason for request or action. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `autoPolicyId (FK)` | STRING | References ViolationAutoResetPolicy.id. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## ViolationAutoResetPolicy

This table stores automated violation-reset policies, including reset frequency, schedule, scope, next and last run dates, reason templates, and whether the policy applies to all or selected employees and violations.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for violation auto reset policy record. (default: cuid()) |
| `name` | STRING | Name value. Nullable. |
| `frequency` | ENUM (`ViolationResetFrequency`) | Frequency value. |
| `dayOfMonth` | INTEGER | Day of month value. Default: 1. |
| `monthOfYear` | INTEGER | Month of year value. Nullable. |
| `effectiveFrom` | DATETIME | Date and time value becomes effective. (default: now()) |
| `nextRunAt` | DATETIME | Date and time for next run. |
| `lastRunAt` | DATETIME | Date and time for last run. Nullable. |
| `reasonTemplate` | STRING | Reason template value. Nullable. |
| `appliesToAllEmployees` | BOOLEAN | Applies to all employees value. Default: true. |
| `employeeId (FK)` | STRING | References Employee.employeeId. Nullable. |
| `violationId (FK)` | STRING | References Violation.violationId. Nullable. |
| `isActive` | BOOLEAN | Whether record is active. Default: true. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## DeductionType

This table stores reusable payroll deduction definitions, including the deduction code, name, amount calculation mode, frequency, default fixed or percentage value, active status, and responsible users.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for deduction type record. (default: cuid()) |
| `code (UNIQUE)` | STRING | Code value. |
| `name` | STRING | Name value. |
| `description` | STRING | Descriptive details. Nullable. |
| `amountMode` | ENUM (`DeductionAmountMode`) | Selected amount mode. |
| `frequency` | ENUM (`DeductionFrequency`) | Frequency value. Default: PER_PAYROLL. |
| `defaultAmount` | DECIMAL | Default amount monetary value. Nullable. |
| `defaultPercent` | DECIMAL | Default percent rate or percentage. Nullable. |
| `isActive` | BOOLEAN | Whether record is active. Default: true. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `updatedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## EmployeeDeductionAssignment

This table stores information about how specific deductions are assigned to employees, including effective dates, custom amount or percentage overrides, installment terms, remaining balances, workflow status, review details, and responsible users.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for employee deduction assignment record. (default: cuid()) |
| `employeeId (FK, part of UNIQUE: employeeId + deductionTypeId + effectiveFrom)` | STRING | References Employee.employeeId. Part of unique constraint (employeeId, deductionTypeId, effectiveFrom). |
| `deductionTypeId (FK, part of UNIQUE: employeeId + deductionTypeId + effectiveFrom)` | STRING | References DeductionType.id. Part of unique constraint (employeeId, deductionTypeId, effectiveFrom). |
| `effectiveFrom (part of UNIQUE: employeeId + deductionTypeId + effectiveFrom)` | DATETIME | Date and time value becomes effective. Part of unique constraint (employeeId, deductionTypeId, effectiveFrom). |
| `effectiveTo` | DATETIME | Date and time value stops being effective. Nullable. |
| `amountOverride` | DECIMAL | Amount override value. Nullable. |
| `percentOverride` | DECIMAL | Percent override value. Nullable. |
| `installmentTotal` | DECIMAL | Installment total monetary value. Nullable. |
| `installmentPerPayroll` | DECIMAL | Installment per payroll value. Nullable. |
| `remainingBalance` | DECIMAL | Remaining balance monetary value. Nullable. |
| `workflowStatus` | ENUM (`EmployeeDeductionWorkflowStatus`) | Workflow status value. Default: APPROVED. |
| `status` | ENUM (`EmployeeDeductionAssignmentStatus`) | Current workflow status. Default: ACTIVE. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `assignedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `updatedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. Nullable. |
| `reviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `reviewRemarks` | STRING | Review remarks value. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## CashAdvanceRequest

This table stores employee cash-advance requests, including the requested amount, proposed repayment, preferred start date, approved terms, review status, manager remarks, and the resulting deduction assignment.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for cash advance request record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `amount` | DECIMAL | Monetary amount. |
| `repaymentPerPayroll` | DECIMAL | Repayment per payroll value. |
| `preferredStartDate` | DATETIME | Preferred start date. |
| `approvedAmount` | DECIMAL | Approved amount monetary value. Nullable. |
| `approvedDeductionMode` | ENUM (`CashAdvanceDeductionMode`) | Selected approved deduction mode. Nullable. |
| `approvedRepaymentPerPayroll` | DECIMAL | Approved repayment per payroll value. Nullable. |
| `approvedEffectiveFrom` | DATETIME | Approved effective from value. Nullable. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `status` | ENUM (`CashAdvanceRequestStatus`) | Current workflow status. Default: PENDING_MANAGER. |
| `managerRemarks` | STRING | Manager remarks value. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. (default: now()) |
| `reviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `deductionAssignmentId (FK, UNIQUE)` | STRING | References EmployeeDeductionAssignment.id. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## GovernmentLoanAssistanceRequest

This table stores employee requests for assistance with government loans, including the agency, requested amount, term, estimated deductions, government ID and salary snapshots, review status, approved terms, and related payroll deduction assignment.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for government loan assistance request record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `agency` | ENUM (`GovernmentLoanAgency`) | Agency value. |
| `requestedAmount` | DECIMAL | Requested amount monetary value. |
| `termMonths` | INTEGER | Term months value. |
| `estimatedMonthlyDeduction` | DECIMAL | Estimated monthly deduction value. |
| `estimatedPerPayrollDeduction` | DECIMAL | Estimated per payroll deduction value. |
| `governmentIdSnapshot` | STRING | Government id snapshot value. |
| `checklist` | JSON | Checklist value. Nullable. |
| `status` | ENUM (`GovernmentLoanAssistanceRequestStatus`) | Current workflow status. Default: PENDING_MANAGER_REVIEW. |
| `employeeRemarks` | STRING | Employee remarks value. Nullable. |
| `managerRemarks` | STRING | Manager remarks value. Nullable. |
| `agencyRemarks` | STRING | Agency remarks value. Nullable. |
| `approvedAmount` | DECIMAL | Approved amount monetary value. Nullable. |
| `approvedMonthlyPayment` | DECIMAL | Approved monthly payment value. Nullable. |
| `repaymentStartDate` | DATETIME | Repayment start date. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. (default: now()) |
| `reviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `finalizedAt` | DATETIME | Date and time for finalized. Nullable. |
| `deductionAssignmentId (FK, UNIQUE)` | STRING | References EmployeeDeductionAssignment.id. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## SilEncashmentRequest

This table stores employee requests to convert Service Incentive Leave credits into cash, including the number of days, workflow status, employee and manager remarks, review details, and the related leave-credit ledger entry.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for sil encashment request record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `days` | INTEGER | Days value. |
| `status` | ENUM (`LeaveRequestStatus`) | Current workflow status. Default: PENDING_MANAGER. |
| `employeeRemarks` | STRING | Employee remarks value. Nullable. |
| `managerRemarks` | STRING | Manager remarks value. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. (default: now()) |
| `reviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `ledgerEntryId (FK, UNIQUE)` | STRING | References EmployeeLeaveCreditLedger.id. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## LeaveRequest

This table stores employee leave requests, including leave type, requested start and end dates, reason, approval status, manager remarks, submission and review details, and record timestamps.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for leave request record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `leaveType` | ENUM (`LeaveRequestType`) | Selected leave type. |
| `startDate` | DATETIME | Start date. |
| `endDate` | DATETIME | End date. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `status` | ENUM (`LeaveRequestStatus`) | Current workflow status. Default: PENDING_MANAGER. |
| `managerRemarks` | STRING | Manager remarks value. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. (default: now()) |
| `reviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## LeaveCreditPolicy

This table stores leave-credit policies by leave type, including the annual credit allocation and the month and day when credits are reset.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for leave credit policy record. (default: cuid()) |
| `leaveType (UNIQUE)` | ENUM (`LeaveCreditType`) | Selected leave type. |
| `resetMonth` | INTEGER | Reset month value. Default: 1. |
| `resetDay` | INTEGER | Reset day value. Default: 1. |
| `annualCredits` | INTEGER | Annual credits value. Default: 5. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## LeaveCreditResetRun

This table stores each execution of a leave-credit reset policy, including the covered cycle, effective date, annual credits granted, number of affected employees, run type, notes, and initiating user.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for leave credit reset run record. (default: cuid()) |
| `policyId (FK)` | STRING | References LeaveCreditPolicy.id. |
| `leaveType` | ENUM (`LeaveCreditType`) | Selected leave type. |
| `cycleStartDate` | DATETIME | Cycle start date. |
| `cycleEndDate` | DATETIME | Cycle end date. |
| `effectiveDate` | DATETIME | Date value becomes effective. |
| `annualCredits` | INTEGER | Annual credits value. |
| `employeeCount` | INTEGER | Employee count value. Default: 0. |
| `runType` | ENUM (`LeaveCreditResetRunType`) | Selected run type. Default: MANUAL. |
| `notes` | STRING | Additional notes. Nullable. |
| `initiatedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## EmployeeLeaveCreditLedger

This table stores the transaction history of employee leave credits, including credit or debit type, amount, balances before and after, effective and cycle dates, related requests or reset runs, notes, and responsible user.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for employee leave credit ledger record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `leaveType` | ENUM (`LeaveCreditType`) | Selected leave type. |
| `entryType` | ENUM (`LeaveCreditLedgerEntryType`) | Selected entry type. |
| `amount` | INTEGER | Monetary amount. |
| `balanceBefore` | INTEGER | Balance before value. |
| `balanceAfter` | INTEGER | Balance after value. |
| `effectiveDate` | DATETIME | Date value becomes effective. |
| `cycleStartDate` | DATETIME | Cycle start date. |
| `leaveRequestId (FK)` | STRING | References LeaveRequest.id. Nullable. |
| `resetRunId (FK)` | STRING | References LeaveCreditResetRun.id. Nullable. |
| `notes` | STRING | Additional notes. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |

## DayOffRequest

This table stores employee day-off requests and day-off transfers, including the requested dates, snapshots of source and current shifts, reason, approval status, manager review details, and timestamps.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for day off request record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `workDate` | DATETIME | Work date. |
| `sourceOffDate` | DATETIME | Source off date. Nullable. |
| `targetWorkDate` | DATETIME | Target work date. Nullable. |
| `sourceShiftIdSnapshot` | INTEGER | Source shift id snapshot value. Nullable. |
| `currentShiftIdSnapshot` | INTEGER | Current shift id snapshot value. Nullable. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `status` | ENUM (`DayOffRequestStatus`) | Current workflow status. Default: PENDING_MANAGER. |
| `managerRemarks` | STRING | Manager remarks value. Nullable. |
| `reviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. (default: now()) |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## ScheduleChangeRequest

This table stores requests to change an employee’s scheduled shift, including the work date or date range, snapshots of the current and requested shifts, reason, status, manager review details, and timestamps.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for schedule change request record. (default: cuid()) |
| `employeeId (FK)` | STRING | References Employee.employeeId. |
| `workDate` | DATETIME | Work date. |
| `startDate` | DATETIME | Start date. Nullable. |
| `endDate` | DATETIME | End date. Nullable. |
| `currentShiftIdSnapshot` | INTEGER | Current shift id snapshot value. Nullable. |
| `requestedShiftId (FK)` | INTEGER | References Shift.id. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `status` | ENUM (`ScheduleChangeRequestStatus`) | Current workflow status. Default: PENDING_MANAGER. |
| `managerRemarks` | STRING | Manager remarks value. Nullable. |
| `reviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. (default: now()) |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## ScheduleSwapRequest

This table stores requests for two employees to swap scheduled shifts, including both employees, the work date, snapshots of each shift, coworker response, manager review, status, remarks, and timestamps.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for schedule swap request record. (default: cuid()) |
| `requesterEmployeeId (FK)` | STRING | References Employee.employeeId. |
| `coworkerEmployeeId (FK)` | STRING | References Employee.employeeId. |
| `workDate` | DATETIME | Work date. |
| `requesterShiftIdSnapshot` | INTEGER | Requester shift id snapshot value. Nullable. |
| `coworkerShiftIdSnapshot` | INTEGER | Coworker shift id snapshot value. Nullable. |
| `reason` | STRING | Reason for request or action. Nullable. |
| `status` | ENUM (`ScheduleSwapRequestStatus`) | Current workflow status. Default: PENDING_COWORKER. |
| `coworkerRemarks` | STRING | Coworker remarks value. Nullable. |
| `coworkerRespondedAt` | DATETIME | Date and time for coworker responded. Nullable. |
| `managerRemarks` | STRING | Manager remarks value. Nullable. |
| `reviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `reviewedAt` | DATETIME | Date and time for reviewed. Nullable. |
| `submittedAt` | DATETIME | Date and time for submitted. (default: now()) |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## EmployeeDeductionPayment

This table stores payments applied to an employee deduction assignment, including the amount, payment date, remarks, responsible user, and record timestamps.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for employee deduction payment record. (default: cuid()) |
| `assignmentId (FK)` | STRING | References EmployeeDeductionAssignment.id. |
| `amount` | DECIMAL | Monetary amount. |
| `paymentDate` | DATETIME | Payment date. |
| `remarks` | STRING | Additional remarks. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## Payroll

This table stores payroll runs, including the covered payroll period, payroll type, workflow status, manager and general manager decisions, review and release dates, remarks, and responsible users.

| Field | Data Type | Description |
|---|---|---|
| `payrollId (PK)` | STRING | Unique identifier for payroll record. (default: cuid()) |
| `payrollPeriodStart` | DATETIME | Payroll period start value. |
| `payrollPeriodEnd` | DATETIME | Payroll period end value. |
| `payrollType` | ENUM (`PayrollType`) | Selected payroll type. |
| `status` | ENUM (`PayrollStatus`) | Current workflow status. Default: DRAFT. |
| `managerDecision` | ENUM (`PayrollReviewDecision`) | Selected manager decision. Default: PENDING. |
| `gmDecision` | ENUM (`PayrollReviewDecision`) | Selected gm decision. Default: PENDING. |
| `generatedAt` | DATETIME | Date and time for generated. (default: now()) |
| `managerReviewedAt` | DATETIME | Date and time for manager reviewed. Nullable. |
| `gmReviewedAt` | DATETIME | Date and time for gm reviewed. Nullable. |
| `releasedAt` | DATETIME | Date and time for released. Nullable. |
| `managerReviewRemarks` | STRING | Manager review remarks value. Nullable. |
| `gmReviewRemarks` | STRING | Gm review remarks value. Nullable. |
| `notes` | STRING | Additional notes. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `managerReviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `gmReviewedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `releasedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## PayrollEmployee

This table stores the payroll summary for each employee in a payroll run, including attendance totals, position and rate snapshots, gross pay, earnings, deductions, net pay, workflow status, notes, and responsible users.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for payroll employee record. (default: cuid()) |
| `payrollId (FK, part of UNIQUE: payrollId + employeeId)` | STRING | References Payroll.payrollId. Part of unique constraint (payrollId, employeeId). |
| `employeeId (FK, part of UNIQUE: payrollId + employeeId)` | STRING | References Employee.employeeId. Part of unique constraint (payrollId, employeeId). |
| `attendanceStart` | DATETIME | Attendance start value. |
| `attendanceEnd` | DATETIME | Attendance end value. |
| `daysPresent` | INTEGER | Days present value. Default: 0. |
| `daysAbsent` | INTEGER | Days absent value. Default: 0. |
| `daysLate` | INTEGER | Days late value. Default: 0. |
| `minutesWorked` | INTEGER | Minutes worked value. Default: 0. |
| `minutesNetWorked` | INTEGER | Minutes net worked value. Default: 0. |
| `minutesOvertime` | INTEGER | Minutes overtime value. Default: 0. |
| `minutesUndertime` | INTEGER | Minutes undertime value. Default: 0. |
| `positionIdSnapshot` | STRING | Position id snapshot value. Nullable. |
| `grossPay` | DECIMAL | Gross pay monetary value. Default: 0. |
| `totalEarnings` | DECIMAL | Total earnings value. Default: 0. |
| `totalDeductions` | DECIMAL | Total deductions value. Default: 0. |
| `netPay` | DECIMAL | Net pay monetary value. Default: 0. |
| `status` | ENUM (`PayrollEmployeeStatus`) | Current workflow status. Default: DRAFT. |
| `notes` | STRING | Additional notes. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `updatedByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## PayrollEarning

This table stores individual earning lines for an employee payroll record, including earning type, amount, minutes, rate snapshot, source, reference information, manual-entry status, remarks, and voiding details.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for payroll earning record. (default: cuid()) |
| `payrollEmployeeId (FK)` | STRING | References PayrollEmployee.id. |
| `earningType` | ENUM (`PayrollEarningType`) | Selected earning type. |
| `amount` | DECIMAL | Monetary amount. |
| `minutes` | INTEGER | Minutes value. Nullable. |
| `source` | ENUM (`PayrollLineSource`) | Source value. Default: SYSTEM. |
| `isManual` | BOOLEAN | Whether manual. Default: false. |
| `referenceType` | ENUM (`PayrollReferenceType`) | Selected reference type. Nullable. |
| `referenceId` | STRING | Reference identifier. Nullable. |
| `remarks` | STRING | Additional remarks. Nullable. |
| `isVoided` | BOOLEAN | Whether voided. Default: false. |
| `voidedAt` | DATETIME | Date and time for voided. Nullable. |
| `voidReason` | STRING | Void reason value. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

## PayrollDeduction

This table stores individual payroll deduction lines, including deduction and contribution references, calculation snapshots, amounts, minutes, rates, source and reference information, metadata, remarks, and voiding details.

| Field | Data Type | Description |
|---|---|---|
| `id (PK)` | STRING | Unique identifier for payroll deduction record. (default: cuid()) |
| `payrollEmployeeId (FK)` | STRING | References PayrollEmployee.id. |
| `deductionType` | ENUM (`PayrollDeductionType`) | Selected deduction type. Default: OTHER. |
| `deductionTypeId (FK)` | STRING | References DeductionType.id. Nullable. |
| `assignmentId (FK)` | STRING | References EmployeeDeductionAssignment.id. Nullable. |
| `contributionType` | ENUM (`ContributionType`) | Selected contribution type. Nullable. |
| `bracketIdSnapshot` | STRING | Bracket id snapshot value. Nullable. |
| `payrollFrequency` | ENUM (`PayrollFrequency`) | Selected payroll frequency. Nullable. |
| `metadata` | JSON | Structured metadata. Nullable. |
| `amount` | DECIMAL | Monetary amount. |
| `minutes` | INTEGER | Minutes value. Nullable. |
| `source` | ENUM (`PayrollLineSource`) | Source value. Default: SYSTEM. |
| `isManual` | BOOLEAN | Whether manual. Default: false. |
| `referenceType` | ENUM (`PayrollReferenceType`) | Selected reference type. Nullable. |
| `referenceId` | STRING | Reference identifier. Nullable. |
| `remarks` | STRING | Additional remarks. Nullable. |
| `isVoided` | BOOLEAN | Whether voided. Default: false. |
| `voidedAt` | DATETIME | Date and time for voided. Nullable. |
| `voidReason` | STRING | Void reason value. Nullable. |
| `createdByUserId (FK)` | STRING | References User.userId. Nullable. |
| `createdAt` | DATETIME | Date and time record was created. (default: now()) |
| `updatedAt` | DATETIME | Date and time record was last updated. |

