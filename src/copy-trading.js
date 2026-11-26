// Anonymous public lead records only. Incoming account credentials are never forwarded.
export const PORTFOLIO_ID = '5075281354358777856';
export const TRADERS = Object.freeze([
  {id:PORTFOLIO_ID,name:'熬鹰资本'},
  {id:'5271501457743196416',name:'发烧好了呢'},
  {id:'5126298543040831233',name:'Bran Brandon'},
  {id:'4751838302089254401',name:'Btc星辰'},
  {id:'4532994172262753536',name:'Sky株式会社'},
  {id:'5108371059752839168',name:'鎏渊'},
]);
export const REFRESH_SECONDS = 120;
const PREFIX = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/';
const MAX_BYTES = 128 * 1024;
const PAGE_SIZE = 20;
const entries = new Map();
const pending = new Map();
const beijing = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

class SourceError extends Error {
  constructor(code,message,details = {}) { super(message); this.diagnostic = {code,...details}; }
}

function number(value) {
  if (value == null || typeof value === 'boolean' || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  const parsed = number(value);
  if (parsed == null || parsed <= 0 || parsed > 8640000000000000) return null;
  return beijing.format(new Date(parsed));
}

export function normalizeOrder(row) {
  const side = row.side, position = row.positionSide;
  const action = {'BUY:LONG':'开多/加多','SELL:LONG':'平多/减多','SELL:SHORT':'开空/加空','BUY:SHORT':'平空/减空'}[`${side}:${position}`]
    || ({BUY:'买入（开平待确认）',SELL:'卖出（开平待确认）'}[side]) || '方向待确认';
  return {symbol:String(row.symbol || '—'),side,position_side:position,action,
    time:timestamp(row.orderTime),time_ms:number(row.orderTime),updated_at:timestamp(row.orderUpdateTime),
    price:number(row.avgPrice),quantity:number(row.executedQty),base_asset:row.baseAsset,quote_asset:row.quoteAsset};
}

export function normalizePosition(row) {
  const closed = ['All Closed','Closed'].includes(row.status);
  const partial = row.status === 'Partially Closed' && row.closed == null;
  const state = closed ? 'closed' : partial ? 'open' : 'unknown';
  return {position_id:String(row.positionId || ''),symbol:String(row.symbol || '—'),
    direction:({Long:'多',Short:'空'})[row.side] || '待确认',
    status:({closed:'已平仓',open:'未平仓',unknown:'待确认'})[state],state,partial_closed:partial,source_status:row.status || null,
    opened_at:timestamp(row.opened),closed_at:timestamp(row.closed),closed_ms:number(row.closed),
    opened_ms:number(row.opened),updated_at:timestamp(row.updateTime),updated_ms:number(row.updateTime),
    entry_price:number(row.avgCost),close_price:number(row.avgClosePrice),closed_quantity:number(row.closedVolume)};
}

export async function readBoundedJson(response) {
  if (response.status !== 200 || !response.body) throw new SourceError('HTTP_ERROR',`数据源请求失败（HTTP ${response.status}）`,{http_status:response.status});
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new SourceError('RESPONSE_TOO_LARGE','币安响应超过读取上限');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch (_) { throw new SourceError('INVALID_JSON','数据源返回了非 JSON 响应'); }
}

async function fetchSection(section,fetcher,portfolioId,prefix) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),5000);
  try {
    let url = prefix + section;
    const options = {headers:{'Content-Type':'application/json'},signal:controller.signal};
    if (section === 'detail') url += '?portfolioId=' + portfolioId;
    else {
      options.method = 'POST';
      options.body = JSON.stringify({portfolioId,pageNumber:1,pageSize:PAGE_SIZE});
    }
    const response = await fetcher(url,options);
    const result = await readBoundedJson(response);
    if (result?.code !== '000000' || result.success !== true || !result.data || typeof result.data !== 'object') throw new SourceError('BINANCE_ERROR','币安接口返回错误',{binance_code:/^[A-Za-z0-9_-]{1,24}$/.test(result?.code) ? result.code : null});
    const data = result.data;
    let normalized;
    if (section === 'detail') {
      if (data.leadPortfolioId !== portfolioId) throw new SourceError('IDENTITY_MISMATCH','带单组合身份不匹配');
      normalized = {nickname:data.nickname,status:data.status,positionShow:data.positionShow,lastTradeTime:data.lastTradeTime};
    } else {
      if (!Array.isArray(data.list) || data.list.length > PAGE_SIZE || data.list.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new SourceError('INVALID_RECORDS','币安记录结构异常');
      normalized = {list:data.list,total:data.total};
    }
    const fetchedAt = response.headers.get('X-Source-Fetched-At');
    const stale = response.headers.get('X-Source-Stale') === '1';
    if (prefix !== PREFIX && (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt)))) throw new SourceError('INVALID_SOURCE_TIME','采集服务缺少有效获取时间');
    return {data:normalized,fetched_at:fetchedAt,stale};
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (controller.signal.aborted) throw new SourceError('TIMEOUT','数据源请求超时（5秒）');
    throw new SourceError('NETWORK_ERROR','服务器无法连接数据源');
  } finally { clearTimeout(timeout); }
}

