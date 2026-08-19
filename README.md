# muti-monitor

Binance 多标的价格行为监测、模拟交易与交易复盘网页。

## 当前功能

- 支持 XAUUSDT、SNDKUSDT、SKHYNIXUSDT 切换。
- 实时链路只订阅 Binance Mark Price；断线时使用价格接口低频回退。
- 每分钟读取一次24小时统计，只保留涨跌幅、最高价、最低价和最新成交价。
- 历史数据只请求 H4 与 H1 K线，并立即裁剪为 `time/open/high/low/close/closeTime`。
- H4最多常驻240根、H1最多常驻320根，切换标的后旧标的数组立即释放。
- 浏览器 IndexedDB 只保存限长后的OHLC缓存，页面启动后按需读取。
- 使用已收盘H4/H1摆动高低点、重复触碰和跨周期重合生成固定支撑压力区间。
- 使用真实 Binance Mark Price 建立模拟多空仓位，并自动监控模拟止损、止盈和手动平仓。
- 记录开仓理由、计划价位、持仓时长、退出原因、盈亏和R倍数。
- 按自然周生成证据化周复盘，并基于累计已完成交易形成分级置信度的习惯画像。
- 页面不自动生成真实交易指令，也不会连接或操作任何真实交易账户。

## 模拟账户数据

- 初始资金默认100,000 USDT，可在页面内重设。
- 第一版按1倍名义金额记账，暂不模拟手续费、滑点、资金费率和杠杆强平。
- 模拟账户、持仓和交易日志保存在当前浏览器的 IndexedDB，不占用服务器内存。
- 当前打开页面时自动更新周复盘；后续如需跨设备同步和后台定时生成，可迁移到 Cloudflare D1。
- 清理浏览器数据会删除本地记录，请使用页面内JSON/CSV导出功能定期备份。

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
- `/fapi/v1/klines`，且仅允许 `1h`、`4h`，单次最多320根

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
