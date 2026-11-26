import assert from 'node:assert/strict';
import {createReader,normalizeOrder,normalizePosition,readBoundedJson,PORTFOLIO_ID} from '../src/copy-trading.js';
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
await assert.rejects(readBoundedJson(new Response('',{status:202})),/暂未返回/);

const password='local-test-password-only';
const env={ACCESS_PASSWORD:password,ASSETS:{fetch(){throw new Error('unexpected asset access');}}};
const unauthenticated = await worker.fetch(new Request('https://test/api/copy-trading'),env,{});
assert.equal(unauthenticated.status,401,'new API must remain behind existing Basic authentication');
assert.equal(unauthenticated.headers.get('X-App-Version'),'20261126-trim-modules');
const auth={Authorization:'Basic '+btoa('monitor:'+password)};
const invalid = await worker.fetch(new Request('https://test/api/copy-trading?portfolio_id=invalid',{headers:auth}),env,{});
assert.equal(invalid.status,400);
const badMethod = await worker.fetch(new Request('https://test/api/copy-trading',{headers:auth,method:'POST'}),env,{});
assert.equal(badMethod.status,405);
console.log('copy trading: source identity, size bounds, auth, method restriction, cache/backoff, timestamps and direction checks passed');
