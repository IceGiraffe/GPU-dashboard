"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import styles from "./delete-report-button.module.css";

type DeleteReportButtonProps = {
  reportId: string;
  task: string;
  username: string;
};

export function DeleteReportButton({
  reportId,
  task,
  username,
}: DeleteReportButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    const confirmed = window.confirm(
      `确认删除这条用卡汇报？\n用户：${username}\n任务：${task}`,
    );

    if (!confirmed) {
      return;
    }

    setError(null);

    const response = await fetch(`/api/reports/${reportId}`, {
      method: "DELETE",
    });

    const payload = (await response.json()) as { error?: string };

    if (!response.ok) {
      setError(payload.error ?? "删除失败，请稍后再试。");
      return;
    }

    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <div className={styles.wrap}>
      <button
        className={styles.button}
        disabled={isPending}
        onClick={handleDelete}
        type="button"
      >
        {isPending ? "删除中..." : "删除"}
      </button>
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}
