import { CURRENT_STATUS } from "@prisma/client";

export const isEmployeeEndedStatus = (
  status: CURRENT_STATUS | string | null | undefined,
) => status === CURRENT_STATUS.ENDED || status === CURRENT_STATUS.INACTIVE;
