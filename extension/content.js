// Content script: runs on Amazon pages, scrapes order data when the popup asks for it.

const ORDER_LIST_URL = /\/your-orders\/orders|\/gp\/your-account\/order-history|\/gp\/css\/order-history/;
const ORDER_DETAIL_URL = /\/gp\/your-account\/order-details|\/your-orders\/order-details|orderID=/;
const ORDER_ID_PATTERN = /[A-Z0-9]{3}-\d{7}-\d{7}/;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrape') {
    try {
      sendResponse(scrapeCurrentPage());
    } catch (err) {
      sendResponse({ pageType: 'error', orders: [], error: err.message });
    }
    return;
  }

  if (request.action === 'fetchCategory') {
    fetchCategory(request.asin).then(category => sendResponse({ category }));
    return true; // keep channel open for async
  }
});

function scrapeCurrentPage() {
  const pageType = detectPageType();
  if (pageType === 'order-list') return scrapeOrderList();
  if (pageType === 'order-detail') return scrapeOrderDetail();
  return { pageType: 'unknown', orders: [], error: 'Not an Amazon order page' };
}

function detectPageType() {
  const url = window.location.href;
  if (ORDER_LIST_URL.test(url)) return 'order-list';
  if (ORDER_DETAIL_URL.test(url)) return 'order-detail';
  return 'unknown';
}

// --- Order List Page ---

function scrapeOrderList() {
  let cards = document.querySelectorAll('.order-card, .js-order-card');

  if (cards.length === 0) {
    cards = document.querySelectorAll('[class*="order-card"], [class*="order_card"]');
  }

  if (cards.length === 0) {
    cards = findOrderContainers();
  }

  const orders = [];
  const seen = new Set();

  for (const card of cards) {
    const order = extractOrderFromCard(card);
    if (order && order.orderId && !seen.has(order.orderId)) {
      seen.add(order.orderId);
      orders.push(order);
    }
  }

  return { pageType: 'order-list', orders, count: orders.length };
}

function findOrderContainers() {
  const containers = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    { acceptNode: node =>
        ORDER_ID_PATTERN.test(node.textContent)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
    }
  );

  while (walker.nextNode()) {
    let el = walker.currentNode.parentElement;
    for (let i = 0; i < 15 && el; i++) {
      if (el.offsetHeight > 80 && el.offsetWidth > 300 &&
          el.offsetHeight < window.innerHeight * 0.8) {
        containers.push(el);
        break;
      }
      el = el.parentElement;
    }
  }

  return containers;
}

function extractOrderFromCard(card) {
  const text = card.textContent;

  const idMatch = text.match(ORDER_ID_PATTERN);
  if (!idMatch) return null;

  const order = {
    source: 'list',
    scrapedAt: new Date().toISOString(),
    orderId: idMatch[0],
    orderDate: extractDate(text),
    total: extractLabeledCurrency(card) || extractFirstCurrency(text),
    recipient: extractRecipient(card),
    items: extractListItems(card),
  };

  const detailLink = card.querySelector('a[href*="order-details"], a[href*="orderID="]');
  if (detailLink) order.detailUrl = detailLink.href;

  return order;
}

function extractListItems(card) {
  const items = [];
  const seen = new Set();
  const skipPatterns = /order-details|invoice|review|write.*review|your.*library|mystuff|track|return/i;

  const productLinks = card.querySelectorAll(
    'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/detail/"]'
  );

  for (const link of productLinks) {
    const name = link.textContent.trim();
    if (!name || name.length < 3) continue;
    if (skipPatterns.test(name)) continue;

    const asinMatch = link.pathname.match(/\/dp\/([A-Z0-9]{10})/);
    const asin = asinMatch ? asinMatch[1] : '';

    const key = asin || name;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      name,
      price: '',
      quantity: '1',
      asin,
      url: asin ? `https://${window.location.hostname}/dp/${asin}` : link.href,
    });
  }

  return items;
}

// --- Order Detail Page ---

function scrapeOrderDetail() {
  const text = document.body.textContent;

  const urlMatch = window.location.href.match(/orderID=([A-Z0-9]{3}-\d{7}-\d{7})/i);
  const textMatch = text.match(ORDER_ID_PATTERN);
  const orderId = urlMatch ? urlMatch[1] : textMatch ? textMatch[0] : null;

  if (!orderId) {
    return { pageType: 'order-detail', orders: [], error: 'Could not find order ID on this page' };
  }

  const summary = extractOrderSummary();

  const order = {
    source: 'detail',
    scrapedAt: new Date().toISOString(),
    orderId,
    orderDate: extractDate(text),
    items: extractDetailItems(),
    total: summary.total,
    shipping: summary.shipping,
    tax: summary.tax,
    subtotal: summary.subtotal,
    refund: summary.refund,
    recipient: extractDetailRecipient(),
  };

  return { pageType: 'order-detail', orders: [order] };
}

