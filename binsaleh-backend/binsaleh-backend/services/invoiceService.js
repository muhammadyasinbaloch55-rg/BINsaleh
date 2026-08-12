// services/invoiceService.js
// Generates real downloadable PDF invoices with PDFKit (#6) and sends them
// by email with the PDF attached (#7). No browser-print hacks.

const PDFDocument = require('pdfkit');
const { sendInvoiceEmail } = require('./emailService');
const { getBusinessEmail } = require('./emailService');
const { log } = require('./auditService');

// Build a properly-styled invoice PDF buffer for an order.
async function generateInvoicePDF(order) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const gold = '#B8860B';
      const dark = '#111111';
      const gray = '#666666';
      const shortId = order._id ? String(order._id).slice(-6).toUpperCase() : '';
      const cur = (order.currency === 'AED' || !order.currency) ? 'AED' : (order.currency || 'AED');

      // ---------- Header ----------
      doc.rect(0, 0, 595, 110).fill(gold);
      doc.fill('#FFFFFF').fontSize(26).font('Helvetica-Bold')
        .text('BIN SALEH STORE', 50, 32);
      doc.fontSize(10).font('Helvetica')
        .text('UAE Premium Fashion Destination', 50, 66);
      doc.fontSize(9).text('Dubai, United Arab Emirates', 50, 82);
      doc.fill('#FFFFFF').fontSize(10).text('INVOICE', 440, 32);
      doc.fontSize(9).text(`#${shortId}`, 440, 50);

      // ---------- Meta boxes ----------
      const metaTop = 130;
      doc.fill(dark).fontSize(11).font('Helvetica-Bold').text('BILLED TO', 50, metaTop);
      const sa = order.shippingAddress || {};
      doc.fill(gray).fontSize(10).font('Helvetica').text(
        `${sa.firstName || ''} ${sa.lastName || ''}`.trim() || 'Customer', 50, metaTop + 16);
      doc.fontSize(9).text([
        sa.address || '',
        `${sa.city || ''} ${sa.postal || ''}`.trim(),
        sa.country || ''
      ].filter(Boolean).join('\n'), 50, metaTop + 32);
      doc.fontSize(9).text(`Phone: ${sa.phone || order.contact || 'N/A'}`, 50, metaTop + 74);

      doc.fill(dark).font('Helvetica-Bold').text('ORDER DETAILS', 330, metaTop);
      const details = [
        ['Order Date', order.createdAt ? new Date(order.createdAt).toLocaleDateString() : '—'],
        ['Payment', paymentLabel(order.paymentMethod)],
        ['Status', statusLabel(order.status)],
        ['Invoice Date', new Date().toLocaleDateString()]
      ];
      details.forEach(([k, v], i) => {
        const y = metaTop + 16 + i * 16;
        doc.fill(gray).font('Helvetica').fontSize(9).text(k, 330, y);
        doc.fill(dark).font('Helvetica-Bold').text(v, 440, y);
      });

      // ---------- Items table ----------
      let y = 250;
      doc.rect(50, y, 495, 24).fill('#F2F2F2');
      doc.fill(dark).fontSize(9).font('Helvetica-Bold');
      doc.text('ITEM', 55, y + 8);
      doc.text('QTY', 350, y + 8);
      doc.text('UNIT', 410, y + 8);
      doc.text('TOTAL', 470, y + 8);
      y += 24;

      doc.font('Helvetica').fill(gray);
      (order.items || []).forEach(item => {
        const name = (item.name || 'Product').slice(0, 42);
        doc.fontSize(9).text(name, 55, y + 6);
        doc.text(String(item.quantity || 1), 350, y + 6);
        doc.text(`${cur} ${Number(item.price || 0).toLocaleString()}`, 410, y + 6);
        doc.text(`${cur} ${((Number(item.price) || 0) * (Number(item.quantity) || 1)).toLocaleString()}`, 470, y + 6);
        y += 22;
        if (y > 700) { doc.addPage(); y = 60; }
      });

      // ---------- Totals ----------
      y += 10;
      doc.fill(gray).fontSize(10);
      doc.text('Subtotal', 390, y);
      doc.fill(dark).font('Helvetica-Bold').text(`${cur} ${(order.subtotal || 0).toLocaleString()}`, 470, y);
      y += 18;
      doc.fill(gray).font('Helvetica');
      doc.text('Shipping', 390, y);
      doc.fill(dark).font('Helvetica-Bold').text(`${cur} ${(order.shippingCost || 0).toLocaleString()}`, 470, y);
      y += 18;
      if (order.coupon && order.coupon.discountAmount) {
        doc.fill(gray).font('Helvetica');
        doc.text(`Coupon (${order.coupon.code || ''})`, 390, y);
        doc.fill('#C62828').font('Helvetica-Bold').text(`- ${cur} ${Number(order.coupon.discountAmount).toLocaleString()}`, 470, y);
        y += 18;
      }
      doc.fill(gray).font('Helvetica');
      doc.text('Advance Paid', 390, y);
      doc.fill(dark).font('Helvetica-Bold').text(`${cur} ${(order.advancePaid || 0).toLocaleString()}`, 470, y);
      y += 18;
      doc.fill(gray).font('Helvetica');
      doc.text('Remaining', 390, y);
      doc.fill(dark).font('Helvetica-Bold').text(`${cur} ${(order.remainingAmount != null ? order.remainingAmount : order.total).toLocaleString()}`, 470, y);
      y += 24;

      // Grand total band
      doc.rect(360, y, 185, 32).fill(gold);
      doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(12).text(`TOTAL  ${cur} ${(order.total || 0).toLocaleString()}`, 375, y + 9);
      y += 48;

      // ---------- Footer ----------
      doc.fill(gray).fontSize(8).text('Thank you for shopping with BIN SALEH Store!', 50, y);
      doc.text(`Questions? Contact binsalehllc946@gmail.com or WhatsApp +9710566551046`, 50, y + 14);
      doc.text(`Generated ${new Date().toLocaleString()}`, 50, y + 28);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function paymentLabel(m) {
  const map = { cod: 'Cash on Delivery', paypal: 'PayPal', zeina: 'Ziina', myfatoorah: 'myFatoorah', paytabs: 'PayTabs', moyasar: 'Moyasar', bank: 'Bank Transfer', bank_app: 'Bank App', jazzcash: 'JazzCash', easypaisa: 'EasyPaisa', hbl: 'HBL', meezan: 'Meezan' };
  return map[m] || (m ? String(m).toUpperCase() : '—');
}

