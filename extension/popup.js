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

  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const isAmazon = tab.url && /\.amazon\./.test(tab.url);
  const isOrderPage = isAmazon && /\/your-orders\/orders|\/gp\/your-account\/order-history|\/gp\/css\/order-history/.test(tab.url);
  const isDetailPage = isAmazon && /\/gp\/your-account\/order-details|\/your-orders\/order-details|orderID=/.test(tab.url);

  if (!isAmazon) {
    pageTypeEl.textContent = 'Not on Amazon';
    showMessage('Navigate to amazon.com/your-orders to get started.', 'info');
  } else if (isOrderPage) {
    pageTypeEl.textContent = 'Order List';
    collectBtn.disabled = false;
  } else if (isDetailPage) {
    pageTypeEl.textContent = 'Order Detail';
    collectBtn.disabled = false;
  } else {
    pageTypeEl.textContent = 'Amazon (not an order page)';
    showMessage('Navigate to Your Orders to collect data.', 'info');
  }

  await loadStoredItems();

  collectBtn.addEventListener('click', () => collectOrders(includeCategories.checked));

  async function collectOrders(withCategories) {
    collectBtn.disabled = true;
    showMessage('Collecting orders...', 'info', withCategories);

    try {
      const response = await sendToContentScript({ action: 'scrape' });

      if (!response || !response.orders || response.orders.length === 0) {
        showMessage(response?.error || 'No orders found on this page.', 'error');
        return;
      }

      const stored = await getStoredOrders();

      for (const order of response.orders) {
        if (!order.orderId) continue;
        const existing = stored[order.orderId];
        if (existing && existing.source === 'detail' && order.source === 'list') continue;
        stored[order.orderId] = existing ? { ...existing, ...order } : order;
      }

      await chrome.storage.local.set({ orders: stored });
      await loadStoredItems();

      if (!withCategories) {
        showMessage(`Collected ${response.orders.length} order(s)!`, 'success');
        return;
      }

      // Find items that need categories
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

      // Fetch each category one at a time (Amazon rate-limits parallel requests)
      const asins = Array.from(needed);
      let found = 0;

      for (let i = 0; i < asins.length; i++) {
        showMessage(`Fetching categories ${i + 1} / ${asins.length}...`, 'info', true);
        const result = await sendToContentScript({ action: 'fetchCategory', asin: asins[i] });

        if (result && result.category) {
          for (const orderId of Object.keys(stored)) {
            for (const item of (stored[orderId].items || [])) {
              if (item.asin === asins[i]) {
                item.category = result.category;
                found++;
              }
            }
          }
        }
      }

      await chrome.storage.local.set({ orders: stored });
      await loadStoredItems();
      showMessage(`Collected ${response.orders.length} order(s), ${found} categories fetched!`, 'success');
    } catch {
      showMessage('Could not read page. Try refreshing the Amazon tab.', 'error');
    } finally {
      if (isOrderPage || isDetailPage) collectBtn.disabled = false;
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
    a.download = `amazon-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear all collected order data?')) return;
    await chrome.storage.local.remove('orders');
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
      showMessage(`Removed ${removed} item(s) with no price.`, 'info');
    } else {
      showMessage('No priceless items found.', 'info');
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
    if (!price || !price.trim()) return false;
    return parseFloat(price.replace(/[^0-9.]/g, '')) > 0;
  }

  async function sendToContentScript(message) {
    return await chrome.tabs.sendMessage(tab.id, message);
  }

  function showMessage(text, type, animate) {
    messageEl.textContent = text;
    messageEl.className = `message ${type}${animate ? ' fetching' : ''}`;
  }

  function hideMessage() {
    messageEl.className = 'message hidden';
  }

  async function getStoredOrders() {
    const result = await chrome.storage.local.get('orders');
    return result.orders || {};
  }

  async function loadStoredItems() {
    const stored = await getStoredOrders();
    const orders = Object.values(stored);

    // Flatten orders into a list of displayable items
    const items = [];
    for (const order of orders) {
      if (order.items && order.items.length > 0) {
        for (let idx = 0; idx < order.items.length; idx++) {
          const item = order.items[idx];
          items.push({
            name: item.name || order.orderId,
            price: item.price || order.total || '',
            category: item.category || '',
            orderId: order.orderId,
            itemIdx: idx,
            orderDate: order.orderDate,
          });
        }
      } else {
        items.push({
          name: order.orderId,
          price: order.total || '',
          category: '',
          orderId: order.orderId,
          itemIdx: -1,
          orderDate: order.orderDate,
        });
      }
    }

    itemCountEl.textContent = items.length;
    downloadBtn.disabled = items.length === 0;
    clearBtn.disabled = items.length === 0;
    trimBtn.disabled = items.length === 0;

    const hasPriceless = items.some(it => !hasMeaningfulPrice(it.price));
    trimBtn.classList.toggle('has-priceless', hasPriceless && items.length > 0);

    if (items.length === 0) {
      itemListEl.classList.add('hidden');
      return;
    }

    // Sort newest first
    items.sort((a, b) => {
      const da = a.orderDate ? new Date(a.orderDate) : new Date(0);
      const db = b.orderDate ? new Date(b.orderDate) : new Date(0);
      return db - da;
    });

    itemListEl.classList.remove('hidden');
    itemListEl.innerHTML = '';

    const TRASH_ICON = '<svg width="12" height="13" viewBox="0 0 12 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3h10M4 3V2a1 1 0 011-1h2a1 1 0 011 1v1m1 0v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3h8zM5 6v4M7 6v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // Column header
    const header = document.createElement('div');
    header.className = 'item-list-header';
    header.innerHTML =
      '<span class="item-name">Item</span>' +
      '<span class="item-price">Price</span>' +
      '<span class="item-cat">Category</span>' +
      '<span class="item-delete"></span>';
    itemListEl.appendChild(header);

    // Item rows
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
    return escapeHTML(str).replace(/"/g, '&quot;');
  }

  function generateCSV(orders) {
    const headers = [
      'Order ID', 'Order Date', 'Total', 'Recipient',
      'Item Name', 'Item Price', 'Item Quantity', 'Category',
      'Shipping', 'Tax', 'ASIN', 'Product URL',
    ];

    const rows = [];
    for (const order of orders) {
      if (order.items && order.items.length > 0) {
        for (const item of order.items) {
          rows.push([
            order.orderId, order.orderDate, order.total, order.recipient,
            item.name, item.price, item.quantity, item.category,
            order.shipping, order.tax, item.asin, item.url,
          ]);
        }
      } else {
        rows.push([
          order.orderId, order.orderDate, order.total, order.recipient,
          '', '', '', '',
          order.shipping || '', order.tax || '', '', '',
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
