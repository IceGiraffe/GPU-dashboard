import { del, list, put } from "@vercel/blob";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres, { type Sql } from "postgres";

export type UsageReport = {
  id: string;
  username: string;
  task: string;
  gpuCount: number;
  durationHours: number;
  startAt: string;
  endAt: string;
  createdAt: string;
};

export type ReportInput = {
  username: string;
  task: string;
  gpuCount: number;
  durationHours: number;
  startAt: string;
};

export type DashboardData = {
  totalGpuCount: number;
  usedGpuCount: number;
  freeGpuCount: number;
  overbookedGpuCount: number;
  utilizationRatio: number;
  utilizationWindows: UtilizationWindow[];
  heatmap: HeatmapData;
  activeReports: UsageReport[];
  upcomingReports: UsageReport[];
  recentReports: UsageReport[];
};

export type UtilizationWindow = {
  label: string;
  hours: number;
  ratio: number;
  averageUsedGpuCount: number;
};

export type HeatmapColumn = {
  label: string;
  slotStart: string;
  slotEnd: string;
  averageUsedGpuCount: number;
  occupiedGpuCount: number;
  overbookedGpuCount: number;
};

export type HeatmapData = {
  columns: HeatmapColumn[];
  peakAverageUsedGpuCount: number;
  peakOverbookedGpuCount: number;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "reports.json");
const BLOB_PREFIX = "gpu-reports/";
const HOUR_MS = 60 * 60 * 1000;
const REPORTS_TABLE = "gpu_usage_reports";

type NormalizedReport = UsageReport & {
  startMs: number;
  endMs: number;
};

type ReportRow = {
  id: string;
  username: string;
  task: string;
  gpu_count: number;
  duration_hours: number;
  start_at: Date | string;
  end_at: Date | string;
  created_at: Date | string;
};

let postgresClient: Sql | null = null;
let postgresReadyPromise: Promise<void> | null = null;

function getTotalGpuCount() {
  const raw = Number(process.env.TOTAL_GPU_COUNT ?? "64");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 64;
}

function isBlobEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function getPostgresConnectionString() {
  return (
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL ??
    process.env.POSTGRES_PRISMA_URL ??
    null
  );
}

function isPostgresEnabled() {
  return Boolean(getPostgresConnectionString());
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseStartAt(value: unknown) {
  if (typeof value !== "string" || !value) {
    return new Date();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function validateReportInput(payload: unknown): ReportInput {
  if (!payload || typeof payload !== "object") {
    throw new Error("请求体格式不正确。");
  }

  const candidate = payload as Record<string, unknown>;
  const username = safeTrim(candidate.username);
  const task = safeTrim(candidate.task);
  const gpuCount = parsePositiveNumber(candidate.gpuCount);
  const durationHours = parsePositiveNumber(candidate.durationHours);
  const startAt = parseStartAt(candidate.startAt);

  if (!username || username.length > 32) {
    throw new Error("用户名必填，且不能超过 32 个字符。");
  }

  if (!task || task.length > 120) {
    throw new Error("任务名称必填，且不能超过 120 个字符。");
  }

  if (!gpuCount || gpuCount > 64) {
    throw new Error("GPU 数量需要是 1 到 64 的整数。");
  }

  if (!Number.isInteger(gpuCount)) {
    throw new Error("GPU 数量需要填写整数。");
  }

  if (!durationHours || durationHours > 336) {
    throw new Error("时长需要大于 0 且不能超过 336 小时。");
  }

  return {
    username,
    task,
    gpuCount,
    durationHours,
    startAt: startAt.toISOString(),
  };
}

export function createUsageReport(input: ReportInput): UsageReport {
  const startAt = new Date(input.startAt);
  const endAt = new Date(startAt.getTime() + input.durationHours * 60 * 60 * 1000);
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    username: input.username,
    task: input.task,
    gpuCount: input.gpuCount,
    durationHours: input.durationHours,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    createdAt: now,
  };
}

async function ensureLocalStore() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    await readFile(DATA_FILE, "utf8");
  } catch {
    await writeFile(DATA_FILE, "[]\n", "utf8");
  }
}

async function readLocalReports() {
  await ensureLocalStore();
  const raw = await readFile(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw) as UsageReport[];
  return Array.isArray(parsed) ? parsed : [];
}

async function writeLocalReports(reports: UsageReport[]) {
  await ensureLocalStore();
  await writeFile(DATA_FILE, `${JSON.stringify(reports, null, 2)}\n`, "utf8");
}

async function readBlobReports() {
  const { blobs } = await list({ prefix: BLOB_PREFIX });
  const reports = await Promise.all(
    blobs.map(async (blob) => {
      const response = await fetch(blob.url, { cache: "no-store" });

      if (!response.ok) {
        throw new Error(`读取 Blob 失败: ${blob.pathname}`);
      }

      return (await response.json()) as UsageReport;
    }),
  );

  return reports;
}