function statusLabel(s) {
  const map = {
    pending: 'Pending', confirmed: 'Confirmed', processing: 'Processing', packed: 'Packed',
    shipped: 'Shipped', out_for_delivery: 'Out for Delivery', delivered: 'Delivered',
    cancelled: 'Cancelled', refunded: 'Refunded'
  };
  return map[s] || s || '—';
}

// HTML invoice email body (with PDF attached)
function invoiceEmailHtml(order) {
  const sa = order.shippingAddress || {};
  const shortId = order._id ? String(order._id).slice(-6).toUpperCase() : '';
  const cur = (order.currency === 'AED' || !order.currency) ? 'AED' : (order.currency || 'AED');
  const rows = (order.items || []).map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${item.name || 'Product'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${item.quantity || 1}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${cur} ${(Number(item.price) || 0).toLocaleString()}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${cur} ${((Number(item.price) || 0) * (Number(item.quantity) || 1)).toLocaleString()}</td>
    </tr>`).join('');
  return `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Invoice #${shortId}</h2>
      <p style="color:#555">Hi ${sa.firstName || 'Valued Customer'}, your invoice is attached as a PDF.</p>
      <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin:16px 0">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="text-align:left;padding:8px;border-bottom:2px solid #b8860b;color:#b8860b">Item</th>
            <th style="padding:8px;border-bottom:2px solid #b8860b;color:#b8860b">Qty</th>
            <th style="text-align:right;padding:8px;border-bottom:2px solid #b8860b;color:#b8860b">Price</th>
            <th style="text-align:right;padding:8px;border-bottom:2px solid #b8860b;color:#b8860b">Total</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin:12px 0 0"><strong>Order Total:</strong> ${cur} ${(order.total || 0).toLocaleString()}</p>
        <p><strong>Advance Paid:</strong> ${cur} ${(order.advancePaid || 0).toLocaleString()}</p>
        <p><strong>Remaining Amount:</strong> ${cur} ${(order.remainingAmount != null ? order.remainingAmount : order.total).toLocaleString()}</p>
        <p><strong>Payment Method:</strong> ${paymentLabel(order.paymentMethod)}</p>
        <p><strong>Payment Status:</strong> ${String(order.paymentStatus || 'pending').toUpperCase()}</p>
        ${order.paymentReference ? `<p><strong>Payment Reference:</strong> ${order.paymentReference}</p>` : ''}
        ${order.paymentDetails && order.paymentDetails.transactionId ? `<p><strong>Transaction ID:</strong> ${order.paymentDetails.transactionId}</p>` : ''}
        <p><strong>Status:</strong> ${statusLabel(order.status)}</p>
        ${order.trackingNumber ? `<p><strong>Tracking:</strong> ${order.trackingNumber}</p>` : ''}
      </div>
    </div>`;
}

module.exports = { generateInvoicePDF, invoiceEmailHtml, paymentLabel, statusLabel };
