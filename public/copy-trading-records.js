// A public operation has no position ID. Associate it only with one bounded
// position interval; missing or ambiguous evidence never proves an open trade.
function ms(value, display) {
  if (value != null && Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  if (typeof display !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(display)) return null;
  const parsed = Date.parse(display.replace(' ', 'T') + '+08:00');
  return Number.isFinite(parsed) ? parsed : null;
}

// Fill the horizontal columns without relabelling a single addition/reduction
// as a verified cycle opening/closure or replacing a position average.
export function recordColumns(row) {
  const values = {opened_at:row.opened_at,entry_price:row.entry_price,entry_quantity:row.entry_quantity ?? null,
    closed_at:row.closed_at,close_price:row.close_price,closed_quantity:row.closed_quantity,
    entry_is_fill:false,close_is_fill:false};
  if (row.record_kind !== 'operation' || !row.latest_operation) return values;
  const order = row.latest_operation;
  const direction = `${order.side}:${order.position_side}`;
  if (['BUY:LONG','SELL:SHORT'].includes(direction)) {
    Object.assign(values,{opened_at:order.time,entry_price:order.price,entry_quantity:order.quantity,entry_is_fill:true});
  } else if (['SELL:LONG','BUY:SHORT'].includes(direction)) {
    Object.assign(values,{closed_at:order.time,close_price:order.price,closed_quantity:order.quantity,close_is_fill:true});
  }
  return values;
}

export function mergeRecords(snapshot) {
  const positions = snapshot?.positions?.rows || [];
  const orders = snapshot?.orders?.rows || [];
  const unique = new Map();
  for (const [index, position] of positions.entries()) {
    const key = position.position_id ? `${position.position_id}:${position.symbol}:${position.direction}` : `missing:${index}`;
    const previous = unique.get(key);
    if (!previous || (position.updated_ms || 0) > (previous.updated_ms || 0)) unique.set(key,position);
  }
  const rows = [...unique.values()].map((position,index) => {
    // Compatibility with already-open pages. Never infer open from null closed_at.
    const state = position.state || (['已平仓','已全部平仓'].includes(position.status) ? 'closed' : 'unknown');
    const opened = ms(position.opened_ms,position.opened_at);
    const ended = ms(position.closed_ms,position.closed_at);
    const updated = ms(position.updated_ms,position.updated_at);
    return {...position,record_id:'position:'+(position.position_id || index),record_kind:'position',state,
      status:({closed:'已平仓',open:'未平仓',unknown:'待确认'})[state] || '待确认',
      opened_ms:opened,closed_ms:ended,updated_ms:updated,
      latest_operation:null,operations:[],operation_count:0,activity_ms:Math.max(opened || 0,ended || 0,updated || 0)};
  });
  for (const [index,order] of orders.entries()) {
    const direction = ({LONG:'多',SHORT:'空'})[order.position_side];
    const time = ms(order.time_ms,order.time);
    const candidates = direction && time ? rows.filter(row => {
      if (row.record_kind !== 'position' || row.symbol !== order.symbol || row.direction !== direction || !row.opened_ms) return false;
      const end = row.closed_ms || row.updated_ms;
      return end && row.opened_ms <= time && time <= end;
    }) : [];
    if (candidates.length === 1) {
      const row = candidates[0];
      row.operation_count += 1;
      row.operations.push(order);
      if (!row.latest_operation || time > (ms(row.latest_operation.time_ms,row.latest_operation.time) || 0)) row.latest_operation = order;
      row.activity_ms = Math.max(row.activity_ms,time);
    } else {
      rows.push({record_id:'operation:'+index,record_kind:'operation',symbol:order.symbol,direction:direction || '待确认',
        state:'unknown',status:'待确认',partial_closed:false,opened_at:null,opened_ms:null,entry_price:null,
        closed_at:null,closed_ms:null,close_price:null,closed_quantity:null,latest_operation:order,operations:[order],operation_count:1,activity_ms:time || 0});
    }
  }
  for (const row of rows) row.operations.sort((a,b)=>(ms(b.time_ms,b.time) || 0)-(ms(a.time_ms,a.time) || 0));
  return rows.sort((a,b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || b.activity_ms - a.activity_ms || a.record_id.localeCompare(b.record_id));
}
