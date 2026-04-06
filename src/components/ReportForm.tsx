"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import styles from "./report-form.module.css";

function getDefaultStartTime() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function toIsoStringFromLocalInput(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function ReportForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formState, setFormState] = useState({
    username: "",
    task: "",
    gpuCount: "8",
    durationHours: "12",
    startAt: getDefaultStartTime(),
    writeToken: "",
  });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    const response = await fetch("/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(formState.writeToken
          ? {
              "x-write-token": formState.writeToken,
            }
          : {}),
      },
      body: JSON.stringify({
        username: formState.username,
        task: formState.task,
        gpuCount: Number(formState.gpuCount),
        durationHours: Number(formState.durationHours),
        startAt: toIsoStringFromLocalInput(formState.startAt),
      }),
    });

    const payload = (await response.json()) as { error?: string; message?: string };

    if (!response.ok) {
      setError(payload.error ?? "提交失败，请稍后再试。");
      return;
    }

    setMessage(payload.message ?? "提交成功。");
    setFormState((current) => ({
      ...current,
      task: "",
      startAt: getDefaultStartTime(),
    }));

    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.head}>
        <p className={styles.eyebrow}>快速上报</p>
        <p className={styles.hint}>无需登录，填写用户名和任务名即可。</p>
      </div>

      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span>用户名</span>
          <input
            required
            maxLength={32}
            placeholder="Alice"
            value={formState.username}
            onChange={(event) =>
              setFormState((current) => ({ ...current, username: event.target.value }))
            }
          />
        </label>

        <label className={styles.field}>
          <span>任务名</span>
          <input
            required
            maxLength={120}
            placeholder="Fairy"
            value={formState.task}
            onChange={(event) =>
              setFormState((current) => ({ ...current, task: event.target.value }))
            }
          />
        </label>

        <label className={styles.field}>
          <span>GPU 数量</span>
          <input
            required
            min={1}
            max={64}
            step={1}
            type="number"
            value={formState.gpuCount}
            onChange={(event) =>
              setFormState((current) => ({ ...current, gpuCount: event.target.value }))
            }
          />
        </label>

        <label className={styles.field}>
          <span>时长（小时）</span>
          <input
            required
            min={1}
            max={336}
            step={1}
            type="number"
            value={formState.durationHours}
            onChange={(event) =>
              setFormState((current) => ({
                ...current,
                durationHours: event.target.value,
              }))
            }
          />
        </label>

        <label className={styles.field}>
          <span>开始时间</span>
          <input
            required
            type="datetime-local"
            value={formState.startAt}
            onChange={(event) =>
              setFormState((current) => ({ ...current, startAt: event.target.value }))
            }
          />
        </label>

        <label className={styles.field}>
          <span>写入口令</span>
          <input
            maxLength={120}
            placeholder="如有配置再填写"
            type="password"
            value={formState.writeToken}
            onChange={(event) =>
              setFormState((current) => ({ ...current, writeToken: event.target.value }))
            }
          />
        </label>

        <button className={styles.submit} disabled={isPending} type="submit">
          {isPending ? "刷新中..." : "上报"}
        </button>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
      {message ? <p className={styles.success}>{message}</p> : null}
    </form>
  );
}
