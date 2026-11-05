'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const ACTIVITY_TYPES = ['check_in', 'visit', 'sale', 'check_out'];

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS employees (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      phone      TEXT,
      region     TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS activities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      type        TEXT NOT NULL,
      customer    TEXT,
      notes       TEXT,
      amount      REAL,
      lat         REAL NOT NULL,
      lng         REAL NOT NULL,
      accuracy    REAL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activities_emp_time ON activities(employee_id, created_at);
  `);
  return db;
}

// Great-circle distance in kilometres.
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Turns a YYYY-MM-DD local date into an ISO UTC range [start, end), or null.
// tzOffset is the client's Date#getTimezoneOffset() in minutes (e.g. -330 for IST).
function dayRange(date, tzOffset) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const offset = Number(tzOffset);
  const offsetMs = Number.isFinite(offset) && Math.abs(offset) <= 14 * 60 ? offset * 60000 : 0;
  const start = new Date(new Date(`${date}T00:00:00.000Z`).getTime() + offsetMs);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 86400000);
  return [start.toISOString(), end.toISOString()];
}

function cleanText(v, max = 500) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function adminAuth(password) {
  if (!password) return (_req, _res, next) => next();
  const expected = Buffer.from(password);
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Sales Tracker Admin"');
    res.status(401).send('Authentication required');
  };
}

function createApp({ dbPath = ':memory:', adminPassword = '' } = {}) {
  const db = openDb(dbPath);
  const app = express();
  const admin = adminAuth(adminPassword);

  app.use(express.json({ limit: '100kb' }));

  // The dashboard page itself is protected too, not just its API calls.
  app.get(['/admin', '/admin.html'], admin, (_req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'admin.html')),
  );
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Employees -------------------------------------------------------

  // Public: the field app needs the list so a rep can pick their name.
  app.get('/api/employees', (req, res) => {
    const all = req.query.all === '1';
    const rows = db
      .prepare(`SELECT * FROM employees ${all ? '' : 'WHERE active = 1'} ORDER BY name`)
      .all();
    res.json(rows);
  });

  app.post('/api/employees', admin, (req, res) => {
    const name = cleanText(req.body.name, 100);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const info = db
      .prepare('INSERT INTO employees (name, phone, region) VALUES (?, ?, ?)')
      .run(name, cleanText(req.body.phone, 40), cleanText(req.body.region, 100));
    res.status(201).json(db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid));
  });

  app.patch('/api/employees/:id', admin, (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const name = 'name' in req.body ? cleanText(req.body.name, 100) : emp.name;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const phone = 'phone' in req.body ? cleanText(req.body.phone, 40) : emp.phone;
    const region = 'region' in req.body ? cleanText(req.body.region, 100) : emp.region;
    const active = 'active' in req.body ? (req.body.active ? 1 : 0) : emp.active;
    db.prepare('UPDATE employees SET name = ?, phone = ?, region = ?, active = ? WHERE id = ?').run(
      name, phone, region, active, emp.id,
    );
    res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(emp.id));
  });

  // ---- Activities (GPS-tagged events) ----------------------------------

  app.post('/api/activities', (req, res) => {
    const b = req.body || {};
    const employeeId = Number(b.employee_id);
    const emp = Number.isInteger(employeeId)
      ? db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(employeeId)
      : null;
    if (!emp) return res.status(400).json({ error: 'Unknown or inactive employee' });

    if (!ACTIVITY_TYPES.includes(b.type)) {
      return res.status(400).json({ error: `type must be one of ${ACTIVITY_TYPES.join(', ')}` });
    }
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    if (b.lat === null || b.lng === null || b.lat === undefined || b.lng === undefined ||
        !Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'A valid GPS location (lat, lng) is required' });
    }
    const accuracy = Number.isFinite(Number(b.accuracy)) && b.accuracy !== null ? Number(b.accuracy) : null;

    let amount = null;
    if (b.amount !== undefined && b.amount !== null && b.amount !== '') {
      amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: 'amount must be a non-negative number' });
      }
    }
    if (b.type === 'sale' && amount === null) {
      return res.status(400).json({ error: 'A sale needs an amount' });
    }
    const customer = cleanText(b.customer, 200);
    if ((b.type === 'visit' || b.type === 'sale') && !customer) {
      return res.status(400).json({ error: 'Customer name is required for visits and sales' });
    }

    const info = db
      .prepare(
        `INSERT INTO activities (employee_id, type, customer, notes, amount, lat, lng, accuracy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(emp.id, b.type, customer, cleanText(b.notes, 1000), amount, lat, lng, accuracy);
    res.status(201).json(db.prepare('SELECT * FROM activities WHERE id = ?').get(info.lastInsertRowid));
  });

  function queryActivities(q) {
    const where = [];
    const params = [];
    if (q.employee_id) {
      where.push('a.employee_id = ?');
      params.push(Number(q.employee_id));
    }
    const range = dayRange(q.date, q.tz);
    if (range) {
      where.push('a.created_at >= ? AND a.created_at < ?');
      params.push(...range);
    }
    if (ACTIVITY_TYPES.includes(q.type)) {
      where.push('a.type = ?');
      params.push(q.type);
    }
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 5000);
    return db
      .prepare(
        `SELECT a.*, e.name AS employee_name
           FROM activities a JOIN employees e ON e.id = a.employee_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${limit}`,
      )
      .all(...params);
  }

  // A rep can see their own recent log without the admin password.
  app.get('/api/employees/:id/activities', (req, res) => {
    res.json(queryActivities({ employee_id: req.params.id, limit: Number(req.query.limit) || 20 }));
  });

  app.get('/api/activities', admin, (req, res) => res.json(queryActivities(req.query)));

  // Per-employee summary for one day: counts, sales, distance, last known location.
  app.get('/api/summary', admin, (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const range = dayRange(date, req.query.tz);
    if (!range) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const employees = db.prepare('SELECT * FROM employees WHERE active = 1 ORDER BY name').all();
    const stmt = db.prepare(
      `SELECT * FROM activities WHERE employee_id = ? AND created_at >= ? AND created_at < ?
       ORDER BY created_at, id`,
    );
    const rows = employees.map((emp) => {
      const acts = stmt.all(emp.id, ...range);
      let distanceKm = 0;
      for (let i = 1; i < acts.length; i++) distanceKm += haversineKm(acts[i - 1], acts[i]);
      const last = acts[acts.length - 1] || null;
      const checkedIn = acts.filter((a) => a.type === 'check_in').length >
        acts.filter((a) => a.type === 'check_out').length;
      return {
        employee_id: emp.id,
        name: emp.name,
        region: emp.region,
        visits: acts.filter((a) => a.type === 'visit' || a.type === 'sale').length,
        sales_count: acts.filter((a) => a.type === 'sale').length,
        sales_total: acts.reduce((s, a) => s + (a.type === 'sale' ? a.amount || 0 : 0), 0),
        distance_km: Math.round(distanceKm * 10) / 10,
        status: acts.length === 0 ? 'not_started' : checkedIn ? 'on_duty' : 'off_duty',
        first_at: acts[0]?.created_at || null,
        last: last && { type: last.type, lat: last.lat, lng: last.lng, at: last.created_at, customer: last.customer },
      };
    });
    res.json({ date, employees: rows });
  });

  app.get('/api/export.csv', admin, (req, res) => {
    const rows = queryActivities({ ...req.query, limit: 5000 });
    const cols = ['id', 'created_at', 'employee_name', 'type', 'customer', 'amount', 'notes', 'lat', 'lng', 'accuracy'];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      let s = String(v);
      // Guard text cells against spreadsheet formula injection (numbers such as negative lat/lng stay as-is).
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="activities${req.query.date ? '-' + req.query.date : ''}.csv"`);
    res.send(csv);
  });

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, db };
}

module.exports = { createApp, haversineKm, ACTIVITY_TYPES };
