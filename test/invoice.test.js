const assert = require('node:assert/strict');
const test = require('node:test');

const coupons = require('../lib/coupons');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

// Use the same saved order shape as checkout, backed by a fresh in-memory store.
function billedOrder(items, coupon = '') {
  const db = { nextOrderId: 1, orders: [] };
  return orders.add(db, {
    date: '15/02/2024',
    items,
    coupon,
    ...pricing.computeTotals(items, coupon)
  });
}

function mixedSlabItems() {
  return [
    { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ];
}

test('a mixed-slab order with SAVE10 prints the GST and total billed at checkout', () => {
  const order = billedOrder(mixedSlabItems(), 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total }, {
    discount: 150, tax: 157.25, total: 2007.25
  });
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 46.25], [12, 111]
  ]);
  assert.deepEqual([figures.cgst, figures.sgst], [78.63, 78.62]);

  const html = invoice.render(order);
  assert.match(html, /<td>CGST \+ SGST \(Total GST\)<\/td><td class="r">₹157\.25<\/td>/);
  assert.match(html, /<td>Invoice Total<\/td><td class="r">₹2007\.25<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('checkout caps SAVE10 and applies each HSN slab after allocating the discount', () => {
  const { lines, ...totals } = pricing.computeTotals(mixedSlabItems(), 'SAVE10');

  assert.deepEqual(totals, {
    subtotal: 2000, discount: 150, taxable: 1850, tax: 157.25,
    cgst: 78.63, sgst: 78.62, total: 2007.25
  });
  assert.deepEqual(lines.map(({ gstPercent, discount, taxable, tax }) => ({
    gstPercent, discount, taxable, tax
  })), [
    { gstPercent: 5, discount: 75, taxable: 925, tax: 46.25 },
    { gstPercent: 12, discount: 75, taxable: 925, tax: 111 }
  ]);
});

test('invoice uses saved HSN slabs when gstRate is missing', () => {
  const order = billedOrder(mixedSlabItems());
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 170);
  assert.equal(order.total, 2170);
  assert.deepEqual(figures, {
    subtotal: 2000, discount: 0, tax: 170, cgst: 85, sgst: 85, total: 2170
  });
  assert.deepEqual(rows.map(({ hsn, gstPercent, lineTax }) => ({ hsn, gstPercent, lineTax })), [
    { hsn: '1006', gstPercent: 5, lineTax: 50 },
    { hsn: '0405', gstPercent: 12, lineTax: 120 }
  ]);
});

test('invoice caps SAVE10 and applies GST after the discount', () => {
  const order = billedOrder([{ name: 'Item', price: 2000, qty: 1, gstRate: 12 }], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.discount, 150);
  assert.equal(order.tax, 222);
  assert.equal(order.total, 2072);
  assert.equal(figures.tax, 222);
  assert.equal(figures.discount, 150);
  assert.equal(figures.total, 2072);
});

test('invoice applies GST after subtracting FLAT50', () => {
  const order = billedOrder([{ name: 'Item', price: 400, qty: 1, gstRate: 12 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.discount, 50);
  assert.equal(order.tax, 42);
  assert.equal(order.total, 392);
  assert.equal(figures.discount, 50);
  assert.equal(figures.tax, 42);
  assert.equal(figures.total, 392);
});

test('invoice excludes saved coupons below the minimum or marked inactive', () => {
  for (const [coupon, price] of [['FLAT50', 100], ['DIWALI20', 2000]]) {
    const items = [{ name: 'Item', price, qty: 1 }];

    assert.equal(coupons.validate(coupon, price).valid, false);
    assert.equal(pricing.computeTotals(items, coupon).discount, 0);
    assert.equal(invoice.computeInvoiceFigures({ items, coupon }).discount, 0);
  }
});

test('invoice accepts percentage and decimal GST rates and preserves zero', () => {
  const items = [
    { name: 'Whole-percent rate', price: 100, qty: 1, gstRate: 12 },
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.12 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 }
  ];
  const order = billedOrder(items);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 24);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [12, 12, 0]);
  assert.equal(figures.tax, 24);
});

test('invoice GST totals sum the rounded checkout line taxes', () => {
  const order = billedOrder([
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.03, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 0.02);
  assert.equal(order.total, 0.08);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.equal(figures.cgst, 0.01);
  assert.equal(figures.sgst, 0.01);
  assert.equal(figures.total, 0.08);
});

test('printed invoice warns when the saved total differs from shared checkout pricing', () => {
  const order = billedOrder(mixedSlabItems(), 'SAVE10');
  const html = invoice.render({ ...order, total: 2007 });

  assert.match(html, /Invoice computed total \(₹2007\.25\) differs from Order Ledger recorded total \(₹2007\.00\) by \+₹0\.25/);
});

test('reconciliation matches checkout pricing, flags differing saved totals, and skips cancelled orders', () => {
  const order = billedOrder(mixedSlabItems(), 'SAVE10');
  const historicalOrder = { ...order, id: 2, total: 2007 };
  const cancelledOrder = { ...historicalOrder, id: 3, status: 'cancelled' };
  const { rows, ...summary } = reports.getGstReconciliation({
    orders: [order, historicalOrder, cancelledOrder]
  });

  assert.deepEqual(summary, { totalChecked: 2, mismatchCount: 1, totalDelta: 0.25 });
  assert.deepEqual(rows[0], {
    orderId: 1, date: '15/02/2024', customer: 'Walk-in', coupon: 'SAVE10',
    ledgerSubtotal: 2000, ledgerDiscount: 150, ledgerTax: 157.25, ledgerTotal: 2007.25,
    invoiceDiscount: 150, invoiceTax: 157.25, invoiceTotal: 2007.25, delta: 0, matched: true
  });
  assert.equal(rows[1].orderId, 2);
  assert.equal(rows[1].delta, 0.25);
  assert.equal(rows[1].matched, false);
});

test('CURRENT BEHAVIOUR: GST-only mismatch is flagged in reconciliation without a print warning', () => {
  const items = [{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }];
  const order = billedOrder(items);
  const matching = reports.getGstReconciliation({ orders: [order] });
  const historicalOrder = { ...order, tax: 17.99 };
  const mismatch = reports.getGstReconciliation({ orders: [historicalOrder] });

  assert.equal(matching.rows[0].matched, true);
  assert.equal(mismatch.rows[0].matched, false);
  assert.equal(mismatch.mismatchCount, 1);
  assert.equal(mismatch.totalDelta, 0);
  assert.doesNotMatch(invoice.render(historicalOrder), /Accountant Reconciliation Notice/);
});
