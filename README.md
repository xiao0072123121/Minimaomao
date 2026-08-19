# muti-monitor

轻量的 Binance 多标的价格行为监测网页。

## 当前功能

- 支持 XAUUSDT、SNDKUSDT、SKHYNIXUSDT 切换。
- 实时链路只订阅 Binance Mark Price；断线时使用价格接口低频回退。
- 历史数据只请求 H4 与 H1 K线，并立即裁剪为 `time/open/high/low/close/closeTime`。
- H4最多常驻240根、H1最多常驻320根，切换标的后旧标的数组立即释放。
- 浏览器 IndexedDB 只保存限长后的OHLC缓存，页面启动后按需读取。
- 支撑压力延用上一版结构区域模式：已确认H4/H1摆动点、前日/前周高低与突破回踩共同提供候选位置。
- 相近位置按 `max(0.25×ATR, 价格×0.10%)` 合并，区域宽度限制在 `0.20–0.60×ATR`。
- 区域强度综合离开幅度、有效反应、角色互换、时效与H4/H1共振；连续两根收盘有效穿越后失效。
- 页面不生成方向、评分、入场、止损、止盈或具体交易策略。

## 已停用的数据与计算

- 订单簿深度与买卖盘快照
- 成交明细、聚合成交和成交密集区
- 实时与历史成交量计算
- 24小时Ticker统计
- RSI、MACD、均线及SMC策略演算
- 所有前端回测任务

Worker只允许代理以下Binance接口：

- `/fapi/v1/ticker/price`
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
