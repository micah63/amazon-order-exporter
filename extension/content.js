// Content script: runs on Amazon pages, scrapes order data when the popup asks for it.

const ORDER_LIST_URL = /\/your-orders\/orders|\/gp\/your-account\/order-history|\/gp\/css\/order-history/;
const ORDER_DETAIL_URL = /\/gp\/your-account\/order-details|\/your-orders\/order-details|orderID=/;
const ORDER_ID_PATTERN = /[A-Z0-9]{3}-\d{7}-\d{7}/;

const SKIP_ITEM_PATTERN = /order-details|invoice|review|write.*review|your.*library|mystuff|track|return|buy\s*it\s*again|view\s*your\s*item|write\s*a\s*product|get\s*product\s*support|rewards\s*(mastercard|visa|amex)|amazon\.ca\s*rewards/i;

const DATE_PATTERN = /(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i;

const CARD_BRANDS = ['Visa', 'Mastercard', 'American Express', 'Discover', 'Amex'];

const PRICE_SEARCH_DEPTH = 8;
const QTY_SEARCH_DEPTH = 5;
const QTY_WIDE_SEARCH_DEPTH = 8;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrape') {
    sendResponse(scrapeCurrentPage());
  } else if (request.action === 'fetchDetail') {
    fetchOrderDetail(request.url).then(order => sendResponse({ order }));
  } else if (request.action === 'fetchCategory') {
    fetchCategory(request.asin).then(category => sendResponse({ category }));
  }
  return true;
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
  let cards = document.querySelectorAll('[class*="order-card"], [class*="order_card"]');

  if (cards.length === 0) cards = findOrderContainers();

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

// TreeWalker is used here instead of querySelectorAll('*') because Amazon pages
// can have thousands of DOM elements. TreeWalker efficiently scans only text nodes.
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

  const productLinks = card.querySelectorAll(
    'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/detail/"]'
  );

  for (const link of productLinks) {
    const name = link.textContent.trim();
    if (!name || name.length < 3) continue;
    if (SKIP_ITEM_PATTERN.test(name)) continue;

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
  const payments = extractPaymentMethods();

  const order = {
    source: 'detail',
    orderId,
    orderDate: extractDate(text),
    items: extractDetailItems(),
    total: summary.total,
    shipping: summary.shipping,
    tax: summary.tax,
    subtotal: summary.subtotal,
    refund: summary.refund,
    giftCardAmount: summary.giftCardAmount,
    recipient: extractDetailRecipient(),
    paymentMethod1: payments[0]?.name || '',
    paymentMethod1Amount: payments[0]?.amount || '',
    paymentMethod2: payments[1]?.name || '',
    paymentMethod2Amount: payments[1]?.amount || '',
  };

  return { pageType: 'order-detail', orders: [order] };
}

