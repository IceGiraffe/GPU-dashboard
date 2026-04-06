import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { deleteReport } from "@/lib/gpu-reports";
import {
  assertAdminAccess,
  createErrorResponse,
  enforceRateLimit,
  getClientIp,
  getDeleteActor,
} from "@/lib/security";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const clientIp = getClientIp(request);
    enforceRateLimit({
      scope: "report-delete",
      key: clientIp,
      limit: 10,
      windowMs: 60 * 1000,
    });
    assertAdminAccess(request);

    const { id } = await context.params;
    await deleteReport(id, {
      actor: getDeleteActor(request),
    });
    revalidatePath("/");

    return NextResponse.json({
      message: "任务汇报已删除，首页数据已刷新。",
    });
  } catch (error) {
    return createErrorResponse(error, "删除失败，请稍后再试。");
  }
}
