# GPU Cluster Dashboard

一个适合直接部署到 Vercel 的轻量 GPU 集群占用看板。

## 功能

- 首页展示 64 卡集群当前占用、空闲数量、利用率和超占提醒
- 无需登录即可汇报用卡情况，但必须填写用户名和任务名
- 支持填写 GPU 数量、使用时长和开始时间
- 展示当前活跃任务、即将开始任务和最近提交记录

## 本地开发

```bash
npm install
npm run dev
```

默认会把数据写入 `data/reports.json`。

如果本地已经配置 `POSTGRES_URL` 或 `DATABASE_URL`，则会优先写入 Postgres。

### 安全相关环境变量

- `WRITE_TOKEN`
  - 可选。配置后，提交用卡任务时必须填写写入口令。
- `ADMIN_TOKEN`
  - 建议必配。删除任务时必须提供管理员口令；如果没配，前端删除按钮会报错，后端也会拒绝删除。

接口还带了一层基础内存限流：

- 上报接口：5 分钟内每个 IP 最多 20 次
- 删除接口：10 分钟内每个 IP 最多 10 次

注意：这是 serverless 环境下的 best-effort 限流，不是分布式强一致限流。如果你后面需要更强的防刷保护，应该换成 Upstash Redis / Vercel KV 之类的集中式限流。

## 部署到 Vercel 持久化

推荐使用 Postgres。

1. 导入该项目到 Vercel
2. 添加环境变量 `TOTAL_GPU_COUNT=64`
3. 添加环境变量 `DISPLAY_TIME_ZONE=Asia/Shanghai`
4. 建议添加环境变量 `ADMIN_TOKEN=...`
5. 如果希望控制谁能上报，再添加环境变量 `WRITE_TOKEN=...`
6. 在 Vercel Marketplace 安装一个 Postgres 集成，例如 Neon
7. 让集成为项目注入数据库连接环境变量
8. 重新部署项目

代码会优先读取这些环境变量：

- `POSTGRES_URL`
- `DATABASE_URL`
- `POSTGRES_PRISMA_URL`

首次写入时会自动创建 `gpu_usage_reports` 表。
首次删除时也会自动创建 `gpu_usage_audit_log` 审计表，用来记录被删除的任务快照、删除人来源和删除时间。

## Blob 兼容模式

如果未配置 Postgres，但配置了 `BLOB_READ_WRITE_TOKEN`，应用仍然会退回到 Vercel Blob 存储。

注意：当前 Blob 兼容模式仍然是公开对象存储，适合快速上线，不适合存放敏感任务信息；只要要长期使用，还是建议切到 Postgres。

如果两者都未配置：

- 本地开发仍会使用 `data/reports.json`
- Vercel 线上环境不会再尝试写入只读文件系统
- 首页可以正常打开，但提交任务会提示你先配置 Postgres 或 Blob
