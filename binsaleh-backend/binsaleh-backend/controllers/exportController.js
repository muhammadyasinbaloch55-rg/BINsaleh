// controllers/exportController.js
// Real exports — Excel (.xlsx via ExcelJS), PDF (PDFKit), CSV (#8, #12).
// Also production reports: sales, revenue, profit, best sellers, low stock,
// customer, payment — each exportable as xlsx / csv / pdf.

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Review = require('../models/Review');
const { log } = require('../services/auditService');
const { paymentLabel } = require('../services/invoiceService');

// ---------- Shared helpers ----------

function buildOrderFilter(query) {
  const filter = {};
  if (query.from) filter.createdAt = { ...(filter.createdAt || {}), $gte: new Date(query.from) };
  if (query.to) filter.createdAt = { ...(filter.createdAt || {}), $lte: new Date(query.to) };
  if (query.status) filter.status = query.status;
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (query.customer) {
    filter.$or = [
      { 'shippingAddress.firstName': { $regex: query.customer, $options: 'i' } },
      { 'shippingAddress.lastName': { $regex: query.customer, $options: 'i' } },
      { contact: { $regex: query.customer, $options: 'i' } }
    ];
  }
  return filter;
}

function orderRow(o) {
  const sa = o.shippingAddress || {};
  const cur = o.currency || 'AED';
  return {
    'Order #': o._id ? String(o._id).slice(-6).toUpperCase() : '',
    Customer: `${sa.firstName || ''} ${sa.lastName || ''}`.trim(),
    Phone: sa.phone || o.contact || '',
    Items: (o.items || []).map(i => i.name).join(', '),
    'Subtotal': o.subtotal || 0,
    Shipping: o.shippingCost || 0,
    Coupon: o.coupon && o.coupon.code ? o.coupon.code : '',
    'Coupon Discount': o.coupon ? (o.coupon.discountAmount || 0) : 0,
    'Advance Paid': o.advancePaid || 0,
    'Remaining': o.remainingAmount != null ? o.remainingAmount : (o.total || 0),
    'Order Total': o.total || 0,
    Currency: cur,
    Payment: paymentLabel(o.paymentMethod),
    Status: o.status || 'pending',
    Date: o.createdAt ? new Date(o.createdAt).toLocaleDateString() : ''
  };
}

function orderCsv(orders) {
  const rows = orders.map(orderRow);
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\r\n');
}

function buildOrderPdf(orders, title = 'Orders Export') {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.rect(0, 0, 595, 70).fill('#B8860B');
      doc.fill('#FFF').fontSize(20).font('Helvetica-Bold').text(title, 40, 24);
      doc.fontSize(9).fill('#555').text(`Generated ${new Date().toLocaleString()} — BIN SALEH Store`, 40, 50);

      let y = 90;
      doc.rect(40, y, 515, 22).fill('#EEE');
      doc.fill('#111').fontSize(8).font('Helvetica-Bold');
      ['Order', 'Customer', 'Items', 'Total', 'Payment', 'Status', 'Date'].forEach((h, i) => {
        doc.text(h, 44 + i * 74, y + 7, { width: 70 });
      });
      y += 22;

      doc.font('Helvetica').fill('#333');
      orders.forEach(o => {
        const sa = o.shippingAddress || {};
        const vals = [
          (o._id ? String(o._id).slice(-6).toUpperCase() : ''),
          `${sa.firstName || ''} ${sa.lastName || ''}`.trim(),
          (o.items || []).map(i => i.name).join(', ').slice(0, 38),
          `${o.currency || 'AED'} ${(o.total || 0).toLocaleString()}`,
          paymentLabel(o.paymentMethod),
          o.status || '',
          o.createdAt ? new Date(o.createdAt).toLocaleDateString() : ''
        ];
        if (y > 720) { doc.addPage(); y = 60; }
        doc.fontSize(7);
        vals.forEach((v, i) => doc.text(v, 44 + i * 74, y + 4, { width: 70, height: 26, ellipsis: true }));
        y += 22;
      });
      doc.end();
    } catch (err) { reject(err); }
  });
}

