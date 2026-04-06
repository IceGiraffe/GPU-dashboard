"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { HeatmapData, HeatmapTask } from "@/lib/gpu-reports";
import styles from "./interactive-heatmap.module.css";

type InteractiveHeatmapProps = {
  heatmap: HeatmapData;
  totalGpuCount: number;
};

type HoverState = {
  rowIndex: number;
  columnIndex: number;
  task: HeatmapTask | null;
  intensity: number;
  slotStart: string;
  slotEnd: string;
};

const RANGE_OPTIONS = [
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
] as const;

const ZOOM_OPTIONS = [
  { label: "紧凑", scale: 0.85 },
  { label: "标准", scale: 1 },
  { label: "放大", scale: 1.2 },
] as const;

const AXIS_WIDTH = 34;
const ROW_HEIGHT = 8;
const HEADER_HEIGHT = 30;
const DISPLAY_TIME_ZONE = "Asia/Shanghai";

function formatDateTime(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: DISPLAY_TIME_ZONE,
  }).format(new Date(date));
}

function shouldShowGpuLabel(rowIndex: number, totalGpuCount: number) {
  return (rowIndex + 1) % 8 === 0 || rowIndex === totalGpuCount - 1;
}

function getOpacity(intensity: number) {
  return Math.max(0.25, Math.min(1, intensity));
}

