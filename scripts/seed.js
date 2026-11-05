'use strict';

// Fills the database with a few demo employees and today's GPS-tagged activity.
// Usage: npm run seed   (respects DB_PATH, defaults to data/tracker.db)

const path = require('node:path');
const { createApp } = require('../app');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tracker.db');
const { db } = createApp({ dbPath });

const center = { lat: Number(process.env.SEED_LAT) || 9.9816, lng: Number(process.env.SEED_LNG) || 76.2999 };
const reps = [
  { name: 'Asha Menon', phone: '+91 98470 11111', region: 'North' },
  { name: 'Ravi Kumar', phone: '+91 98470 22222', region: 'Central' },
  { name: 'Meera Nair', phone: '+91 98470 33333', region: 'South' },
];
const shops = ['City Mart', 'Green Grocers', 'Lakeview Stores', 'Sunrise Traders', 'Metro Supplies', 'Harbour Retail', 'Royal Bakery'];

const insEmp = db.prepare('INSERT INTO employees (name, phone, region) VALUES (?, ?, ?)');
const insAct = db.prepare(
  `INSERT INTO activities (employee_id, type, customer, notes, amount, lat, lng, accuracy, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

// The demo day starts 5 hours ago (but never before local midnight) so every point lands on today.
const midnight = new Date();
midnight.setHours(0, 0, 0, 0);
const start = new Date(Math.max(Date.now() - 5 * 3600000, midnight.getTime() + 60000));
const jitter = (n) => (Math.random() - 0.5) * n;

reps.forEach((rep, i) => {
  const { lastInsertRowid: id } = insEmp.run(rep.name, rep.phone, rep.region);
  let lat = center.lat + (i - 1) * 0.03;
  let lng = center.lng + jitter(0.02);
  let t = start.getTime() + i * 10 * 60000;
  const stamp = () => new Date(t).toISOString();
  const now = Date.now();

  insAct.run(id, 'check_in', null, null, null, lat, lng, 10, stamp());
  for (let k = 0; k < 4; k++) {
    t += (40 + Math.random() * 30) * 60000;
    if (t > now) return; // don't invent the future
    lat += jitter(0.02);
    lng += jitter(0.02);
    const shop = shops[(i * 2 + k) % shops.length];
    const sold = Math.random() < 0.5;
    insAct.run(id, sold ? 'sale' : 'visit', shop, sold ? 'Order placed' : 'Follow up next week',
      sold ? Math.round(500 + Math.random() * 4500) : null, lat, lng, 8 + Math.random() * 20, stamp());
  }
  if (i === 2 && t + 30 * 60000 < now) {
    t += 30 * 60000;
    insAct.run(id, 'check_out', null, null, null, lat, lng, 12, stamp());
  }
});

console.log(`Seeded ${reps.length} employees into ${dbPath}`);
