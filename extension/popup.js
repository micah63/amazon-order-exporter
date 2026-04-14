document.addEventListener('DOMContentLoaded', async () => {
  const pageTypeEl = document.getElementById('pageType');
  const messageEl = document.getElementById('message');
  const collectBtn = document.getElementById('collectBtn');
  const includeCategories = document.getElementById('includeCategories');
  const itemCountEl = document.getElementById('itemCount');
  const itemListEl = document.getElementById('itemList');
  const downloadBtn = document.getElementById('downloadBtn');
  const clearBtn = document.getElementById('clearBtn');
  const trimBtn = document.getElementById('trimBtn');
  const progressEl = document.getElementById('progress');
  const progressLabel = document.getElementById('progressLabel');
  const progressPct = document.getElementById('progressPct');
  const progressFill = document.getElementById('progressFill');

  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const isAmazon = tab.url && /\.amazon\./.test(tab.url);
  const isOrderPage = isAmazon && /\/your-orders\/orders|\/gp\/your-account\/order-history|\/gp\/css\/order-history/.test(tab.url);
  const isDetailPage = isAmazon && /\/gp\/your-account\/order-details|\/your-orders\/order-details|orderID=/.test(tab.url);

  if (!isAmazon) {
    pageTypeEl.textContent = 'Not on Amazon';
    showMessage('Navigate to amazon.com/your-orders to get started.');
  } else if (isOrderPage) {
    pageTypeEl.textContent = 'Order List';
    collectBtn.disabled = false;
  } else if (isDetailPage) {
    pageTypeEl.textContent = 'Order Detail';
    collectBtn.disabled = false;
  } else {
    pageTypeEl.textContent = 'Amazon (not an order page)';
    showMessage('Navigate to Your Orders to collect data.');
  }

  let cancelled = false;
  let fetching = false;

  collectBtn.addEventListener('click', () => {
    if (collectBtn.dataset.mode === 'cancel') {
      cancelled = true;
      return;
    }
    collectOrders(includeCategories.checked);
  });

  await loadStoredItems();

  function lockUI() {
    fetching = true;
    downloadBtn.disabled = true;
    trimBtn.disabled = true;
    clearBtn.disabled = true;
    includeCategories.disabled = true;
    collectBtn.textContent = 'Cancel';
    collectBtn.dataset.mode = 'cancel';
    collectBtn.classList.add('btn-cancel');
  }

  function unlockUI() {
    fetching = false;
    collectBtn.textContent = 'Collect Orders';
    collectBtn.dataset.mode = '';
    collectBtn.classList.remove('btn-cancel');
    includeCategories.disabled = false;
    cancelled = false;
  }

  function mergeOrder(existing, incoming) {
    if (existing && existing.source === 'detail' && incoming.source === 'list') return existing;
    return existing ? { ...existing, ...incoming } : incoming;
  }

  function orderByDate(a, b) {
    const da = a.orderDate ? new Date(a.orderDate) : new Date(0);
    const db = b.orderDate ? new Date(b.orderDate) : new Date(0);
    return da - db;
  }

  async function pMap(items, fn, concurrency) {
    const results = new Array(items.length);
    let next = 0;

    async function worker() {
      while (next < items.length) {
        if (cancelled) return;
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  }

  async function collectOrders(withCategories) {
    lockUI();
    showMessage('Collecting orders...');

    try {
      const response = await sendToContentScript({ action: 'scrape' });

      if (!response || !response.orders || response.orders.length === 0) {
        showMessage(response?.error || 'No orders found on this page.', 'error');
        return;
      }

      const stored = await getStoredOrders();

      for (const order of response.orders) {
        if (!order.orderId) continue;
        stored[order.orderId] = mergeOrder(stored[order.orderId], order);
      }

      await chrome.storage.local.set({ orders: stored });
      await loadStoredItems();

      // Fetch order details for list-page orders that have a detail URL
      const toFetch = response.orders.filter(o =>
        o.detailUrl && o.source === 'list' && stored[o.orderId]?.source !== 'detail'
      );

      let detailsDone = 0;
      await pMap(toFetch, async (order) => {
        const result = await sendToContentScript({ action: 'fetchDetail', url: order.detailUrl });
        if (result && result.order) {
          stored[order.orderId] = { ...stored[order.orderId], ...result.order };
        }
        showProgress('Fetching order details', ++detailsDone, toFetch.length);
      }, 3);

      if (cancelled) {
        await chrome.storage.local.remove('orders');
        hideProgress();
        showMessage('Cancelled.');
        return;
      }

      if (toFetch.length > 0) {
        await chrome.storage.local.set({ orders: stored });
        await loadStoredItems();
      }

      hideProgress();

      if (!withCategories) {
        showMessage(`Collected ${response.orders.length} order(s)!`, 'success');
        return;
      }

      // Load category cache and find items that need categories
      const cachedCategories = (await chrome.storage.local.get('categoryCache')).categoryCache || {};
      const needed = new Set();
      for (const order of response.orders) {
        for (const item of (order.items || [])) {
          if (item.asin && !item.category) needed.add(item.asin);
        }
      }

      if (needed.size === 0) {
        showMessage(`Collected ${response.orders.length} order(s)! All items already have categories.`, 'success');
        return;
      }

      // Build ASIN lookup for efficient category assignment
      const asinToItems = new Map();
      for (const order of Object.values(stored)) {
        for (const item of (order.items || [])) {
          if (item.asin && needed.has(item.asin)) {
            if (!asinToItems.has(item.asin)) asinToItems.set(item.asin, []);
            asinToItems.get(item.asin).push(item);
          }
        }
      }

      // Apply cached categories and filter to only uncached ASINs
      let found = 0;
      const uncached = [];
      for (const asin of needed) {
        if (cachedCategories[asin] && asinToItems.has(asin)) {
          for (const item of asinToItems.get(asin)) {
            item.category = cachedCategories[asin];
            found++;
          }
        } else {
          uncached.push(asin);
        }
      }

      let catsDone = 0;
      await pMap(uncached, async (asin) => {
        const result = await sendToContentScript({ action: 'fetchCategory', asin });
        if (result && result.category && asinToItems.has(asin)) {
          cachedCategories[asin] = result.category;
          for (const item of asinToItems.get(asin)) {
            item.category = result.category;
            found++;
          }
        }
        showProgress('Fetching categories', ++catsDone, uncached.length);
      }, 3);

      await chrome.storage.local.set({ categoryCache: cachedCategories });

      await chrome.storage.local.set({ orders: stored });
      await loadStoredItems();
      hideProgress();

      if (cancelled) {
        await chrome.storage.local.remove('orders');
        showMessage('Cancelled.');
      } else {
        showMessage(`Collected ${response.orders.length} order(s), ${found} categories fetched!`, 'success');
      }
    } catch {
      showMessage('Could not read page. Try refreshing the Amazon tab.', 'error');
    } finally {
      hideProgress();
      unlockUI();
      await loadStoredItems();
      if (!isOrderPage && !isDetailPage) collectBtn.disabled = true;
    }
  }

  downloadBtn.addEventListener('click', async () => {
    const stored = await getStoredOrders();
    const orders = Object.values(stored);
    if (orders.length === 0) return;

    const blob = new Blob([generateCSV(orders)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `amazon-orders-${buildDateRangeSlug(orders)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear all collected order data?')) return;
    await chrome.storage.local.remove(['orders', 'categoryCache']);
    await loadStoredItems();
    hideMessage();
  });

  trimBtn.addEventListener('click', async () => {
    const stored = await getStoredOrders();
    let removed = 0;

    for (const orderId of Object.keys(stored)) {
      const order = stored[orderId];

      if (!order.items || order.items.length === 0) {
        if (!hasMeaningfulPrice(order.total)) { delete stored[orderId]; removed++; }
        continue;
      }

      const before = order.items.length;
      order.items = order.items.filter(item => {
        const price = item.price || order.total || '';
        return hasMeaningfulPrice(price);
      });
      removed += before - order.items.length;

      if (order.items.length === 0) delete stored[orderId];
    }

    await chrome.storage.local.set({ orders: stored });
    await loadStoredItems();

    if (removed > 0) {
      showMessage(`Removed ${removed} item(s) with no price.`);
    } else {
      showMessage('No priceless items found.');
    }
  });

  itemListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.item-delete');
    if (!btn) return;

    const orderId = btn.dataset.orderId;
    const itemIdx = parseInt(btn.dataset.itemIdx, 10);

    const stored = await getStoredOrders();
    if (!stored[orderId]) return;

    if (isNaN(itemIdx) || !stored[orderId].items || stored[orderId].items.length <= 1) {
      delete stored[orderId];
    } else {
      stored[orderId].items.splice(itemIdx, 1);
    }

    await chrome.storage.local.set({ orders: stored });
    await loadStoredItems();
  });

  function hasMeaningfulPrice(price) {
    return parseFloat(String(price || '').replace(/[^0-9.]/g, '')) > 0;
  }

  async function sendToContentScript(message) {
    return chrome.tabs.sendMessage(tab.id, message);
  }

  function showMessage(text, type) {
    messageEl.textContent = text;
    messageEl.className = `message ${type || 'info'}`;
  }

  function hideMessage() {
    messageEl.className = 'message hidden';
  }

  function showProgress(label, current, total) {
    const pct = Math.round((current / total) * 100);
    progressLabel.textContent = label;
    progressPct.textContent = `${current}/${total}`;
    progressFill.style.width = pct + '%';
    progressEl.classList.add('active');
    hideMessage();
  }

  function hideProgress() {
    progressEl.classList.remove('active');
    progressFill.style.width = '0%';
  }

  async function getStoredOrders() {
    const result = await chrome.storage.local.get('orders');
    return result.orders || {};
  }

  async function loadStoredItems() {
    const stored = await getStoredOrders();
    const orders = Object.values(stored);

    const items = [];
    for (const order of orders) {
      const orderItems = order.items?.length > 0 ? order.items : [null];
      for (let idx = 0; idx < orderItems.length; idx++) {
        const item = orderItems[idx];
        items.push({
          name: item?.name || order.orderId,
          price: item?.price || order.total || '',
          category: item?.category || '',
          orderId: order.orderId,
          itemIdx: item ? idx : -1,
          orderDate: order.orderDate,
        });
      }
    }

    itemCountEl.textContent = items.length;
    if (!fetching) {
      downloadBtn.disabled = items.length === 0;
      clearBtn.disabled = items.length === 0;
      trimBtn.disabled = items.length === 0;
    }

    const hasPriceless = items.some(it => !hasMeaningfulPrice(it.price));
    trimBtn.classList.toggle('has-priceless', hasPriceless && items.length > 0);

    if (items.length === 0) {
      itemListEl.classList.add('hidden');
      return;
    }

    items.sort((a, b) => orderByDate(b, a));

    itemListEl.classList.remove('hidden');
    itemListEl.innerHTML = '';

    const TRASH_ICON = '<svg width="12" height="13" viewBox="0 0 12 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3h10M4 3V2a1 1 0 011-1h2a1 1 0 011 1v1m1 0v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3h8zM5 6v4M7 6v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const header = document.createElement('div');
    header.className = 'item-list-header';
    header.innerHTML =
      '<span class="item-name">Item</span>' +
      '<span class="item-price">Price</span>' +
      '<span class="item-cat">Category</span>' +
      '<span class="item-delete"></span>';
    itemListEl.appendChild(header);

    for (const it of items) {
      const hasCategory = Boolean(it.category);
      const categoryLabel = hasCategory ? it.category.split(' > ').pop() : '\u2014';

      const row = document.createElement('div');
      row.className = 'item-row';
      row.innerHTML =
        `<span class="item-name" title="${escapeAttr(it.name)}">${escapeHTML(it.name)}</span>` +
        `<span class="item-price">${escapeHTML(it.price || '\u2014')}</span>` +
        `<span class="item-cat" title="${escapeAttr(it.category)}">` +
          `<span class="cat-dot ${hasCategory ? 'cat-dot-yes' : 'cat-dot-no'}"></span>` +
          `<span class="cat-text">${escapeHTML(categoryLabel)}</span>` +
        `</span>` +
        `<button class="item-delete" title="Remove" data-order-id="${escapeAttr(it.orderId)}" data-item-idx="${it.itemIdx}">` +
          TRASH_ICON +
        `</button>`;
      itemListEl.appendChild(row);
    }
  }

  function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildDateRangeSlug(orders) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    let min = null;
    let max = null;
    for (const order of orders) {
      if (!order.orderDate) continue;
      const d = new Date(order.orderDate);
      if (isNaN(d)) continue;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    }
    if (!min) return new Date().toISOString().slice(0, 10);
    const tag = (d) => months[d.getMonth()] + d.getFullYear();
    if (tag(min) === tag(max)) return tag(min);
    return tag(min) + '-' + tag(max);
  }

  function generateCSV(orders) {
    const sorted = [...orders].sort(orderByDate);

    const headers = [
      'Order ID', 'Order Date', 'Grand Total', 'Recipient',
      'Item Name', 'Item Price', 'Item Quantity', 'Category',
      'Shipping', 'Tax', 'ASIN', 'Product URL',
      'Payment Method 1', 'Payment Method 1 Amount',
      'Payment Method 2', 'Payment Method 2 Amount',
    ];

    const rows = [];
    for (const order of sorted) {
      const orderItems = order.items?.length > 0 ? order.items : [{}];
      for (const item of orderItems) {
        rows.push([
          order.orderId, order.orderDate, order.total, order.recipient,
          item.name || '', item.price || '', item.quantity || '', item.category || '',
          order.shipping || '', order.tax || '', item.asin || '', item.url || '',
          order.paymentMethod1 || '', order.paymentMethod1Amount || '',
          order.paymentMethod2 || '', order.paymentMethod2Amount || '',
        ]);
      }
    }

    return [headers, ...rows]
      .map(row => row.map(f => csvEscape(String(f || ''))).join(','))
      .join('\n');
  }

  function csvEscape(field) {
    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
      return '"' + field.replace(/"/g, '""') + '"';
    }
    return field;
  }
});
