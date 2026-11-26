(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const button = byId('refresh');
  const filter = byId('symbol-filter');
  let snapshot = null;
  let pending = false;
  let timer = null;
  function schedule() { clearTimeout(timer); if (!document.hidden) timer = setTimeout(refresh, 120000); }
  const number = value => value == null || !Number.isFinite(Number(value)) ? '—' :
    Number(value).toLocaleString('en-US', {maximumFractionDigits: 10});
  function cell(row, value, className = '') {
    const td = document.createElement('td');
    td.textContent = value == null || value === '' ? '—' : value;
    td.className = className;
    row.append(td);
  }
  function table(id, rows, values, columns, message) {
    const body = byId(id);
    const fragment = document.createDocumentFragment();
    for (const item of rows) {
      const row = document.createElement('tr');
      for (const value of values(item)) cell(row, ...value);
      fragment.append(row);
    }
    if (!rows.length) {
      const row = document.createElement('tr');
      cell(row, message);
      row.firstChild.colSpan = columns;
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }
  function sectionState(id, data) {
    const state = byId(id);
    state.textContent = `${data.status === 'ok' ? '已获取' : data.status === 'stale' ? '刷新失败，保留上次记录' : '数据暂不可用'} · ${data.fetched_at ? '获取于 ' + new Date(data.fetched_at).toLocaleString('sv-SE', {timeZone:'Asia/Shanghai'}) : '尚无成功记录'}`;
    state.classList.toggle('copy-warning', data.status !== 'ok');
  }
  function render() {
    if (!snapshot) return;
    const symbol = filter.value;
    const selectRows = section => snapshot[section].rows.filter(row => !symbol || row.symbol === symbol);
    table('orders-body', selectRows('orders'), row => [
      [row.time], [row.symbol], [row.action, row.position_side === 'LONG' ? 'copy-long' : row.position_side === 'SHORT' ? 'copy-short' : ''],
      [number(row.price)], [number(row.quantity)],
    ], 5, snapshot.orders.status === 'unavailable' ? '币安公开操作记录暂不可用，等待刷新' : '当前筛选范围暂无公开操作记录');
    table('positions-body', selectRows('positions'), row => [
      [`${row.symbol} / ${row.direction}`, row.direction === '多' ? 'copy-long' : row.direction === '空' ? 'copy-short' : ''],
      [row.opened_at], [number(row.entry_price)], [row.closed_at],
      [number(row.close_price)], [number(row.closed_quantity)], [row.status],
    ], 7, snapshot.positions.status === 'unavailable' ? '币安平仓记录暂不可用，等待刷新' : '当前筛选范围暂无平仓记录');
    sectionState('orders-state', snapshot.orders);
    sectionState('positions-state', snapshot.positions);
  }
  async function refresh() {
    if (pending) return;
    pending = true;
    button.disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 22000);
    byId('refresh-state').textContent = '正在检查最新记录…';
    try {
      const response = await fetch('/api/copy-trading', {cache: 'no-store', signal: controller.signal});
      if (!response.ok) throw new Error('读取失败');
      const data = await response.json();
      if (!data.orders || !data.positions || !Array.isArray(data.orders.rows) || !Array.isArray(data.positions.rows) || !data.profile) throw new Error('数据结构异常');
      for (const name of ['orders', 'positions', 'profile']) {
        if (data[name].status === 'unavailable' && snapshot?.[name]?.status !== 'unavailable' && snapshot?.[name]?.fetched_at) {
          data[name] = {...snapshot[name], status:'stale', error:data[name].error};
        }
      }
      snapshot = data;
      const selected = filter.value;
      const symbols = [...new Set([...data.orders.rows, ...data.positions.rows].map(row => row.symbol))].sort();
      filter.replaceChildren(new Option('全部品种', ''), ...symbols.map(symbol => new Option(symbol, symbol)));
      if (symbols.includes(selected)) filter.value = selected;
      const profile = data.profile.data;
      if (profile && profile.nickname) byId('trader-name').textContent = profile.nickname;
      byId('position-visibility').textContent = !profile || data.profile.status !== 'ok' ? '当前持仓公开状态待核验；不根据历史成交推算持仓。' : profile.positionShow === false ? '带单员未公开当前持仓；此处只展示公开操作和平仓历史。' : '此页只展示公开操作和平仓历史，不根据历史成交推算当前持仓。';
      render();
      const healthy = [data.orders, data.positions, data.profile].every(section => section.status === 'ok');
      byId('refresh-state').textContent = healthy ? '记录已读取 · 每2分钟检查更新，币安可能延迟发布' : '部分数据暂不可用或已过期，请查看各列表的获取时间';
      byId('refresh-state').classList.toggle('copy-warning', !healthy);
    } catch (_) {
      byId('refresh-state').textContent = snapshot ? '刷新失败，正在显示上次记录；以下获取时间未更新' : '暂时无法读取记录，请稍后刷新';
      byId('refresh-state').classList.add('copy-warning');
      if (!snapshot) {
        byId('position-visibility').textContent = '当前持仓公开状态待核验。';
        for (const [section, columns] of [['orders', 5], ['positions', 7]]) {
          byId(section + '-state').textContent = '尚未取得数据';
          table(section + '-body', [], () => [], columns, '暂时无法读取记录');
        }
      }
    } finally {
      clearTimeout(timeout);
      pending = false;
      button.disabled = false;
      schedule();
    }
  }
  filter.addEventListener('change', render);
  button.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) refresh(); });
  window.addEventListener('pagehide', () => clearTimeout(timer));
  refresh();
})();