function extractDetailItems() {
  const items = [];
  const seen = new Set();

  const productLinks = document.querySelectorAll(
    'a[href*="/gp/product/"], a[href*="/dp/"], a[href*="/gp/aw/d/"]'
  );

  for (const link of productLinks) {
    const name = link.textContent.trim();
    if (!name || name.length < 3) continue;

    const asinMatch = link.href.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/);
    const asin = asinMatch ? asinMatch[1] : '';

    const key = asin || name;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      name,
      price: findNearbyPrice(link),
      quantity: findNearbyQuantity(link),
      asin,
      url: asin ? `https://${window.location.hostname}/dp/${asin}` : '',
    });
  }

  return items;
}

function getAncestor(element, levels) {
  let el = element;
  for (let i = 0; i < levels && el.parentElement; i++) el = el.parentElement;
  return el;
}

function findNearbyPrice(element) {
  const match = getAncestor(element, 5).textContent.match(/\$[\d,]+\.\d{2}/);
  return match ? match[0] : '';
}

function findNearbyQuantity(element) {
  const match = getAncestor(element, 5).textContent.match(/(?:Qty|Quantity)[:\s]*(\d+)/i);
  return match ? match[1] : '1';
}

function extractOrderSummary() {
  const body = document.body.textContent;
  const summary = { total: '', shipping: '', tax: '', subtotal: '', refund: '' };

  const patterns = {
    total: /(?:Grand\s*Total|Order\s*Total|Total)[:\s]*(\$[\d,]+\.\d{2})/i,
    shipping: /(?:Shipping\s*(?:&\s*Handling)?|Delivery)[:\s]*(\$[\d,]+\.\d{2})/i,
    tax: /(?:(?:Estimated\s*)?Tax|VAT|GST|PST|HST)[:\s]*(\$[\d,]+\.\d{2})/i,
    subtotal: /(?:Items?\s*Subtotal|Subtotal)[:\s]*(\$[\d,]+\.\d{2})/i,
    refund: /(?:Refund|Credit)[:\s]*-?\s*(\$[\d,]+\.\d{2})/i,
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = body.match(pattern);
    if (match) summary[key] = match[1];
  }

  return summary;
}

function extractDetailRecipient() {
  const match = document.body.textContent.match(
    /(?:Shipping\s*Address|Deliver\s*to)[:\s]*\n?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i
  );
  return match ? match[1].trim() : '';
}

// --- Shared Helpers ---

function extractDate(text) {
  const patterns = [
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
    /\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i,
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return '';
}

function extractLabeledCurrency(element) {
  for (const label of element.querySelectorAll('span, div')) {
    if (/^TOTAL$/i.test(label.textContent.trim())) {
      const parent = label.parentElement;
      if (parent) {
        const match = parent.textContent.match(/\$[\d,]+\.\d{2}/);
        if (match) return match[0];
      }
    }
  }
  return '';
}

function extractFirstCurrency(text) {
  const patterns = [
    /\$[\d,]+\.\d{2}/,
    /£[\d,]+\.\d{2}/,
    /€[\d,]+[.,]\d{2}/,
    /CDN\$\s*[\d,]+\.\d{2}/,
    /CA\$\s*[\d,]+\.\d{2}/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return '';
}

function extractRecipient(card) {
  for (const el of card.querySelectorAll('span, div, a')) {
    if (!/SHIP\s*TO/i.test(el.textContent.trim())) continue;

    const parent = el.closest('.a-column, [class*="column"], div');
    if (!parent) continue;

    const link = parent.querySelector('a');
    if (link) return link.textContent.trim();

    for (const span of parent.querySelectorAll('span, div')) {
      const t = span.textContent.trim();
      if (t && !/SHIP\s*TO/i.test(t) && t.length > 2 && t.length < 50) {
        return t;
      }
    }
  }
  return '';
}

async function fetchCategory(asin) {
  if (!/^[A-Z0-9]{10}$/i.test(asin)) return '';
  try {
    const resp = await fetch(`/dp/${asin}`, { credentials: 'omit' });
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const breadcrumb = doc.querySelector('#wayfinding-breadcrumbs_container');
    if (breadcrumb) {
      const cats = Array.from(breadcrumb.querySelectorAll('a'))
        .map(a => a.textContent.trim())
        .filter(Boolean);
      if (cats.length > 0) return cats.join(' > ');
    }

    const deptLink = doc.querySelector('#nav-subnav .nav-a-content');
    if (deptLink) return deptLink.textContent.trim();

    const detailRows = doc.querySelectorAll(
      '#productDetails_detailBullets_sections1 tr, #detailBullets_sections1 li'
    );
    for (const row of detailRows) {
      if (/department|category/i.test(row.textContent)) {
        const val = row.querySelector('td, .a-list-item span:last-child');
        if (val) return val.textContent.trim();
      }
    }

    return '';
  } catch {
    return '';
  }
}