export function createReader({fetcher = fetch, prefix = PREFIX, cache = null, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve,ms)), memory = entries, inflight = pending} = {}) {
  async function load(section,portfolioId,origin,context) {
    const cacheId = `${prefix}:${portfolioId}:${section}`;
    const key = new Request(`${origin}/__lead_records_v2/${encodeURIComponent(prefix)}/${portfolioId}/${section}`);
    let previous = memory.get(cacheId);
    if (!previous && cache) {
      try {
        const response = await cache.match(key);
        if (response) {
          const saved = await readBoundedJson(response);
          if (Number.isFinite(saved.attempt) && (saved.data === null || (saved.data && typeof saved.data === 'object'))) previous = saved;
        }
      } catch (_) { /* A missing or unusable edge cache does not make up data. */ }
    }
    if (previous && now() - previous.attempt < REFRESH_SECONDS * 1000) {
      memory.set(cacheId,previous);
      return previous;
    }
    if (inflight.has(cacheId)) return inflight.get(cacheId);
    const task = (async () => {
      let result;
      try {
        const source = await fetchSection(section,fetcher,portfolioId,prefix);
        result = {data:source.data,fetched_at:source.fetched_at || new Date(now()).toISOString(),error:source.stale ? '采集暂时失败，保留上次成功记录' : null,diagnostic:source.stale ? {code:'SOURCE_STALE',upstream_host:new URL(prefix).hostname} : null};
      } catch (error) {
        result = {data:previous?.data ?? null,fetched_at:previous?.fetched_at ?? null,error:error.message,diagnostic:{...error.diagnostic,upstream_host:new URL(prefix).hostname}};
      }
      result.attempt = now();
      memory.set(cacheId,result);
      if (cache) {
        const write = cache.put(key,new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=86400'}})).catch(() => {});
        if (context?.waitUntil) context.waitUntil(write); else await write;
      }
      return result;
    })();
    inflight.set(cacheId,task);
    try { return await task; } finally { inflight.delete(cacheId); }
  }
  return async function snapshot(request,context) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return {error:'仅支持GET请求',http_status:405};
    const portfolioId = url.searchParams.get('portfolio_id') || PORTFOLIO_ID;
    if ([...url.searchParams.keys()].some(key => key !== 'portfolio_id') || url.searchParams.getAll('portfolio_id').length > 1 || !TRADERS.some(trader => trader.id === portfolioId)) return {error:'尚未配置这个带单组合',http_status:400};
    const result = {portfolio_id:portfolioId,traders:TRADERS,source:'Binance 公开带单记录',source_url:`https://www.binance.bh/zh-CN/copy-trading/lead-details/${portfolioId}`,timezone:'Asia/Shanghai',refresh_seconds:REFRESH_SECONDS,checked_at:new Date(now()).toISOString()};
    let first = true;
    for (const [name,section,normalize] of [['orders','order-history',normalizeOrder],['positions','position-history',normalizePosition],['profile','detail',null]]) {
      // Space reads on a cold request; cached sections do not create upstream traffic.
      if (!first && !memory.has(`${prefix}:${portfolioId}:${section}`)) await wait(1200);
      first = false;
      const saved = await load(section,portfolioId,url.origin,context);
      const view = {status:saved.data == null ? 'unavailable' : saved.error ? 'stale' : 'ok',fetched_at:saved.fetched_at,error:saved.error,diagnostic:saved.diagnostic || null};
      if (normalize) {
        const key = name === 'orders' ? 'time_ms' : 'closed_ms';
        view.rows = (saved.data?.list || []).map(normalize).sort((a,b) => (b[key] || 0) - (a[key] || 0));
        view.total = saved.data?.total ?? null;
      } else view.data = saved.data;
      result[name] = view;
    }
    return result;
  };
}

const defaultReader = createReader();
export async function copyTradingSnapshot(request,context,relayPrefix = null) {
  const edgeCache = typeof caches !== 'undefined' ? caches.default : null;
  if (!edgeCache && !relayPrefix) return defaultReader(request,context);
  return createReader({cache:edgeCache,prefix:relayPrefix || PREFIX})(request,context);
}
