import { DeleteReportButton } from "@/components/DeleteReportButton";
import { InteractiveHeatmap } from "@/components/InteractiveHeatmap";
import { ReportForm } from "@/components/ReportForm";
import {
  formatDateTime,
  getDashboardData,
  getStorageModeLabel,
} from "@/lib/gpu-reports";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

function formatPercent(value: number) {
  const percent = (value * 100).toFixed(1);
  return `${percent.endsWith(".0") ? percent.slice(0, -2) : percent}%`;
}

function formatAverageGpu(value: number) {
  const average = value.toFixed(1);
  return average.endsWith(".0") ? average.slice(0, -2) : average;
}

export default async function HomePage() {
  const data = await getDashboardData();

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroTop}>
          <div className={styles.intro}>
            <div className={styles.heroTitleRow}>
              <h1 className={styles.title}>64 卡集群占用看板</h1>
              <div className={styles.meta}>
                <div className={styles.pill}>
                  视图
                  <strong>24h Heatmap</strong>
                </div>
                <div className={styles.pill}>
                  数据存储
                  <strong>{getStorageModeLabel()}</strong>
                </div>
                <div className={styles.pill}>
                  总卡数
                  <strong>{data.totalGpuCount}</strong>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.heroForm}>
          <ReportForm />
        </div>

        <div className={styles.stats}>
          <article className={styles.statCard}>
            <span className={styles.statLabel}>当前已占用</span>
            <strong className={styles.statValue}>{data.usedGpuCount}</strong>
            <span className={styles.statHint}>来自 {data.activeReports.length} 个活跃任务</span>
          </article>

          <article className={styles.statCard}>
            <span className={styles.statLabel}>当前空闲</span>
            <strong className={styles.statValue}>{data.freeGpuCount}</strong>
            <span className={styles.statHint}>可立即继续上报使用</span>
          </article>

          <article className={styles.statCard}>
            <span className={styles.statLabel}>当前利用率</span>
            <strong className={styles.statValue}>{formatPercent(data.utilizationRatio)}</strong>
            <span className={styles.statHint}>按 {data.totalGpuCount} 卡容量计算</span>
          </article>

          <article className={styles.statCard}>
            <span className={styles.statLabel}>超占提醒</span>
            <strong className={styles.statValue}>{data.overbookedGpuCount}</strong>
            <span className={styles.statHint}>大于 0 说明当前汇报总量已超容量</span>
          </article>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>平均占用率</h2>
          <p>按报卡时间区间积分计算，不只是整点快照。</p>
        </div>

        <div className={styles.averageGrid}>
          {data.utilizationWindows.map((window) => (
            <article className={styles.averageCard} key={window.label}>
              <span className={styles.statLabel}>{window.label}</span>
              <strong className={styles.statValue}>{formatPercent(window.ratio)}</strong>
              <span className={styles.statHint}>
                平均约 {formatAverageGpu(window.averageUsedGpuCount)} / {data.totalGpuCount} 卡
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>GPU 卡位 × 时间图</h2>
          <p>默认定位当前整点，可查看过去 7 天到未来 7 天。</p>
        </div>

        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <i className={`${styles.legendSwatch} ${styles.legendUsed}`} />
            已占用
          </span>
          <span className={styles.legendItem}>
            <i className={`${styles.legendSwatch} ${styles.legendFree}`} />
            空闲
          </span>
          {data.heatmap.peakOverbookedGpuCount > 0 ? (
            <span className={styles.legendWarning}>
              某些小时平均超占最多 {data.heatmap.peakOverbookedGpuCount} 卡
            </span>
          ) : null}
        </div>

        <InteractiveHeatmap heatmap={data.heatmap} totalGpuCount={data.totalGpuCount} />

        <p className={styles.footnote}>
          热力图中的颜色表示当前小时内被映射到该虚拟卡位的任务。由于未绑定物理卡号，这里展示的是虚拟卡位分配，而不是物理 GPU 编号。
        </p>
      </section>

      <section className={styles.main}>
        <div className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>当前活跃任务</h2>
              <p>按结束时间排序</p>
            </div>

            <div className={styles.list}>
              {data.activeReports.length ? (
                data.activeReports.map((report) => (
                  <article className={styles.card} key={report.id}>
                    <div className={styles.cardTop}>
                      <h3>{report.task}</h3>
                      <div className={styles.cardActions}>
                        <span className={styles.badge}>{report.gpuCount} 卡</span>
                        <DeleteReportButton
                          reportId={report.id}
                          task={report.task}
                          username={report.username}
                        />
                      </div>
                    </div>
                    <div className={styles.cardMeta}>
                      <span>用户：{report.username}</span>
                      <span>开始：{formatDateTime(report.startAt)}</span>
                      <span>结束：{formatDateTime(report.endAt)}</span>
                      <span>时长：{report.durationHours} 小时</span>
                    </div>
                  </article>
                ))
              ) : (
                <p className={styles.empty}>当前没有活跃中的报卡记录。</p>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>即将开始</h2>
              <p>未来已汇报的任务</p>
            </div>

            <div className={styles.list}>
              {data.upcomingReports.length ? (
                data.upcomingReports.map((report) => (
                  <article className={styles.card} key={report.id}>
                    <div className={styles.cardTop}>
                      <h3>{report.task}</h3>
                      <div className={styles.cardActions}>
                        <span className={styles.badge}>{report.gpuCount} 卡</span>
                        <DeleteReportButton
                          reportId={report.id}
                          task={report.task}
                          username={report.username}
                        />
                      </div>
                    </div>
                    <div className={styles.cardMeta}>
                      <span>用户：{report.username}</span>
                      <span>开始：{formatDateTime(report.startAt)}</span>
                      <span>持续：{report.durationHours} 小时</span>
                    </div>
                  </article>
                ))
              ) : (
                <p className={styles.empty}>当前没有未来预约中的任务。</p>
              )}
            </div>
          </section>
        </div>

        <div className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>最近汇报</h2>
              <p>保留最近 8 条</p>
            </div>

            <div className={styles.list}>
              {data.recentReports.length ? (
                data.recentReports.map((report) => (
                  <article className={styles.card} key={report.id}>
                    <div className={styles.cardTop}>
                      <h3>{report.task}</h3>
                      <div className={styles.cardActions}>
                        <span className={styles.badge}>{report.username}</span>
                        <DeleteReportButton
                          reportId={report.id}
                          task={report.task}
                          username={report.username}
                        />
                      </div>
                    </div>
                    <div className={styles.cardMeta}>
                      <span>{report.gpuCount} 卡</span>
                      <span>{report.durationHours} 小时</span>
                      <span>提交：{formatDateTime(report.createdAt)}</span>
                    </div>
                  </article>
                ))
              ) : (
                <p className={styles.empty}>还没有任何汇报记录。</p>
              )}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
