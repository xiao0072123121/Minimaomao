# muti-monitor

Binance 多标的行情与技术分析网页，支持：

- XAUUSDT、SNDKUSDT、SKHYNIXUSDT 切换
- H4 / H1 / M15 动态趋势判断
- MA、MACD、RSI、支撑与压力分析
- 1 分钟至月线周期、5 日至全部时间范围
- MA20 / MA60 显示开关
- K 线、RSI 联动悬停和可视时间轴
- 浏览器 IndexedDB K 线缓存

## Cloudflare Workers 部署

本项目是纯静态网页，不需要构建步骤。

- Worker 名称：`muti-monitor`
- 生产分支：`main`
- Build command：留空
- Deploy command：`npx wrangler deploy`
- Root directory：留空（使用仓库根目录）

`wrangler.jsonc` 会将 `public/` 目录作为 Workers Static Assets 发布。

## 隐私

仓库中不包含 GitHub 部署私钥、Cloudflare 凭据或账户信息。上线后请使用 Cloudflare Access 限制访问者；`robots.txt` 不能代替访问控制。

## 数据来源

网页在访问者浏览器中直接调用 Binance Futures 公开 REST 和 WebSocket 接口。K 线缓存只保存在当前浏览器的 IndexedDB 中，不会提交到 GitHub。
