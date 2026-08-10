// services/realtime.js
// Socket.IO hub — lets any controller emit real-time events to the admin panel (#11).
// server.js attaches the io instance after creating the HTTP server.

let io = null;

function attachIO(ioInstance) {
  io = ioInstance;
}

function getIO() {
  return io;
}

// Emit a real-time event to all connected ADMIN dashboards only.
// Only sockets that successfully authenticated and joined the 'admins' room
// receive these events — unauthenticated clients are never subscribed.
// Events: new_order, order_status, new_review, stock_update, new_customer,
//         revenue_change, admin_login_request, notification, low_stock
function emit(event, data) {
  try {
    if (!io) return;
    io.to('admins').emit(event, data);
  } catch (e) {
    // Socket errors must never break the request flow
    console.warn('⚠️ Socket emit failed:', e.message);
  }
}

module.exports = { attachIO, getIO, emit };
