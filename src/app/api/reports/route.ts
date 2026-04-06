import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { createUsageReport, saveReport, validateReportInput } from "@/lib/gpu-reports";
import {
  assertWriteAccess,
  createErrorResponse,
  enforceRateLimit,
  getClientIp,
} from "@/lib/security";

export async function POST(request: Request) {
  try {
    const clientIp = getClientIp(request);
    enforceRateLimit({
      scope: "report-write",
      key: clientIp,
      limit: 10,
      windowMs: 60 * 1000,
    });
    assertWriteAccess(request);

    const payload = await request.json();
    const input = validateReportInput(payload);
    const report = createUsageReport(input);
    await saveReport(report);
    revalidatePath("/");

    return NextResponse.json({
      message: "汇报已提交，首页数据已刷新。",
      report,
    });
  } catch (error) {
    return createErrorResponse(error, "提交失败，请稍后再试。");
  }
}
