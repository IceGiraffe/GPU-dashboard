import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitOptions = {
  scope: string;
  key: string;
  limit: number;
  windowMs: number;
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function safeTrim(value: string | null) {
  return value?.trim() ?? "";
}

function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readToken(request: Request, headerName: string) {
  return safeTrim(request.headers.get(headerName));
}

function assertTokenMatches({
  actualToken,
  expectedToken,
  missingMessage,
  invalidMessage,
}: {
  actualToken: string;
  expectedToken: string;
  missingMessage: string;
  invalidMessage: string;
}) {
  if (!actualToken) {
    throw new HttpError(401, missingMessage);
  }

  if (!constantTimeEquals(actualToken, expectedToken)) {
    throw new HttpError(403, invalidMessage);
  }
}

function pruneExpiredBuckets(now: number) {
  for (const [bucketKey, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(bucketKey);
    }
  }
}

export function getClientIp(request: Request) {
  const forwardedFor = safeTrim(request.headers.get("x-forwarded-for"));

  if (forwardedFor) {
    return safeTrim(forwardedFor.split(",")[0]) || "unknown";
  }

  return (
    safeTrim(request.headers.get("x-real-ip")) ||
    safeTrim(request.headers.get("cf-connecting-ip")) ||
    "unknown"
  );
}

export function enforceRateLimit({
  scope,
  key,
  limit,
  windowMs,
}: RateLimitOptions) {
  const now = Date.now();
  const bucketKey = `${scope}:${key}`;
  pruneExpiredBuckets(now);

  const bucket = rateLimitBuckets.get(bucketKey);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(bucketKey, {
      count: 1,
      resetAt: now + windowMs,
    });
    return;
  }

  if (bucket.count >= limit) {
    throw new HttpError(429, "请求过于频繁，请稍后再试。");
  }

  bucket.count += 1;
}

export function assertWriteAccess(request: Request) {
  const expectedToken = safeTrim(process.env.WRITE_TOKEN ?? null);

  if (!expectedToken) {
    return;
  }

  const actualToken = readToken(request, "x-write-token");
  assertTokenMatches({
    actualToken,
    expectedToken,
    missingMessage: "当前站点需要写入口令，请填写后再提交。",
    invalidMessage: "写入口令不正确。",
  });
}

export function assertAdminAccess(request: Request) {
  const expectedToken = safeTrim(process.env.ADMIN_TOKEN ?? null);

  if (!expectedToken) {
    throw new HttpError(503, "当前部署未配置管理员口令，暂时不能删除任务。");
  }

  const actualToken = readToken(request, "x-admin-token");
  assertTokenMatches({
    actualToken,
    expectedToken,
    missingMessage: "删除任务需要管理员口令。",
    invalidMessage: "管理员口令不正确。",
  });
}

export function getDeleteActor(request: Request) {
  return `admin-token:${getClientIp(request)}`;
}

export function createErrorResponse(error: unknown, fallbackMessage: string) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const status = error instanceof HttpError ? error.status : 400;

  return NextResponse.json(
    {
      error: message,
    },
    {
      status,
    },
  );
}