function sendCsv(res, csv, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send('\uFEFF' + csv); // BOM for Excel
}

function sendXlsx(res, workbook, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  workbook.xlsx.write(res).then(() => res.end());
}

function sendPdf(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  res.send(buffer);
}

async function buildXlsxFromRows(rows, sheetName) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || 'Sheet1');
  if (!rows.length) { ws.addRow(['No data']); return wb; }
  const headers = Object.keys(rows[0]);
  ws.addRow(headers).font = { bold: true };
  rows.forEach(r => ws.addRow(headers.map(h => r[h])));
  ws.columns = headers.map((h, i) => ({ header: h, key: h, width: Math.max(14, h.length + 4) }));
  return wb;
}

// ---------- Order exports ----------

// GET /api/export/orders?format=xlsx|csv|pdf&from=&to=&status=&paymentMethod=&customer=
exports.exportOrders = async (req, res) => {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    const filter = buildOrderFilter(req.query);
    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();
    const filename = `bin-saleh-orders-${Date.now()}`;

    if (format === 'xlsx') {
      const wb = await buildXlsxFromRows(orders.map(orderRow), 'Orders');
      await log({ category: 'report', action: 'Orders exported (xlsx)', details: { count: orders.length }, actor: req.user?.email || 'admin' });
      return sendXlsx(res, wb, filename);
    }
    if (format === 'pdf') {
      const buf = await buildOrderPdf(orders, 'Orders Export');
      await log({ category: 'report', action: 'Orders exported (pdf)', details: { count: orders.length }, actor: req.user?.email || 'admin' });
      return sendPdf(res, buf, filename);
    }
    const csv = orderCsv(orders);
    await log({ category: 'report', action: 'Orders exported (csv)', details: { count: orders.length }, actor: req.user?.email || 'admin' });
    sendCsv(res, csv, filename);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ---------- Production reports ----------

// GET /api/export/reports/:type?format=xlsx|csv|pdf&from=&to=
exports.generateReport = async (req, res) => {
  try {
    const type = String(req.params.type || 'sales').toLowerCase();
    const format = String(req.query.format || 'csv').toLowerCase();
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    const dateFilter = {};
    if (from || to) {
      dateFilter.createdAt = {};
      if (from) dateFilter.createdAt.$gte = from;
      if (to) dateFilter.createdAt.$lte = to;
    }

    let rows = [];
    let sheetName = type;
    let title = type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ') + ' Report';

    switch (type) {
      case 'sales': {
        const orders = await Order.find({ ...dateFilter, status: { $ne: 'cancelled' } }).lean();
        rows = orders.map(orderRow);
        break;
      }
      case 'revenue': {
        const agg = await Order.aggregate([
          { $match: { ...(from || to ? { createdAt: dateFilter.createdAt } : {}), status: { $ne: 'cancelled' } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ]);
        rows = agg.map(a => ({ Date: a._id, Orders: a.orders, Revenue: a.revenue, Currency: 'AED' }));
        break;
      }
      case 'profit': {
        const orders = await Order.find({ ...dateFilter, status: { $ne: 'cancelled' } }).lean();
        rows = orders.map(o => {
          const cost = (o.items || []).reduce((s, i) => s + (i.price || 0) * (i.quantity || 1) * 0.6, 0);
          return { ...orderRow(o), 'Estimated Profit': Math.round((o.total || 0) - cost) };
        });
        break;
      }
      case 'best_sellers': {
        const orders = await Order.find(dateFilter).lean();
        const map = {};
        orders.forEach(o => (o.items || []).forEach(i => {
          const key = i.name || 'Unknown';
          map[key] = map[key] || { qty: 0, revenue: 0 };
          map[key].qty += i.quantity || 1;
          map[key].revenue += (i.price || 0) * (i.quantity || 1);
        }));
        rows = Object.entries(map).map(([name, v]) => ({ Product: name, Sold: v.qty, Revenue: v.revenue }))
          .sort((a, b) => b.Sold - a.Sold).slice(0, 20);
        break;
      }
      case 'low_stock': {
        const products = await Product.find().lean();
        rows = products.map(p => ({
          'Product ID': String(p._id),
          Product: p.name,
          Stock: p.stock || 0,
          'Low Stock Threshold': p.lowStockThreshold != null ? p.lowStockThreshold : 5,
          Category: p.category,
          Price: p.price
        })).filter(r => r.Stock <= r['Low Stock Threshold']);
        title = 'Low Stock Report';
        break;
      }
      case 'customers': {
        const users = await User.find({ role: 'customer' }).lean();
        const orderCounts = await Order.aggregate([
          { $group: { _id: '$user', orders: { $sum: 1 }, spent: { $sum: '$total' } } }
        ]);
        const countMap = {};
        orderCounts.forEach(o => { if (o._id) countMap[String(o._id)] = o; });
        rows = users.map(u => {
          const stats = countMap[String(u._id)] || { orders: 0, spent: 0 };
          return {
            Name: u.name || 'Unknown',
            Email: u.email || '',
            Phone: u.phone || '',
            Orders: stats.orders,
            'Total Spent': stats.spent,
            Subscribed: u.newsletter ? 'Yes' : 'No',
            Joined: u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''
          };
        });
        break;
      }
      case 'payments': {
        const agg = await Order.aggregate([
          { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$total' }, paid: { $sum: '$advancePaid' } } },
          { $sort: { total: -1 } }
        ]);
        rows = agg.map(a => ({ 'Payment Method': paymentLabel(a._id), Orders: a.count, Total: a.total, 'Advance Paid': a.paid }));
        break;
      }
      default:
        return res.status(400).json({ message: 'Unknown report type' });
    }

    const filename = `bin-saleh-${type}-${Date.now()}`;
    if (format === 'xlsx') {
      const wb = await buildXlsxFromRows(rows, sheetName);
      await log({ category: 'report', action: `${title} exported (xlsx)`, details: { rows: rows.length }, actor: req.user?.email || 'admin' });
      return sendXlsx(res, wb, filename);
    }
    if (format === 'pdf') {
      const buf = await buildReportPdf(title, rows);
      await log({ category: 'report', action: `${title} exported (pdf)`, details: { rows: rows.length }, actor: req.user?.email || 'admin' });
      return sendPdf(res, buf, filename);
    }
    const csv = rows.length ? orderCsv(rows) : 'No data';
    await log({ category: 'report', action: `${title} exported (csv)`, details: { rows: rows.length }, actor: req.user?.email || 'admin' });
    sendCsv(res, csv, filename);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

function buildReportPdf(title, rows) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.rect(0, 0, 595, 70).fill('#B8860B');
      doc.fill('#FFF').fontSize(18).font('Helvetica-Bold').text(title, 40, 24);
      doc.fontSize(9).fill('#555').text(`BIN SALEH Store — ${new Date().toLocaleString()}`, 40, 50);

      if (!rows.length) {
        doc.fill('#555').fontSize(10).text('No data available for this report.', 40, 100);
        doc.end();
        return;
      }
      const headers = Object.keys(rows[0]);
      let y = 90;
      const colW = Math.floor(500 / headers.length);
      doc.rect(40, y, 515, 20).fill('#EEE');
      doc.fill('#111').fontSize(7).font('Helvetica-Bold');
      headers.forEach((h, i) => doc.text(h, 44 + i * colW, y + 6, { width: colW - 4 }));
      y += 20;
      doc.font('Helvetica').fill('#333');
      rows.forEach(r => {
        if (y > 720) { doc.addPage(); y = 60; }
        doc.fontSize(6);
        headers.forEach((h, i) => {
          const v = r[h] == null ? '' : String(r[h]);
          doc.text(v, 44 + i * colW, y + 4, { width: colW - 4, height: 20, ellipsis: true });
        });
        y += 22;
      });
      doc.end();
    } catch (err) { reject(err); }
  });
}