async function saveBlobReport(report: UsageReport) {
  const pathname = `${BLOB_PREFIX}${report.createdAt.slice(0, 10)}/${report.id}.json`;
  await put(pathname, JSON.stringify(report, null, 2), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json; charset=utf-8",
  });
}

function getPostgresClient() {
  if (postgresClient) {
    return postgresClient;
  }

  const connectionString = getPostgresConnectionString();

  if (!connectionString) {
    throw new Error("缺少 Postgres 连接信息。");
  }

  postgresClient = postgres(connectionString, {
    prepare: false,
    max: 1,
  });

  return postgresClient;
}

async function ensurePostgresStore() {
  if (postgresReadyPromise) {
    return postgresReadyPromise;
  }

  postgresReadyPromise = (async () => {
    const sql = getPostgresClient();

    await sql.unsafe(`
      create table if not exists ${REPORTS_TABLE} (
        id text primary key,
        username text not null,
        task text not null,
        gpu_count integer not null,
        duration_hours integer not null,
        start_at timestamptz not null,
        end_at timestamptz not null,
        created_at timestamptz not null
      )
    `);

    await sql.unsafe(`
      create index if not exists ${REPORTS_TABLE}_created_at_idx
      on ${REPORTS_TABLE} (created_at desc)
    `);

    await sql.unsafe(`
      create index if not exists ${REPORTS_TABLE}_start_at_idx
      on ${REPORTS_TABLE} (start_at)
    `);

    await sql.unsafe(`
      create index if not exists ${REPORTS_TABLE}_end_at_idx
      on ${REPORTS_TABLE} (end_at)
    `);
  })();

  return postgresReadyPromise;
}

function mapRowToUsageReport(row: ReportRow): UsageReport {
  return {
    id: row.id,
    username: row.username,
    task: row.task,
    gpuCount: Number(row.gpu_count),
    durationHours: Number(row.duration_hours),
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function readPostgresReports() {
  await ensurePostgresStore();
  const sql = getPostgresClient();
  const rows = await sql.unsafe<ReportRow[]>(
    `
      select
        id,
        username,
        task,
        gpu_count,
        duration_hours,
        start_at,
        end_at,
        created_at
      from ${REPORTS_TABLE}
      order by created_at desc
    `,
  );

  return rows.map(mapRowToUsageReport);
}

async function savePostgresReport(report: UsageReport) {
  await ensurePostgresStore();
  const sql = getPostgresClient();

  await sql`
    insert into gpu_usage_reports (
      id,
      username,
      task,
      gpu_count,
      duration_hours,
      start_at,
      end_at,
      created_at
    ) values (
      ${report.id},
      ${report.username},
      ${report.task},
      ${report.gpuCount},
      ${report.durationHours},
      ${report.startAt},
      ${report.endAt},
      ${report.createdAt}
    )
  `;
}

export async function listReports() {
  const reports = isPostgresEnabled()
    ? await readPostgresReports()
    : isBlobEnabled()
      ? await readBlobReports()
      : await readLocalReports();

  return reports.sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export async function saveReport(report: UsageReport) {
  if (isPostgresEnabled()) {
    await savePostgresReport(report);
    return;
  }

  if (isBlobEnabled()) {
    await saveBlobReport(report);
    return;
  }

  const reports = await readLocalReports();
  reports.push(report);
  await writeLocalReports(reports);
}

export async function deleteReport(reportId: string) {
  const normalizedReportId = safeTrim(reportId);

  if (!normalizedReportId) {
    throw new Error("缺少待删除的任务 ID。");
  }

  if (isPostgresEnabled()) {
    await ensurePostgresStore();
    const sql = getPostgresClient();
    const rows = await sql`
      delete from gpu_usage_reports
      where id = ${normalizedReportId}
      returning id
    `;

    if (!rows.length) {
      throw new Error("未找到对应的汇报记录。");
    }

    return;
  }

  if (isBlobEnabled()) {
    const { blobs } = await list({ prefix: BLOB_PREFIX });
    const targetBlob = blobs.find((blob) => blob.pathname.endsWith(`/${normalizedReportId}.json`));

    if (!targetBlob) {
      throw new Error("未找到对应的汇报记录。");
    }

    await del(targetBlob.pathname);
    return;
  }

  const reports = await readLocalReports();
  const nextReports = reports.filter((report) => report.id !== normalizedReportId);

  if (nextReports.length === reports.length) {
    throw new Error("未找到对应的汇报记录。");
  }

  await writeLocalReports(nextReports);
}

export async function getDashboardData(now = new Date()): Promise<DashboardData> {
  const totalGpuCount = getTotalGpuCount();
  const reports = await listReports();
  const currentTime = now.getTime();
  const normalizedReports: NormalizedReport[] = reports.map((report) => ({
    ...report,
    startMs: new Date(report.startAt).getTime(),
    endMs: new Date(report.endAt).getTime(),
  }));

  const activeReports = normalizedReports
    .filter((report) => {
      return report.startMs <= currentTime && currentTime < report.endMs;
    })
    .sort((left, right) => new Date(left.endAt).getTime() - new Date(right.endAt).getTime());

  const upcomingReports = normalizedReports
    .filter((report) => report.startMs > currentTime)
    .slice(0, 5)
    .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime());

  const recentReports = reports.slice(0, 8);
  const usedGpuCount = activeReports.reduce((sum, report) => sum + report.gpuCount, 0);
  const overbookedGpuCount = Math.max(usedGpuCount - totalGpuCount, 0);
  const freeGpuCount = Math.max(totalGpuCount - usedGpuCount, 0);
  const utilizationWindows = buildUtilizationWindows(normalizedReports, totalGpuCount, currentTime);
  const heatmap = buildHeatmap(normalizedReports, totalGpuCount, now);

  return {
    totalGpuCount,
    usedGpuCount,
    freeGpuCount,
    overbookedGpuCount,
    utilizationRatio: usedGpuCount / totalGpuCount,
    utilizationWindows,
    heatmap,
    activeReports,
    upcomingReports,
    recentReports,
  };
}

export function formatDateTime(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));
}

