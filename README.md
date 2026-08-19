# muti-monitor

Binance 多标的价格行为监测与实盘交易复盘网页。

## 当前功能

- 支持 XAUUSDT、SNDKUSDT、SKHYNIXUSDT 切换。
- 实时链路只订阅 Binance Mark Price；断线时使用价格接口低频回退。
- 每分钟读取一次24小时统计，只保留涨跌幅、最高价、最低价和最新成交价。
- 历史数据请求 H4、H1 与 M15 K线，并立即裁剪为 `time/open/high/low/close/closeTime`；M15只用于纯K线展示，不参与区域计算。
- H4最多常驻240根，H1与M15各最多常驻320根，切换标的后旧标的数组立即释放。
- 浏览器 IndexedDB 只保存限长后的OHLC缓存，页面启动后按需读取。
- 使用已收盘H4/H1摆动高低点、重复触碰和跨周期重合生成固定支撑压力区间。
- 通过表单录入已完成的实盘交易；填写开平仓价格、数量和杠杆后自动计算未计费用的盈亏，并记录开仓依据、退出原因和复盘备注。
- 可编辑、删除或排除单笔记录；旧版模拟账户、模拟持仓和模拟交易记录不参与实盘画像分析。
- 按自然周生成证据化周复盘，并基于累计实盘交易形成分级置信度的画像分析。
- 页面不自动生成真实交易指令，也不会连接或操作任何真实交易账户。

## 交易日志数据

- 交易日志保存在当前浏览器的 IndexedDB，不占用服务器内存。
- 当前打开页面时自动更新周复盘；后续如需跨设备同步和后台定时生成，可迁移到 Cloudflare D1。
- 清理浏览器数据会删除本地记录；当前版本不提供数据导出模块。

## 已停用的数据与计算

- 订单簿深度与买卖盘快照
- 成交明细、聚合成交和成交密集区
- 实时与历史成交量计算
- 24小时Ticker中的成交量、成交额和成交笔数
- RSI、MACD、均线及SMC策略演算
- 所有前端回测任务

Worker只允许代理以下Binance接口：

- `/fapi/v1/ticker/price`
- `/fapi/v1/ticker/24hr`（只用于24小时涨跌幅与区间）
- `/fapi/v1/klines`，且仅允许 `15m`、`1h`、`4h`，单次最多320根

## Cloudflare Workers 部署

本项目使用一个轻量 Worker 做密码校验，并通过 Workers Static Assets 提供网页，不需要构建步骤。

- Worker 名称：`muti-monitor`
- 生产分支：`main`
- Build command：留空
- Deploy command：`npx wrangler deploy`
- Root directory：留空（使用仓库根目录）

## 隐私

仓库不包含部署私钥、Cloudflare凭据或访问密码。Worker采用HTTP Basic Authentication。

在 Cloudflare Worker 的 `Settings` > `Variables and Secrets` 中添加：

- Type：`Secret`
- Name：`ACCESS_PASSWORD`
- Value：至少12个字符

默认用户名是 `monitor`；可通过文本变量 `ACCESS_USERNAME` 修改。
