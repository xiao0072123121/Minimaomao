import assert from 'node:assert/strict';
import {createReader,normalizeOrder,normalizePosition,readBoundedJson,PORTFOLIO_ID,TRADERS} from '../src/copy-trading.js';
import worker from '../src/worker.js';

const incoming = () => new Request('https://minimaomao.zhoum-n.workers.dev/api/copy-trading',{headers:{Authorization:'Basic test-only'}});
const order = {symbol:'BTCUSDT',side:'BUY',positionSide:'LONG',orderTime:1795650989796,avgPrice:0.0417741,executedQty:12};
const position = {symbol:'BTCUSDT',side:'Short',status:'All Closed',opened:1795650989796,closed:1795650999796,avgCost:5,avgClosePrice:4,closedVolume:2};
let time = 1795660000000, calls = 0, failing = false;
const fetcher = async (url,options) => {
  calls++;
  assert.equal(new URL(url).hostname,'www.binance.com');
  assert.equal(new Headers(options.headers).has('Authorization'),false);
  let data;
  if (url.includes('/detail?')) data = {leadPortfolioId:PORTFOLIO_ID,nickname:'test',positionShow:false};
  else {
    assert.equal(options.method,'POST');
    assert.deepEqual(JSON.parse(options.body),{portfolioId:PORTFOLIO_ID,pageNumber:1,pageSize:20});
    data = {list:url.endsWith('order-history') ? [order,{...order,orderTime:order.orderTime+1000}] : [position],total:2};
  }
  return new Response(JSON.stringify(failing ? {code:'11012005',success:false} : {code:'000000',success:true,data}));
};
const reader = createReader({fetcher,now:()=>time,wait:async()=>{},memory:new Map(),inflight:new Map()});
const first = await reader(incoming());
assert.equal(calls,3);
assert.equal(first.orders.status,'ok');
assert.equal(first.profile.data.positionShow,false);
assert.equal(first.orders.rows[1].time,'2026-11-26 07:56:29');
assert(first.orders.rows[0].time_ms>first.orders.rows[1].time_ms);
await reader(incoming());
assert.equal(calls,3,'fresh cached data must not create extra upstream requests');

time += 120001; failing = true;
const stale = await reader(incoming());
assert.equal(stale.orders.status,'stale');
assert.deepEqual(stale.orders.rows,first.orders.rows);
assert.equal(stale.orders.fetched_at,first.orders.fetched_at,'failure must not advance source timestamp');
assert.equal(calls,6);
await reader(incoming());
assert.equal(calls,6,'upstream failures must also be cached for cooldown');

const rejected = await reader(new Request('https://test/api/copy-trading?portfolio_id=https://evil.invalid'));
assert.equal(rejected.http_status,400);assert.equal(calls,6);
assert.equal((await reader(new Request('https://test/api/copy-trading',{method:'POST'}))).http_status,405);

for (const side of ['BUY','SELL']) assert.match(normalizeOrder({side,positionSide:'BOTH',totalPnl:0}).action,/开平待确认/);
assert.equal(normalizeOrder({side:'BUY',positionSide:'SHORT'}).action,'平空/减空');
assert.equal(normalizeOrder({avgPrice:'NaN'}).price,null);
assert.equal(normalizePosition({}).entry_price,null);

await assert.rejects(readBoundedJson(new Response(new Uint8Array(128*1024+1))),/上限/);
await assert.rejects(readBoundedJson(new Response('',{status:202})),/HTTP 202/);

const password='local-test-password-only';
const env={ACCESS_PASSWORD:password,ASSETS:{fetch(){throw new Error('unexpected asset access');}}};
const unauthenticated = await worker.fetch(new Request('https://test/api/copy-trading'),env,{});
assert.equal(unauthenticated.status,401,'new API must remain behind existing Basic authentication');
assert.equal(unauthenticated.headers.get('X-App-Version'),'20261126-entry-columns');
const auth={Authorization:'Basic '+btoa('monitor:'+password)};
const invalid = await worker.fetch(new Request('https://test/api/copy-trading?portfolio_id=invalid',{headers:auth}),env,{});
assert.equal(invalid.status,400);
const badMethod = await worker.fetch(new Request('https://test/api/copy-trading',{headers:auth,method:'POST'}),env,{});
assert.equal(badMethod.status,405);
console.log('copy trading: source identity, size bounds, auth, method restriction, cache/backoff, timestamps and direction checks passed');

