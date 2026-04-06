import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { deleteReport } from "@/lib/gpu-reports";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await deleteReport(id);
    revalidatePath("/");

    return NextResponse.json({
      message: "任务汇报已删除，首页数据已刷新。",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除失败，请稍后再试。";

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
