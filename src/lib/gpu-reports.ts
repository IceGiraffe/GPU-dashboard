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
  dateLabel: string | null;
  slotStart: string;
  slotEnd: string;
  overbookedGpuCount: number;
  taskIds: Array<string | null>;
  intensities: number[];
  fillStarts: number[];
  fillEnds: number[];
};

export type HeatmapTask = {
  id: string;
  task: string;
  username: string;
  gpuCount: number;
  startAt: string;
  endAt: string;
  color: string;
};

export type HeatmapData = {
  columns: HeatmapColumn[];
  tasks: Record<string, HeatmapTask>;
  currentHourIndex: number;
  totalHours: number;
  peakOverbookedGpuCount: number;
};

type DeleteReportOptions = {
  actor: string;
};

type DeletionAuditEntry = {
  id: string;
  action: "delete_report";
  reportId: string;
  actor: string;
  payload: UsageReport;
  createdAt: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "reports.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit-log.json");
const BLOB_PREFIX = "gpu-reports/";
const AUDIT_BLOB_PREFIX = "gpu-audit/";
const HOUR_MS = 60 * 60 * 1000;
const REPORTS_TABLE = "gpu_usage_reports";
const AUDIT_TABLE = "gpu_usage_audit_log";
const DISPLAY_TIME_ZONE = process.env.DISPLAY_TIME_ZONE ?? "Asia/Shanghai";
const HEATMAP_PAST_HOURS = 24 * 7;
const HEATMAP_FUTURE_HOURS = 24 * 7;
const HEATMAP_TOTAL_HOURS = HEATMAP_PAST_HOURS + HEATMAP_FUTURE_HOURS;

type NormalizedReport = UsageReport & {
  startMs: number;
  endMs: number;
};

type SlotOverlap = {
  report: NormalizedReport;
  overlapMs: number;
  overlapRatio: number;
};

type ReportAllocation = {
  startRow: number | null;
  visibleGpuCount: number;
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

function isVercelRuntime() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

function canUseLocalFileStore() {
  return !isVercelRuntime();
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const value = formatted.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = value.match(/GMT([+-])(\d{2}):(\d{2})/);

  if (!match) {
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 60 + minutes);
}

function alignHourStartMs(date: Date, timeZone: string) {
  const offsetMinutes = getTimeZoneOffsetMinutes(date, timeZone);
  const localMs = date.getTime() + offsetMinutes * 60 * 1000;
  const alignedLocalMs = Math.floor(localMs / HOUR_MS) * HOUR_MS;
  return alignedLocalMs - offsetMinutes * 60 * 1000;
}

function formatHourLabel(date: string | Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: DISPLAY_TIME_ZONE,
  }).format(new Date(date));
}

function formatMonthDayLabel(date: string | Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(new Date(date));
}

function isStartOfDayInTimeZone(date: string | Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: DISPLAY_TIME_ZONE,
  }).formatToParts(new Date(date));
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return hour === "00" && minute === "00";
}

function getTaskColor(seed: string) {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  const hue = hash % 360;
  return `hsl(${hue} 62% 44%)`;
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
  if (!canUseLocalFileStore()) {
    throw new Error("Vercel 线上环境不能使用本地 JSON 存储。请配置 Postgres 或 Blob。");
  }

  await mkdir(DATA_DIR, { recursive: true });

  try {
    await readFile(DATA_FILE, "utf8");
  } catch {
    await writeFile(DATA_FILE, "[]\n", "utf8");
  }

  try {
    await readFile(AUDIT_FILE, "utf8");
  } catch {
    await writeFile(AUDIT_FILE, "[]\n", "utf8");
  }
}

async function readLocalReports() {
  if (!canUseLocalFileStore()) {
    return [];
  }

  await ensureLocalStore();
  const raw = await readFile(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw) as UsageReport[];
  return Array.isArray(parsed) ? parsed : [];
}