function extractDetailItems(doc = document) {
  const items = [];
  const seen = new Set();
  const scope = doc.querySelector('#orderDetails') || doc.querySelector('main') || doc;

  const productLinks = scope.querySelectorAll(
    'a[href*="/gp/product/"], a[href*="/dp/"], a[href*="/gp/aw/d/"]'
  );

  for (const link of productLinks) {
    if (link.closest('[class*="sims"], [class*="carousel"], [class*="p13n"]')) continue;
    const name = link.textContent.trim();
    if (!name || name.length < 3) continue;
    if (SKIP_ITEM_PATTERN.test(name)) continue;

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
  for (let levels = 3; levels <= PRICE_SEARCH_DEPTH; levels++) {
    const match = getAncestor(element, levels).textContent.match(/\$[\d,]+\.\d{2}/);
    if (match) return match[0];
  }
  return '';
}

function findNearbyQuantity(element) {
  const container = getAncestor(element, QTY_SEARCH_DEPTH);
  const qtyBadge = container.querySelector('.od-item-view-qty span');
  if (qtyBadge) {
    const qty = qtyBadge.textContent.trim();
    if (/^\d+$/.test(qty) && parseInt(qty) > 0) return qty;
  }

  const wideContainer = getAncestor(element, QTY_WIDE_SEARCH_DEPTH);
  const textMatch = wideContainer.textContent.match(/(?:Qty|Quantity)[:\s]*(\d+)/i);
  if (textMatch) return textMatch[1];
  const badges = wideContainer.querySelectorAll('span.a-badge-text, span[class*="quantity"], span[class*="qty"]');
  for (const badge of badges) {
    const d = badge.textContent.trim().match(/^(\d+)$/);
    if (d && parseInt(d[1]) > 0) return d[1];
  }
  return '1';
}

function extractOrderSummary(doc = document) {
  const body = doc.body.textContent;
  const summary = { total: '', shipping: '', tax: '', subtotal: '', refund: '', giftCardAmount: '' };

  const patterns = {
    shipping: /(?:Shipping\s*(?:&\s*Handling)?|Delivery)[:\s]*(\$[\d,]+\.\d{2})/i,
    subtotal: /(?:Items?\s*Subtotal|Subtotal)[:\s]*(\$[\d,]+\.\d{2})/i,
    refund: /(?:Refund|Credit)[:\s]*-?\s*(\$[\d,]+\.\d{2})/i,
    giftCardAmount: /Gift\s*Card\s*Amount[:\s]*-?\s*(\$[\d,]+\.\d{2})/i,
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = body.match(pattern);
    if (match) summary[key] = match[1];
  }

  // Match most-specific total label first, fall back to generic "Total"
  const totalMatch =
    body.match(/Grand\s*Total[:\s]*(\$[\d,]+\.\d{2})/i) ||
    body.match(/Order\s*Total[:\s]*(\$[\d,]+\.\d{2})/i) ||
    body.match(/Total[:\s]*(\$[\d,]+\.\d{2})/i);
  if (totalMatch) summary.total = totalMatch[1];

  // Sum all tax lines (PST, GST, HST, QST, RST, VAT, Tax) but exclude "before tax"
  const taxPattern = /(?<!before )(?:(?:Estimated\s+)?(?:Tax(?:es)?|VAT|(?:PST|RST|QST|GST|HST)(?:\/(?:PST|RST|QST|GST|HST))*))\s*:\s*(\$[\d,]+\.\d{2})/gi;
  let taxTotal = 0;
  for (const m of body.matchAll(taxPattern)) {
    taxTotal += parseFloat(m[1].replace(/[$,]/g, ''));
  }
  if (taxTotal > 0) summary.tax = '$' + taxTotal.toFixed(2);

  return summary;
}

function extractPaymentMethods(doc = document) {
  const methods = [];

  const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
  let paymentList = null;
  for (const h of headings) {
    if (/^payment\s*method/i.test(h.textContent.trim())) {
      paymentList = h.nextElementSibling;
      break;
    }
  }

  if (paymentList) {
    for (const item of paymentList.children) {
      if (item.tagName === 'SCRIPT' || item.tagName === 'STYLE' || item.tagName === 'LINK') continue;
      const text = item.textContent.trim();

      if (/gift\s*card/i.test(text)) {
        methods.push({ name: 'Gift Card', amount: '' });
        continue;
      }

      for (const brand of CARD_BRANDS) {
        if (text.toLowerCase().includes(brand.toLowerCase())) {
          const lastFour = text.match(/(\d{4})/);
          const name = brand + (lastFour ? ' ' + lastFour[1] : '');
          if (!methods.some(m => m.name === name)) {
            methods.push({ name, amount: '' });
          }
          break;
        }
      }
    }
  }

  return methods.slice(0, 2);
}

function extractDetailRecipient(doc = document) {
  // DOM-based: find "Ship to" or "Shipping Address" heading and get first list item
  const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
  for (const h of headings) {
    if (/^ship(?:ping\s*address|\s*to)$/i.test(h.textContent.trim())) {
      const list = h.nextElementSibling;
      if (list) {
        const firstItem = list.querySelector('li, [role="listitem"]');
        if (firstItem) {
          const name = firstItem.textContent.trim().replace(/\s+/g, ' ');
          if (name.length > 2 && name.length < 100) return name;
        }
      }
    }
  }

  // Fallback: regex scoped to main content (avoids navbar "Deliver to" which includes city)
  const scope = doc.querySelector('main, #content, #a-page') || doc.body;
  const scopeText = scope.textContent;

  const addrMatch = scopeText.match(
    /Shipping\s*Address\s*[:\n]\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)/
  );
  if (addrMatch) return addrMatch[1].trim().replace(/\s+/g, ' ');

  const shipMatch = scopeText.match(
    /Ship\s*to\s*[:\n]\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)/
  );
  if (shipMatch) return shipMatch[1].trim().replace(/\s+/g, ' ');

  return '';
}

// --- Shared Helpers ---

function extractDate(text) {
  const match = text.match(DATE_PATTERN);
  return match ? match[0] : '';
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

async function fetchOrderDetail(url) {
  try {
    const resp = await fetch(url);
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const text = doc.body.textContent;
    const summary = extractOrderSummary(doc);
    const payments = extractPaymentMethods(doc);

    return {
      source: 'detail',
      orderDate: extractDate(text),
      items: extractDetailItems(doc),
      total: summary.total,
      shipping: summary.shipping,
      tax: summary.tax,
      subtotal: summary.subtotal,
      refund: summary.refund,
      giftCardAmount: summary.giftCardAmount,
      recipient: extractDetailRecipient(doc),
      paymentMethod1: payments[0]?.name || '',
      paymentMethod1Amount: payments[0]?.amount || '',
      paymentMethod2: payments[1]?.name || '',
      paymentMethod2Amount: payments[1]?.amount || '',
    };
  } catch {
    return null;
  }
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
