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

## 部署到 Vercel 持久化

推荐使用 Postgres。

1. 导入该项目到 Vercel
2. 添加环境变量 `TOTAL_GPU_COUNT=64`
3. 添加环境变量 `DISPLAY_TIME_ZONE=Asia/Shanghai`
4. 在 Vercel Marketplace 安装一个 Postgres 集成，例如 Neon
5. 让集成为项目注入数据库连接环境变量
6. 重新部署项目

代码会优先读取这些环境变量：

- `POSTGRES_URL`
- `DATABASE_URL`
- `POSTGRES_PRISMA_URL`

首次写入时会自动创建 `gpu_usage_reports` 表。

## Blob 兼容模式

如果未配置 Postgres，但配置了 `BLOB_READ_WRITE_TOKEN`，应用仍然会退回到 Vercel Blob 存储。

如果两者都未配置：

- 本地开发仍会使用 `data/reports.json`
- Vercel 线上环境不会再尝试写入只读文件系统
- 首页可以正常打开，但提交任务会提示你先配置 Postgres 或 Blob
