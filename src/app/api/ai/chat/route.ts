import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import { isAiSchedulingChatEnabled, chatRequestSchema } from "@/lib/ai-scheduling-chat-policy";
import { getScheduleChatHistory, ScheduleChatError, submitScheduleChat } from "@/lib/ai-scheduling-chat-service";

export const runtime = "nodejs";
export const maxDuration = 30;

const authorizeChat = async () => {
  const actor = await requireScheduleManager();
  if (!isAiSchedulingChatEnabled({
    schedulingFlag: process.env.AI_SCHEDULING_ENABLED,
    chatFlag: process.env.AI_SCHEDULING_CHAT_ENABLED,
  })) throw new ScheduleChatError("Scheduling chat is disabled.", 404);
  return actor;
};

const failureResponse = (error: unknown, fallback: string, requestId: string) => {
  if (error instanceof ScheduleChatError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  if (error instanceof Error && error.message === "Unauthorized") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  if (error instanceof Error && error.message === "AI scheduling is disabled") {
    return NextResponse.json({ success: false, error: "Scheduling chat is disabled." }, { status: 404 });
  }
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  console.error("[AI scheduling chat] Unhandled request error", {
    requestId,
    name: error instanceof Error ? error.name : "UnknownError",
    ...(errorCode ? { code: errorCode } : {}),
    ...(process.env.NODE_ENV === "development" && error instanceof Error
      ? { message: error.message.slice(0, 500) }
      : {}),
  });
  return NextResponse.json({
    success: false,
    error: `${fallback} Reference: ${requestId}`,
    requestId,
  }, { status: 500 });
};

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    const actor = await authorizeChat();
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return NextResponse.json({ success: false, error: "Expected a JSON request." }, { status: 415 });
    }
    let body: unknown;
    try {
      const rawBody = await request.text();
      if (rawBody.length > 16_384) {
        return NextResponse.json({ success: false, error: "Request is too large." }, { status: 413 });
      }
      body = JSON.parse(rawBody) as unknown;
    } catch {
      return NextResponse.json({ success: false, error: "Request body is invalid." }, { status: 400 });
    }
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "Chat request is invalid." }, { status: 400 });
    }
    const result = await submitScheduleChat({ ...parsed.data, userId: actor.userId });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return failureResponse(error, "Scheduling chat request failed.", requestId);
  }
}

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    const actor = await authorizeChat();
    const conversationId = request.nextUrl.searchParams.get("conversationId")?.trim() ?? "";
    if (!conversationId || conversationId.length > 64) {
      return NextResponse.json({ success: false, error: "Conversation ID is invalid." }, { status: 400 });
    }
    const data = await getScheduleChatHistory({ conversationId, userId: actor.userId });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return failureResponse(error, "Failed to load scheduling conversation.", requestId);
  }
}
