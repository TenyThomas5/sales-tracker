'use strict';

const path = require('node:path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tracker.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const { app } = createApp({ dbPath: DB_PATH, adminPassword: ADMIN_PASSWORD });

app.listen(PORT, () => {
  console.log(`Sales Tracker running on http://localhost:${PORT}`);
  console.log(`  Field app:  http://localhost:${PORT}/`);
  console.log(`  Dashboard:  http://localhost:${PORT}/admin`);
  if (!ADMIN_PASSWORD) console.log('  (Set ADMIN_PASSWORD to protect the dashboard.)');
});
