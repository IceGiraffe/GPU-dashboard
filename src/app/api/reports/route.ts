import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { createUsageReport, saveReport, validateReportInput } from "@/lib/gpu-reports";

export async function POST(request: Request) {
  try {
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
    const message = error instanceof Error ? error.message : "提交失败，请稍后再试。";

    return NextResponse.json(
      {
        error: message,
      },
      {
        status: 400,
      },
    );
  }
}