// Distinct portfolios must never share rows, profile data, stale fallbacks or pending reads.
const multiCalls = [], failingIds = new Set();
let multiTime = 1795660000000;
const multiFetcher = async (url,options) => {
  const portfolioId = url.includes('/detail?') ? new URL(url).searchParams.get('portfolioId') : JSON.parse(options.body).portfolioId;
  assert(TRADERS.some(trader => trader.id === portfolioId));
  multiCalls.push(portfolioId);
  if (failingIds.has(portfolioId)) return new Response(JSON.stringify({code:'11012005',success:false}));
  const symbol = 'TEST' + portfolioId.slice(-4) + 'USDT';
  const data = url.includes('/detail?') ? {leadPortfolioId:portfolioId,nickname:portfolioId,positionShow:false} :
    {list:url.endsWith('order-history') ? [{...order,symbol}] : [{...position,symbol}],total:1};
  return new Response(JSON.stringify({code:'000000',success:true,data}));
};
const multiReader = createReader({fetcher:multiFetcher,now:()=>multiTime,wait:async()=>{},memory:new Map(),inflight:new Map()});
const forTrader = id => new Request('https://test/api/copy-trading?portfolio_id=' + id);
const snapshots = await Promise.all(TRADERS.map(trader => multiReader(forTrader(trader.id))));
assert.equal(multiCalls.length,TRADERS.length*3);
for (const [index,data] of snapshots.entries()) {
  const trader = TRADERS[index];
  assert.equal(data.portfolio_id,trader.id);
  assert.equal(data.profile.data.nickname,trader.id);
  assert.equal(data.orders.rows[0].symbol,'TEST'+trader.id.slice(-4)+'USDT');
  assert.equal(data.positions.rows[0].symbol,data.orders.rows[0].symbol);
}
multiTime += 120001;
failingIds.add(TRADERS[1].id);
const failedTrader = await multiReader(forTrader(TRADERS[1].id));
assert.equal(failedTrader.orders.status,'stale');
assert.equal(failedTrader.orders.fetched_at,snapshots[1].orders.fetched_at);
assert.deepEqual(failedTrader.orders.rows,snapshots[1].orders.rows);
const otherTrader = await multiReader(forTrader(TRADERS[2].id));
assert.equal(otherTrader.orders.status,'ok');
assert.notEqual(otherTrader.orders.rows[0].symbol,failedTrader.orders.rows[0].symbol);
const beforeConcurrent = multiCalls.length;
const both = await Promise.all([multiReader(forTrader(TRADERS[3].id)),multiReader(forTrader(TRADERS[3].id))]);
assert.equal(multiCalls.length-beforeConcurrent,3,'concurrent reads for one trader should share in-flight fetches');
assert.deepEqual(both[0].orders.rows,both[1].orders.rows);
assert.equal((await multiReader(new Request(`https://test/api/copy-trading?portfolio_id=${PORTFOLIO_ID}&portfolio_id=${TRADERS[1].id}`))).http_status,400);
console.log('configured traders: concurrent/cache identity isolation, independent failure fallback and single-flight checks passed');

// The reproduced cloud failure must stay diagnosable, rather than look like no trades.
const sharedMemory = new Map();
const blockedReader = createReader({fetcher:async()=>new Response('<html>Forbidden</html>',{status:403}),wait:async()=>{},memory:sharedMemory,inflight:new Map()});
const blocked = await blockedReader(incoming());
assert.equal(blocked.orders.status,'unavailable');
assert.match(blocked.orders.error,/HTTP 403/);
assert.equal(blocked.orders.diagnostic.http_status,403);
assert.equal(blocked.orders.diagnostic.upstream_host,'www.binance.com');
assert.equal(blocked.orders.fetched_at,null);

const sourceTime = '2026-11-26T04:00:00.000Z';
let relayStale = false, relayHeaders = true, relayTime = time;
const relayReader = createReader({prefix:'https://approved-relay.test/lead-portfolio/',now:()=>relayTime,wait:async()=>{},memory:sharedMemory,inflight:new Map(),fetcher:async(url,options)=>{
  assert.equal(new URL(url).hostname,'approved-relay.test');
  assert.equal(new Headers(options.headers).has('Authorization'),false);
  const data = url.includes('/detail?') ? {leadPortfolioId:PORTFOLIO_ID,nickname:'relay'} : {list:url.endsWith('order-history') ? [order] : [position],total:1};
  return new Response(JSON.stringify({code:'000000',success:true,data}),{headers:relayHeaders?{'X-Source-Fetched-At':sourceTime,'X-Source-Stale':relayStale?'1':'0'}:{}});
}});
const relayed = await relayReader(incoming());
assert.equal(relayed.orders.status,'ok','direct-source failure cache must not block a different configured source');
assert.equal(relayed.orders.rows.length,1);
assert.equal(relayed.orders.fetched_at,sourceTime,'a cached relay response must not acquire a new timestamp');
relayTime += 120001; relayStale = true;
const relayOld = await relayReader(incoming());
assert.equal(relayOld.orders.status,'stale');
assert.equal(relayOld.orders.fetched_at,sourceTime);
assert.equal(relayOld.orders.diagnostic.code,'SOURCE_STALE');
relayTime += 120001; relayHeaders = false;
const missingTime = await relayReader(incoming());
assert.equal(missingTime.orders.status,'stale');
assert.equal(missingTime.orders.diagnostic.code,'INVALID_SOURCE_TIME');
assert.equal(missingTime.orders.fetched_at,sourceTime);
console.log('cloud HTTP diagnostics, isolated source caches and honest relay timestamps passed');