export function getStorageModeLabel() {
  if (isPostgresEnabled()) {
    return "Postgres";
  }

  if (isBlobEnabled()) {
    return "Vercel Blob";
  }

  return "本地 JSON";
}

function getOverlapMs(
  rangeStartMs: number,
  rangeEndMs: number,
  reportStartMs: number,
  reportEndMs: number,
) {
  const startMs = Math.max(rangeStartMs, reportStartMs);
  const endMs = Math.min(rangeEndMs, reportEndMs);
  return Math.max(endMs - startMs, 0);
}

function getAverageUsedGpuCount(
  reports: NormalizedReport[],
  rangeStartMs: number,
  rangeEndMs: number,
) {
  const durationMs = rangeEndMs - rangeStartMs;

  if (durationMs <= 0) {
    return 0;
  }

  const gpuMilliseconds = reports.reduce((sum, report) => {
    return sum + getOverlapMs(rangeStartMs, rangeEndMs, report.startMs, report.endMs) * report.gpuCount;
  }, 0);

  return gpuMilliseconds / durationMs;
}

function buildUtilizationWindows(
  reports: NormalizedReport[],
  totalGpuCount: number,
  nowMs: number,
): UtilizationWindow[] {
  const windows = [
    { label: "最近 24 小时", hours: 24 },
    { label: "最近 3 天", hours: 72 },
    { label: "最近 7 天", hours: 168 },
  ];

  return windows.map((window) => {
    const averageUsedGpuCount = getAverageUsedGpuCount(
      reports,
      nowMs - window.hours * HOUR_MS,
      nowMs,
    );

    return {
      ...window,
      averageUsedGpuCount,
      ratio: averageUsedGpuCount / totalGpuCount,
    };
  });
}

function buildHeatmap(
  reports: NormalizedReport[],
  totalGpuCount: number,
  now: Date,
): HeatmapData {
  const alignedNow = new Date(now);
  alignedNow.setMinutes(0, 0, 0);
  const rangeEndMs = alignedNow.getTime();
  const columns: HeatmapColumn[] = [];

  for (let index = 0; index < 24; index += 1) {
    const slotEndMs = rangeEndMs - (23 - index) * HOUR_MS;
    const slotStartMs = slotEndMs - HOUR_MS;
    const averageUsedGpuCount = getAverageUsedGpuCount(reports, slotStartMs, slotEndMs);

    columns.push({
      label: new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(slotStartMs)),
      slotStart: new Date(slotStartMs).toISOString(),
      slotEnd: new Date(slotEndMs).toISOString(),
      averageUsedGpuCount,
      occupiedGpuCount: Math.min(Math.ceil(averageUsedGpuCount), totalGpuCount),
      overbookedGpuCount: Math.max(Math.ceil(averageUsedGpuCount - totalGpuCount), 0),
    });
  }

  return {
    columns,
    peakAverageUsedGpuCount: columns.reduce(
      (max, column) => Math.max(max, column.averageUsedGpuCount),
      0,
    ),
    peakOverbookedGpuCount: columns.reduce(
      (max, column) => Math.max(max, column.overbookedGpuCount),
      0,
    ),
  };
}
