import assert from 'node:assert/strict';
import {mergeRecords} from '../public/copy-trading-records.js';
import {normalizeOrder,normalizePosition} from '../src/copy-trading.js';

const start = Date.parse('2026-11-26T01:00:00Z');
const position = (id,side,status,opened,closed,updated) => normalizePosition({positionId:id,symbol:'BTCUSDT',side,status,opened,closed,updateTime:updated,avgCost:100,avgClosePrice:110,closedVolume:2});
const order = (side,positionSide,time,price=105) => normalizeOrder({symbol:'BTCUSDT',side,positionSide,orderTime:time,avgPrice:price,executedQty:1});
const snapshot = (positions,orders) => ({positions:{rows:positions},orders:{rows:orders}});

const open = position('partial','Long','Partially Closed',start,null,start+5000);
const closed = position('closed','Long','All Closed',start+10000,start+20000,start+20000);
assert.equal(open.status,'未平仓');
assert.equal(open.state,'open');
assert.equal(open.partial_closed,true);
assert.equal(closed.state,'closed');
assert.equal(normalizePosition({status:'unexpected',closed:null}).state,'unknown','missing a close is not proof of an open position');
assert.equal(normalizePosition({status:'Partially Closed',closed:start}).state,'unknown','contradictory status stays unconfirmed');

const rows = mergeRecords(snapshot([closed,open],[
  order('SELL','LONG',start+18000,111),order('BUY','LONG',start+10000,101),
  order('BUY','LONG',start+1000,102),order('BUY','LONG',start+30000,120),
]));
assert.equal(rows.length,3,'a position and its matched operations must only occupy one row');
assert.equal(rows[0].state,'open','open public records should appear first');
const done = rows.find(row=>row.position_id==='closed');
assert.equal(done.operation_count,2);
assert.deepEqual(done.operations.map(item=>item.price),[111,101],'merging must retain every matched operation');
assert.equal(done.latest_operation.price,111);
assert.equal(done.entry_price,100,'a recent fill must not replace the cycle entry average');
assert.equal(done.close_price,110,'a recent fill must not replace the cycle close average');
const unmatched = rows.find(row=>row.record_kind==='operation');
assert.equal(unmatched.state,'unknown','unmatched buy is not automatically unclosed');
assert.equal(unmatched.opened_at,null,'a possible addition is not a verified first opening');
assert.equal(unmatched.latest_operation.price,120);

const overlapping = position('overlap','Long','All Closed',start+10000,start+25000,start+25000);
const ambiguous = mergeRecords(snapshot([closed,overlapping],[order('SELL','LONG',start+18000)]));
assert.equal(ambiguous.length,3);
assert.equal(ambiguous.filter(row=>row.record_kind==='operation')[0].state,'unknown','overlapping cycles must not be guessed');
assert(ambiguous.filter(row=>row.record_kind==='position').every(row=>row.operation_count===0));

const short = position('short','Short','All Closed',start+10000,start+20000,start+20000);
const hedged = mergeRecords(snapshot([closed,short],[order('BUY','SHORT',start+15000),order('BUY','BOTH',start+15000)]));
assert.equal(hedged.find(row=>row.position_id==='short').operation_count,1);
assert.equal(hedged.find(row=>row.position_id==='closed').operation_count,0);
assert.equal(hedged.find(row=>row.record_kind==='operation').state,'unknown');

const newVersion = {...open,updated_ms:start+8000,entry_price:99};
const deduped = mergeRecords(snapshot([open,newVersion],[]));
assert.equal(deduped.length,1);
assert.equal(deduped[0].entry_price,99);
assert.equal(mergeRecords(snapshot([], [order('BUY','LONG',start)]))[0].state,'unknown','hidden or unavailable position data must not manufacture open status');
assert.deepEqual(mergeRecords(null),[]);
console.log('unified records: partial/closed states, unique cycle matching, hedge isolation, ambiguity and missing-evidence checks passed');
