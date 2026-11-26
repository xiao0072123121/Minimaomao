# 独立公开记录读取服务

Cloudflare Workers 对币安公开接口的请求已在官方真实运行环境复现 HTTP 403，
本地成功不能作为线上取数成功的证据。此服务只为正确的 Minimaomao 网页提供
匿名公开记录，不包含网页、账户登录、真实订单或通用代理功能。

仅接受导出的组合白名单、三个固定查询接口和第一页20条记录；源响应上限128 KiB。
缓存和失败冷却均为120秒。失败保留上次成功记录及其原始获取时间；
Worker 依据 `X-Source-Fetched-At` 和 `X-Source-Stale` 展示真实新鲜度。
服务为单进程，缓存最多16个组合×3类，内存设计低于64 MiB；
地址空间限384 MiB，systemd内存限512 MiB，健康检查提供逐进程峰值RSS。

上线前必须先在已授权主机只读验证相同接口确实返回正常数据；未验证不得切换。
部署主机和路径必须在用户授权范围内；对先前已撤销的主机需要重新明确授权。

部署准备：

1. `node tools/lead-relay/export-registry.mjs > traders.json` 导出当前名单。
2. 只安装 `server.py`、`traders.json` 到独立目录 `/opt/minimaomao-copy-relay/`。
3. 使用工作区唯一配置源 `platform-deployment/systemd/minimaomao-copy-relay.service` 安装独立 unit，确认8937端口空闲。只启动本服务。
4. 使用唯一 Nginx 配置源 `platform-deployment/nginx/research-routes/minimaomao-copy.conf`，在现有HTTPS站点添加专用 location；先 `nginx -t`，再平滑 reload。
5. 从真实Worker测试该HTTPS地址的三类查询，核对身份、行数、价格与来源时间。
6. 正确网站 Worker 的 `COPY_TRADING_RELAY_PREFIX` 固定为已经验证的HTTPS地址；
   可用同名环境变量覆盖。不修改现有网站登录变量。
7. 验证生产接口及页面后才可报告修复。保留回滚：回滚对应 Worker 版本即可恢复原取数链路；
   删除专用 location、停用独立服务不会改变现有网页或其它服务。

新增带单员需重新导出白名单并只重启本服务。服务状态必须通过远端健康检查与真实 Worker 查询核验，
不能只凭本地测试或部署版本标识报告生产取数成功。
