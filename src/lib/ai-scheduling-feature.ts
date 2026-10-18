import "server-only";

import { isAiSchedulingFlagEnabled } from "@/lib/ai-scheduling-feature-policy";

export function isAiSchedulingEnabled() {
  return isAiSchedulingFlagEnabled(process.env.AI_SCHEDULING_ENABLED);
}

export function requireAiSchedulingEnabled() {
  if (!isAiSchedulingEnabled()) {
    throw new Error("AI scheduling is disabled");
  }
}