export function InteractiveHeatmap({
  heatmap,
  totalGpuCount,
}: InteractiveHeatmapProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const headerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoveredKeyRef = useRef<string | null>(null);
  const [rangeHours, setRangeHours] = useState<(typeof RANGE_OPTIONS)[number]["hours"]>(24);
  const [zoomScale, setZoomScale] = useState<(typeof ZOOM_OPTIONS)[number]["scale"]>(1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [hasAutoScrolled, setHasAutoScrolled] = useState(false);

  const gpuLabelRows = useMemo(
    () =>
      Array.from({ length: totalGpuCount }, (_, index) => index).filter((rowIndex) =>
        shouldShowGpuLabel(rowIndex, totalGpuCount),
      ),
    [totalGpuCount],
  );

  useEffect(() => {
    const node = viewportRef.current;

    if (!node) {
      return;
    }

    const updateWidth = () => {
      setViewportWidth(node.clientWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const node = viewportRef.current;

    if (!node) {
      return;
    }

    let frameId = 0;

    const handleScroll = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        setScrollLeft(node.scrollLeft);
      });
    };

    handleScroll();
    node.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      cancelAnimationFrame(frameId);
      node.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const baseWidth =
    viewportWidth > 0
      ? Math.max(6, (viewportWidth - AXIS_WIDTH) / rangeHours)
      : rangeHours === 24
        ? 30
        : rangeHours === 72
          ? 10
          : 6;
  const cellWidth = Math.max(4, baseWidth * zoomScale);
  const gridWidth = heatmap.totalHours * cellWidth;
  const bodyHeight = totalGpuCount * ROW_HEIGHT;
  const boardWidth = AXIS_WIDTH + gridWidth;
  const visibleGridWidth = Math.max(0, viewportWidth - AXIS_WIDTH);
  const labelInterval = rangeHours === 24 ? 2 : rangeHours === 72 ? 8 : 24;
  const visibleStartIndex = Math.max(0, Math.floor(scrollLeft / cellWidth) - 2);
  const visibleEndIndex = Math.min(
    heatmap.totalHours - 1,
    Math.ceil((scrollLeft + visibleGridWidth) / cellWidth) + 2,
  );
  const markerLeft = AXIS_WIDTH + heatmap.currentHourIndex * cellWidth - scrollLeft;
  const markerVisible =
    markerLeft >= AXIS_WIDTH - cellWidth && markerLeft <= AXIS_WIDTH + visibleGridWidth + cellWidth;

  useEffect(() => {
    const node = viewportRef.current;

    if (!node || viewportWidth <= 0) {
      return;
    }

    const targetScrollLeft = Math.max(0, heatmap.currentHourIndex * cellWidth);

    if (!hasAutoScrolled) {
      node.scrollLeft = targetScrollLeft;
      setScrollLeft(targetScrollLeft);
      setHasAutoScrolled(true);
      return;
    }

    node.scrollLeft = targetScrollLeft;
    setScrollLeft(targetScrollLeft);
  }, [cellWidth, hasAutoScrolled, heatmap.currentHourIndex, viewportWidth]);

  useEffect(() => {
    const canvas = headerCanvasRef.current;

    if (!canvas || visibleGridWidth <= 0) {
      return;
    }

    const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(visibleGridWidth * dpr));
    canvas.height = Math.max(1, Math.round(HEADER_HEIGHT * dpr));
    canvas.style.width = `${visibleGridWidth}px`;
    canvas.style.height = `${HEADER_HEIGHT}px`;

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, visibleGridWidth, HEADER_HEIGHT);
    context.textAlign = "center";
    context.textBaseline = "bottom";

    for (let columnIndex = visibleStartIndex; columnIndex <= visibleEndIndex; columnIndex += 1) {
      const column = heatmap.columns[columnIndex];
      const x = columnIndex * cellWidth - scrollLeft;
      const showDateLabel = column.dateLabel !== null;
      const showTimeLabel = rangeHours === 168 ? false : columnIndex % labelInterval === 0;

      if (!showDateLabel && !showTimeLabel) {
        continue;
      }

      context.fillStyle = column.overbookedGpuCount > 0 ? "#b0463c" : "#5c7284";
      context.font = showDateLabel ? '10px "Avenir Next", "PingFang SC", sans-serif' : '11px "Avenir Next", "PingFang SC", sans-serif';

      if (showDateLabel && column.dateLabel) {
        context.fillText(column.dateLabel, x + cellWidth / 2, 12);
      }

      if (showTimeLabel) {
        context.font = '11px "Avenir Next", "PingFang SC", sans-serif';
        context.fillText(column.label, x + cellWidth / 2, HEADER_HEIGHT - 2);
      }
    }
  }, [
    cellWidth,
    heatmap.columns,
    labelInterval,
    rangeHours,
    scrollLeft,
    visibleEndIndex,
    visibleGridWidth,
    visibleStartIndex,
  ]);

  useEffect(() => {
    const canvas = bodyCanvasRef.current;

    if (!canvas || visibleGridWidth <= 0) {
      return;
    }

    const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(visibleGridWidth * dpr));
    canvas.height = Math.max(1, Math.round(bodyHeight * dpr));
    canvas.style.width = `${visibleGridWidth}px`;
    canvas.style.height = `${bodyHeight}px`;

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, visibleGridWidth, bodyHeight);

    for (let rowIndex = 0; rowIndex < totalGpuCount; rowIndex += 1) {
      const top = rowIndex * ROW_HEIGHT;

      for (let columnIndex = visibleStartIndex; columnIndex <= visibleEndIndex; columnIndex += 1) {
        const column = heatmap.columns[columnIndex];
        const left = Math.round(columnIndex * cellWidth - scrollLeft);
        const right = Math.round((columnIndex + 1) * cellWidth - scrollLeft);
        const width = Math.max(1, right - left);
        const taskId = column.taskIds[rowIndex];

        if (taskId) {
          const task = heatmap.tasks[taskId];
          context.globalAlpha = getOpacity(column.intensities[rowIndex]);
          context.fillStyle = task?.color ?? "rgba(33, 118, 166, 0.7)";
          context.fillRect(left, top, width, ROW_HEIGHT);
          context.globalAlpha = 1;
        } else {
          context.fillStyle = "rgba(33, 128, 111, 0.08)";
          context.fillRect(left, top, width, ROW_HEIGHT);
        }
      }
    }
  }, [
    bodyHeight,
    cellWidth,
    heatmap.columns,
    heatmap.tasks,
    scrollLeft,
    totalGpuCount,
    visibleEndIndex,
    visibleGridWidth,
    visibleStartIndex,
  ]);

  let hoverSummary: string;

  if (!hovered) {
    hoverSummary = "悬停任意格子查看该时间段的任务信息。";
  } else if (!hovered.task) {
    hoverSummary = `GPU ${hovered.rowIndex + 1} | ${formatDateTime(
      hovered.slotStart,
    )} - ${formatDateTime(hovered.slotEnd)} | 空闲`;
  } else {
    hoverSummary = [
      `GPU ${hovered.rowIndex + 1}`,
      hovered.task.username,
      hovered.task.task,
      `${hovered.task.gpuCount} 卡`,
      `${Math.round(hovered.intensity * 100)}% 小时覆盖`,
      `${formatDateTime(hovered.task.startAt)} - ${formatDateTime(hovered.task.endAt)}`,
    ].join(" | ");
  }

  function updateHoveredCell(rowIndex: number, columnIndex: number) {
    const column = heatmap.columns[columnIndex];
    const taskId = column.taskIds[rowIndex];
    const task = taskId ? heatmap.tasks[taskId] : null;
    const key = `${rowIndex}:${columnIndex}:${taskId ?? "free"}`;

    if (hoveredKeyRef.current === key) {
      return;
    }

    hoveredKeyRef.current = key;
    setHovered({
      rowIndex,
      columnIndex,
      task,
      intensity: column.intensities[rowIndex],
      slotStart: column.slotStart,
      slotEnd: column.slotEnd,
    });
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = bodyCanvasRef.current;

    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const columnIndex = Math.floor((scrollLeft + x) / cellWidth);
    const rowIndex = Math.floor(y / ROW_HEIGHT);

    if (
      columnIndex < 0 ||
      columnIndex >= heatmap.totalHours ||
      rowIndex < 0 ||
      rowIndex >= totalGpuCount
    ) {
      return;
    }

    updateHoveredCell(rowIndex, columnIndex);
  }

  function handleCanvasPointerLeave() {
    hoveredKeyRef.current = null;
    setHovered(null);
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.controls}>
          <div className={styles.controlGroup}>
            {RANGE_OPTIONS.map((option) => (
              <button
                className={`${styles.controlButton} ${
                  rangeHours === option.hours ? styles.controlButtonActive : ""
                }`}
                key={option.hours}
                onClick={() => setRangeHours(option.hours)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className={styles.controlGroup}>
            {ZOOM_OPTIONS.map((option) => (
              <button
                className={`${styles.controlButton} ${
                  zoomScale === option.scale ? styles.controlButtonActive : ""
                }`}
                key={option.label}
                onClick={() => setZoomScale(option.scale)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <p className={styles.hoverSummary}>{hoverSummary}</p>
      </div>

      <div className={styles.scrollViewport} ref={viewportRef}>
        <div className={styles.spacer} style={{ width: `${boardWidth}px`, height: `${HEADER_HEIGHT + 3 + bodyHeight}px` }}>
          <div className={styles.stickyLayer} style={{ width: `${Math.max(viewportWidth, 160)}px` }}>
            {markerVisible ? (
              <div
                aria-hidden="true"
                className={styles.currentTimeMarker}
                style={{
                  left: `${markerLeft}px`,
                  width: `${Math.max(2, Math.min(6, cellWidth * 0.18))}px`,
                }}
              />
            ) : null}

            <div className={styles.axisHeader}>
              <div className={styles.axisCorner}>GPU</div>
              <div className={styles.headerCanvasWrap} style={{ width: `${visibleGridWidth}px`, height: `${HEADER_HEIGHT}px` }}>
                <canvas className={styles.canvas} ref={headerCanvasRef} />
              </div>
            </div>

            <div className={styles.body}>
              <div className={styles.gpuAxis} style={{ height: `${bodyHeight}px` }}>
                {gpuLabelRows.map((rowIndex) => (
                  <div
                    className={styles.gpuAxisLabel}
                    key={rowIndex}
                    style={{ top: `${rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2}px` }}
                  >
                    {rowIndex + 1}
                  </div>
                ))}
              </div>

              <div className={styles.canvasWrap} style={{ width: `${visibleGridWidth}px`, height: `${bodyHeight}px` }}>
                <canvas
                  className={styles.canvas}
                  onPointerLeave={handleCanvasPointerLeave}
                  onPointerMove={handleCanvasPointerMove}
                  ref={bodyCanvasRef}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
