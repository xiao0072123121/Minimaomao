(() => {
  'use strict';
  const root = document.getElementById('view-copy-trading');
  if (!root) return;
  const byId = id => root.querySelector('#copy-' + id);
  const button = byId('refresh');
  const filter = byId('symbol-filter');
  const traderSelect = byId('trader-select');
  const traderStates = new Map();
  let selectedId = traderSelect.value;
  let snapshot = null;
  let pending = false;
  let timer = null;
  let lastCheckedAt = 0;
  let requestSequence = 0;
  let requestController = null;
  let statusMessage = '';
  let statusWarning = false;
  const active = () => root.classList.contains('active') && !document.hidden;
  function schedule() { clearTimeout(timer); if (active()) timer = setTimeout(refresh, Math.max(0, 120000 - (Date.now() - lastCheckedAt))); }
  function activate() {
    clearTimeout(timer);
    if (!active()) return;
    if (!snapshot || Date.now() - lastCheckedAt >= 120000) refresh();
    else schedule();
  }
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
  function setStatus(message, warning = false) {
    statusMessage = message;
    statusWarning = warning;
    byId('refresh-state').textContent = message;
    byId('refresh-state').classList.toggle('copy-warning', warning);
  }
  function remember() {
    traderStates.set(selectedId, {snapshot, lastCheckedAt, symbol:filter.value, message:statusMessage, warning:statusWarning});
  }
  function updateRegistry(traders) {
    if (!Array.isArray(traders) || traders.length > 16 || !traders.some(trader => trader?.id === selectedId)) return;
    if (traders.some(trader => !/^\d{10,24}$/.test(trader?.id) || typeof trader.name !== 'string')) return;
    traderSelect.replaceChildren(...traders.map(trader => new Option(trader.name, trader.id)));
    traderSelect.value = selectedId;
  }
  function present(symbol = filter.value) {
    const profile = snapshot?.profile.data;
    const name = profile?.nickname || traderSelect.selectedOptions[0]?.textContent || selectedId;
    byId('trader-name').textContent = name;
    byId('trader-description').textContent = `组合 ${selectedId} · 公开操作 · 北京时间 · 每2分钟检查更新`;
    byId('trader-source').href = `https://www.binance.bh/zh-CN/copy-trading/lead-details/${selectedId}?timeRange=30D`;
    if (profile?.nickname) traderSelect.selectedOptions[0].textContent = profile.nickname;
    const symbols = [...new Set([...(snapshot?.orders.rows || []), ...(snapshot?.positions.rows || [])].map(row => row.symbol))].sort();
    filter.replaceChildren(new Option('全部品种', ''), ...symbols.map(value => new Option(value, value)));
    if (symbols.includes(symbol)) filter.value = symbol;
    filter.disabled = !snapshot;
    if (!snapshot) {
      byId('position-visibility').textContent = '等待读取这位带单员的持仓公开状态。';
      for (const [section, columns] of [['orders', 5], ['positions', 7]]) {
        byId(section + '-state').textContent = '尚未取得这位带单员的记录';
        byId(section + '-state').classList.remove('copy-warning');
        table(section + '-body', [], () => [], columns, '等待读取当前带单员记录');
      }
      return;
    }
    byId('position-visibility').textContent = !profile || snapshot.profile.status !== 'ok' ? '当前持仓公开状态待核验；不根据历史成交推算持仓。' : profile.positionShow === false ? '带单员未公开当前持仓；此处只展示公开操作和平仓历史。' : '此页只展示公开操作和平仓历史，不根据历史成交推算当前持仓。';
    render();
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
    if (pending || !active()) return;
    pending = true;
    button.disabled = true;
    const portfolioId = selectedId;
    const sequence = ++requestSequence;
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 22000);
    byId('refresh-state').textContent = '正在检查最新记录…';
    try {
      const response = await fetch('/api/copy-trading?portfolio_id=' + encodeURIComponent(portfolioId), {cache: 'no-store', signal: controller.signal});
      if (!response.ok) throw new Error('读取失败');
      const data = await response.json();
      if (sequence !== requestSequence || portfolioId !== selectedId) return;
      if (data.portfolio_id !== portfolioId) throw new Error('带单员身份不匹配');
      if (!data.orders || !data.positions || !Array.isArray(data.orders.rows) || !Array.isArray(data.positions.rows) || !data.profile) throw new Error('数据结构异常');
      for (const name of ['orders', 'positions', 'profile']) {
        if (data[name].status === 'unavailable' && snapshot?.[name]?.status !== 'unavailable' && snapshot?.[name]?.fetched_at) {
          data[name] = {...snapshot[name], status:'stale', error:data[name].error};
        }
      }
      snapshot = data;
      updateRegistry(data.traders);
      present();
      const healthy = [data.orders, data.positions, data.profile].every(section => section.status === 'ok');
      setStatus(healthy ? '记录已读取 · 每2分钟检查更新，币安可能延迟发布' : '部分数据暂不可用或已过期，请查看各列表的获取时间', !healthy);
    } catch (_) {
      if (sequence !== requestSequence || portfolioId !== selectedId) return;
      setStatus(snapshot ? '刷新失败，正在显示上次记录；以下获取时间未更新' : '暂时无法读取这位带单员的记录，请稍后刷新', true);
      if (!snapshot) {
        byId('position-visibility').textContent = '当前持仓公开状态待核验。';
        for (const [section, columns] of [['orders', 5], ['positions', 7]]) {
          byId(section + '-state').textContent = '尚未取得数据';
          table(section + '-body', [], () => [], columns, '暂时无法读取记录');
        }
      }
    } finally {
      clearTimeout(timeout);
      if (sequence !== requestSequence || portfolioId !== selectedId) return;
      requestController = null;
      pending = false;
      button.disabled = false;
      lastCheckedAt = Date.now();
      remember();
      schedule();
    }
  }
  filter.addEventListener('change', () => { render(); remember(); });
  traderSelect.addEventListener('change', () => {
    remember();
    requestController?.abort();
    requestSequence += 1;
    pending = false;
    button.disabled = false;
    selectedId = traderSelect.value;
    const saved = traderStates.get(selectedId);
    snapshot = saved?.snapshot || null;
    lastCheckedAt = saved?.lastCheckedAt || 0;
    present(saved?.symbol || '');
    setStatus(saved?.message || '等待读取这位带单员的记录', saved?.warning || false);
    activate();
  });
  button.addEventListener('click', refresh);
  window.addEventListener('app-view-change', activate);
  document.addEventListener('visibilitychange', activate);
  window.addEventListener('pagehide', () => clearTimeout(timer));
  present();
  activate();
})();
