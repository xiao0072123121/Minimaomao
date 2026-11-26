// Anonymous public lead records only. Incoming account credentials are never forwarded.
export const PORTFOLIO_ID = '5075281354358777856';
export const REFRESH_SECONDS = 120;
const PREFIX = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/';
const MAX_BYTES = 128 * 1024;
const PAGE_SIZE = 20;
const entries = new Map();
const pending = new Map();
const beijing = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

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
  return {position_id:String(row.positionId || ''),symbol:String(row.symbol || '—'),
    direction:({Long:'多',Short:'空'})[row.side] || '待确认',
    status:({'All Closed':'已全部平仓',Closed:'已平仓'})[row.status] || '状态待确认',
    opened_at:timestamp(row.opened),closed_at:timestamp(row.closed),closed_ms:number(row.closed),
    entry_price:number(row.avgCost),close_price:number(row.avgClosePrice),closed_quantity:number(row.closedVolume)};
}

export async function readBoundedJson(response) {
  if (response.status !== 200 || !response.body) throw new Error('币安暂未返回数据');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('币安响应超过读取上限');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchSection(section,fetcher) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),5000);
  try {
    let url = PREFIX + section;
    const options = {headers:{'Content-Type':'application/json'},signal:controller.signal};
    if (section === 'detail') url += '?portfolioId=' + PORTFOLIO_ID;
    else {
      options.method = 'POST';
      options.body = JSON.stringify({portfolioId:PORTFOLIO_ID,pageNumber:1,pageSize:PAGE_SIZE});
    }
    const result = await readBoundedJson(await fetcher(url,options));
    if (result?.code !== '000000' || result.success !== true || !result.data || typeof result.data !== 'object') throw new Error('币安接口暂不可用');
    const data = result.data;
    if (section === 'detail') {
      if (data.leadPortfolioId !== PORTFOLIO_ID) throw new Error('带单组合身份不匹配');
      return {nickname:data.nickname,status:data.status,positionShow:data.positionShow,lastTradeTime:data.lastTradeTime};
    }
    if (!Array.isArray(data.list) || data.list.length > PAGE_SIZE || data.list.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('币安记录结构异常');
    return {list:data.list,total:data.total};
  } finally { clearTimeout(timeout); }
}

export function createReader({fetcher = fetch, cache = null, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve,ms)), memory = entries, inflight = pending} = {}) {
  async function load(section,origin,context) {
    const key = new Request(`${origin}/__lead_records_v1/${PORTFOLIO_ID}/${section}`);
    let previous = memory.get(section);
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
      memory.set(section,previous);
      return previous;
    }
    if (inflight.has(section)) return inflight.get(section);
    const task = (async () => {
      let result;
      try {
        const data = await fetchSection(section,fetcher);
        result = {data,fetched_at:new Date(now()).toISOString(),error:null};
      } catch (_) {
        result = {data:previous?.data ?? null,fetched_at:previous?.fetched_at ?? null,error:'币安数据暂不可用，等待下一次刷新'};
      }
      result.attempt = now();
      memory.set(section,result);
      if (cache) {
        const write = cache.put(key,new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=86400'}})).catch(() => {});
        if (context?.waitUntil) context.waitUntil(write); else await write;
      }
      return result;
    })();
    inflight.set(section,task);
    try { return await task; } finally { inflight.delete(section); }
  }
  return async function snapshot(request,context) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return {error:'仅支持GET请求',http_status:405};
    if (url.search && [...url.searchParams].some(([key,value]) => key !== 'portfolio_id' || value !== PORTFOLIO_ID)) return {error:'尚未配置这个带单组合',http_status:400};
    const result = {portfolio_id:PORTFOLIO_ID,source:'Binance 公开带单记录',source_url:`https://www.binance.bh/zh-CN/copy-trading/lead-details/${PORTFOLIO_ID}`,timezone:'Asia/Shanghai',refresh_seconds:REFRESH_SECONDS,checked_at:new Date(now()).toISOString()};
    let first = true;
    for (const [name,section,normalize] of [['orders','order-history',normalizeOrder],['positions','position-history',normalizePosition],['profile','detail',null]]) {
      // Space reads on a cold request; cached sections do not create upstream traffic.
      if (!first && !memory.has(section)) await wait(1200);
      first = false;
      const saved = await load(section,url.origin,context);
      const view = {status:saved.data == null ? 'unavailable' : saved.error ? 'stale' : 'ok',fetched_at:saved.fetched_at,error:saved.error};
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
export async function copyTradingSnapshot(request,context) {
  const edgeCache = typeof caches !== 'undefined' ? caches.default : null;
  if (!edgeCache) return defaultReader(request,context);
  return createReader({cache:edgeCache})(request,context);
}
