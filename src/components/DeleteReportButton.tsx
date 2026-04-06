"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import styles from "./delete-report-button.module.css";

const ADMIN_TOKEN_STORAGE_KEY = "gpu-dashboard-admin-token";

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

  function getAdminToken() {
    const cachedToken = window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim();

    if (cachedToken) {
      return cachedToken;
    }

    const input = window.prompt("删除任务需要管理员口令，请输入：", "");
    const token = input?.trim() ?? "";

    if (!token) {
      return null;
    }

    window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    return token;
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      `确认删除这条用卡汇报？\n用户：${username}\n任务：${task}`,
    );

    if (!confirmed) {
      return;
    }

    setError(null);
    const adminToken = getAdminToken();

    if (!adminToken) {
      setError("删除任务需要管理员口令。");
      return;
    }

    const response = await fetch(`/api/reports/${reportId}`, {
      method: "DELETE",
      headers: {
        "x-admin-token": adminToken,
      },
    });

    const payload = (await response.json()) as { error?: string };

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      }

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