async function writeLocalReports(reports: UsageReport[]) {
  if (!canUseLocalFileStore()) {
    throw new Error("当前部署未配置持久化存储。请先配置 Postgres 或 Blob。");
  }

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

function createDeletionAuditEntry(report: UsageReport, actor: string): DeletionAuditEntry {
  return {
    id: crypto.randomUUID(),
    action: "delete_report",
    reportId: report.id,
    actor,
    payload: report,
    createdAt: new Date().toISOString(),
  };
}

async function appendLocalAuditEntry(entry: DeletionAuditEntry) {
  if (!canUseLocalFileStore()) {
    throw new Error("当前部署未配置可写审计存储。");
  }

  await ensureLocalStore();
  const raw = await readFile(AUDIT_FILE, "utf8");
  const entries = JSON.parse(raw) as DeletionAuditEntry[];
  const nextEntries = Array.isArray(entries) ? [...entries, entry] : [entry];
  await writeFile(AUDIT_FILE, `${JSON.stringify(nextEntries, null, 2)}\n`, "utf8");
}

async function saveBlobAuditEntry(entry: DeletionAuditEntry) {
  const pathname = `${AUDIT_BLOB_PREFIX}${entry.createdAt.slice(0, 10)}/${entry.id}.json`;
  await put(pathname, JSON.stringify(entry, null, 2), {
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

    await sql.unsafe(`
      create table if not exists ${AUDIT_TABLE} (
        id text primary key,
        action text not null,
        report_id text not null,
        actor text not null,
        payload_json jsonb not null,
        created_at timestamptz not null
      )
    `);

    await sql.unsafe(`
      create index if not exists ${AUDIT_TABLE}_report_id_idx
      on ${AUDIT_TABLE} (report_id)
    `);

    await sql.unsafe(`
      create index if not exists ${AUDIT_TABLE}_created_at_idx
      on ${AUDIT_TABLE} (created_at desc)
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

export async function deleteReport(reportId: string, options: DeleteReportOptions) {
  const normalizedReportId = safeTrim(reportId);

  if (!normalizedReportId) {
    throw new Error("缺少待删除的任务 ID。");
  }

  if (isPostgresEnabled()) {
    await ensurePostgresStore();
    const sql = getPostgresClient();
    await sql.begin(async (tx) => {
      const rows = await tx<ReportRow[]>`
        delete from gpu_usage_reports
        where id = ${normalizedReportId}
        returning
          id,
          username,
          task,
          gpu_count,
          duration_hours,
          start_at,
          end_at,
          created_at
      `;

      if (!rows.length) {
        throw new Error("未找到对应的汇报记录。");
      }

      const report = mapRowToUsageReport(rows[0]);
      const auditEntry = createDeletionAuditEntry(report, options.actor);
      await tx`
        insert into gpu_usage_audit_log (
          id,
          action,
          report_id,
          actor,
          payload_json,
          created_at
        ) values (
          ${auditEntry.id},
          ${auditEntry.action},
          ${auditEntry.reportId},
          ${auditEntry.actor},
          ${JSON.stringify(auditEntry.payload)},
          ${auditEntry.createdAt}
        )
      `;
    });

    return;
  }

  if (isBlobEnabled()) {
    const { blobs } = await list({ prefix: BLOB_PREFIX });
    const targetBlob = blobs.find((blob) => blob.pathname.endsWith(`/${normalizedReportId}.json`));

    if (!targetBlob) {
      throw new Error("未找到对应的汇报记录。");
    }

    const response = await fetch(targetBlob.url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`读取 Blob 失败: ${targetBlob.pathname}`);
    }

    const report = (await response.json()) as UsageReport;
    await del(targetBlob.pathname);
    await saveBlobAuditEntry(createDeletionAuditEntry(report, options.actor));
    return;
  }

  const reports = await readLocalReports();
  const targetReport = reports.find((report) => report.id === normalizedReportId);
  const nextReports = reports.filter((report) => report.id !== normalizedReportId);

  if (!targetReport || nextReports.length === reports.length) {
    throw new Error("未找到对应的汇报记录。");
  }

  await writeLocalReports(nextReports);
  await appendLocalAuditEntry(createDeletionAuditEntry(targetReport, options.actor));
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
    timeZone: DISPLAY_TIME_ZONE,
  }).format(new Date(date));
}

export function getStorageModeLabel() {
  if (isPostgresEnabled()) {
    return "Postgres";
  }

  if (isBlobEnabled()) {
    return "Vercel Blob";
  }

  if (isVercelRuntime()) {
    return "未配置持久化";
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
  const currentHourStartMs = alignHourStartMs(now, DISPLAY_TIME_ZONE);
  const columns: HeatmapColumn[] = [];
  const tasks: Record<string, HeatmapTask> = {};
  const currentHourIndex = HEATMAP_PAST_HOURS;
  const sortedReports = [...reports].sort((left, right) => {
    if (left.startMs !== right.startMs) {
      return left.startMs - right.startMs;
    }

    if (left.endMs !== right.endMs) {
      return left.endMs - right.endMs;
    }

    return left.id.localeCompare(right.id);
  });
  const allocations = buildReportAllocations(sortedReports, totalGpuCount);

  for (let index = 0; index < HEATMAP_TOTAL_HOURS; index += 1) {
    const slotStartMs = currentHourStartMs + (index - currentHourIndex) * HOUR_MS;
    const slotEndMs = slotStartMs + HOUR_MS;
    const overlaps: SlotOverlap[] = sortedReports
      .map((report) => {
        const overlapMs = getOverlapMs(slotStartMs, slotEndMs, report.startMs, report.endMs);

        return {
          report,
          overlapMs,
          overlapRatio: overlapMs / HOUR_MS,
        };
      })
      .filter((item) => item.overlapMs > 0)
      .sort((left, right) => {
        if (left.report.startMs !== right.report.startMs) {
          return left.report.startMs - right.report.startMs;
        }

        if (left.report.endMs !== right.report.endMs) {
          return left.report.endMs - right.report.endMs;
        }

        return left.report.id.localeCompare(right.report.id);
      });

    const taskIds = Array<string | null>(totalGpuCount).fill(null);
    const intensities = Array<number>(totalGpuCount).fill(0);
    const fillStarts = Array<number>(totalGpuCount).fill(0);
    const fillEnds = Array<number>(totalGpuCount).fill(0);

    overlaps.forEach(({ report, overlapRatio }) => {
      if (!tasks[report.id]) {
        tasks[report.id] = {
          id: report.id,
          task: report.task,
          username: report.username,
          gpuCount: report.gpuCount,
          startAt: report.startAt,
          endAt: report.endAt,
          color: getTaskColor(`${report.username}:${report.task}:${report.id}`),
        };
      }

      const overlapStartMs = Math.max(slotStartMs, report.startMs);
      const overlapEndMs = Math.min(slotEndMs, report.endMs);
      const fillStart = Math.max(0, Math.min(1, (overlapStartMs - slotStartMs) / HOUR_MS));
      const fillEnd = Math.max(fillStart, Math.min(1, (overlapEndMs - slotStartMs) / HOUR_MS));

      const allocation = allocations.get(report.id);

      if (!allocation || allocation.startRow === null || allocation.visibleGpuCount <= 0) {
        return;
      }

      for (let offset = 0; offset < allocation.visibleGpuCount; offset += 1) {
        const rowIndex = allocation.startRow + offset;
        taskIds[rowIndex] = report.id;
        intensities[rowIndex] = overlapRatio;
        fillStarts[rowIndex] = fillStart;
        fillEnds[rowIndex] = fillEnd;
      }
    });

    const scheduledGpuCount = overlaps.reduce((sum, item) => sum + item.report.gpuCount, 0);
    const dateLabel =
      index === 0 || isStartOfDayInTimeZone(new Date(slotStartMs))
        ? formatMonthDayLabel(new Date(slotStartMs))
        : null;

    columns.push({
      label: formatHourLabel(new Date(slotStartMs)),
      dateLabel,
      slotStart: new Date(slotStartMs).toISOString(),
      slotEnd: new Date(slotEndMs).toISOString(),
      overbookedGpuCount: Math.max(scheduledGpuCount - totalGpuCount, 0),
      taskIds,
      intensities,
      fillStarts,
      fillEnds,
    });
  }

  return {
    columns,
    tasks,
    currentHourIndex,
    totalHours: HEATMAP_TOTAL_HOURS,
    peakOverbookedGpuCount: columns.reduce(
      (max, column) => Math.max(max, column.overbookedGpuCount),
      0,
    ),
  };
}

function buildReportAllocations(
  reports: NormalizedReport[],
  totalGpuCount: number,
) {
  const allocations = new Map<string, ReportAllocation>();
  const activeReports: Array<{
    id: string;
    endMs: number;
    startRow: number;
    visibleGpuCount: number;
  }> = [];
  const occupiedRows = Array<boolean>(totalGpuCount).fill(false);

  const releaseFinishedReports = (currentStartMs: number) => {
    for (let index = activeReports.length - 1; index >= 0; index -= 1) {
      const active = activeReports[index];

      if (active.endMs > currentStartMs) {
        continue;
      }

      for (let row = active.startRow; row < active.startRow + active.visibleGpuCount; row += 1) {
        occupiedRows[row] = false;
      }

      activeReports.splice(index, 1);
    }
  };

  const findContiguousBlock = (requiredRows: number) => {
    if (requiredRows <= 0 || requiredRows > totalGpuCount) {
      return null;
    }

    let streak = 0;

    for (let row = 0; row < totalGpuCount; row += 1) {
      streak = occupiedRows[row] ? 0 : streak + 1;

      if (streak >= requiredRows) {
        return row - requiredRows + 1;
      }
    }

    return null;
  };

  for (const report of reports) {
    releaseFinishedReports(report.startMs);

    const visibleGpuCount = Math.min(report.gpuCount, totalGpuCount);
    const startRow = findContiguousBlock(visibleGpuCount);

    if (startRow === null) {
      allocations.set(report.id, {
        startRow: null,
        visibleGpuCount: 0,
      });
      continue;
    }

    for (let row = startRow; row < startRow + visibleGpuCount; row += 1) {
      occupiedRows[row] = true;
    }

    activeReports.push({
      id: report.id,
      endMs: report.endMs,
      startRow,
      visibleGpuCount,
    });
    allocations.set(report.id, {
      startRow,
      visibleGpuCount,
    });
  }

  return allocations;
}
