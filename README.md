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

本项目使用一个轻量 Worker 做密码校验，并通过 Workers Static Assets 提供网页，不需要构建步骤。

- Worker 名称：`muti-monitor`
- 生产分支：`main`
- Build command：留空
- Deploy command：`npx wrangler deploy`
- Root directory：留空（使用仓库根目录）

`wrangler.jsonc` 会让所有请求先进入 `src/worker.js` 完成密码校验，再从 `public/` 提供静态资源。

## 隐私

仓库中不包含 GitHub 部署私钥、Cloudflare 凭据、访问密码或账户信息。Worker 采用 HTTP Basic Authentication，并对所有静态资源强制校验。

在 Cloudflare Worker 的 `Settings` > `Variables and Secrets` 中添加：

- Type：`Secret`
- Name：`ACCESS_PASSWORD`
- Value：自行设置至少 12 个字符的强密码

默认用户名是 `monitor`。如需修改，可以另加一个文本变量 `ACCESS_USERNAME`。密码未配置或少于 12 个字符时，Worker 会返回 `503`，不会公开网页。

请勿将真实密码写入 `wrangler.jsonc`、GitHub 仓库、构建变量或聊天消息。

## 数据来源

网页在访问者浏览器中直接调用 Binance Futures 公开 REST 和 WebSocket 接口。K 线缓存只保存在当前浏览器的 IndexedDB 中，不会提交到 GitHub。
