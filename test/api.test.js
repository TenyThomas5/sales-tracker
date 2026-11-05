'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, haversineKm } = require('../app');

let server;
let base;

function start(opts) {
  const { app } = createApp(opts);
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

before(async () => {
  server = await start({ dbPath: ':memory:' });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('haversine distance is sane', () => {
  // One degree of latitude is ~111 km.
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.1);
});

test('employee lifecycle', async () => {
  let r = await req('POST', '/api/employees', { name: '' });
  assert.equal(r.status, 400);

  r = await req('POST', '/api/employees', { name: '  Asha  ', phone: '999', region: 'North' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Asha');
  const id = r.body.id;

  r = await req('GET', '/api/employees');
  assert.ok(r.body.some((e) => e.id === id));

  r = await req('PATCH', `/api/employees/${id}`, { active: false });
  assert.equal(r.body.active, 0);
  r = await req('GET', '/api/employees');
  assert.ok(!r.body.some((e) => e.id === id));
  r = await req('GET', '/api/employees?all=1');
  assert.ok(r.body.some((e) => e.id === id));

  // inactive employees cannot log activity
  r = await req('POST', '/api/activities', { employee_id: id, type: 'check_in', lat: 10, lng: 76 });
  assert.equal(r.status, 400);

  r = await req('PATCH', '/api/employees/9999', { active: true });
  assert.equal(r.status, 404);
});

test('activities require valid GPS and fields, and roll up into the summary', async () => {
  const { body: emp } = await req('POST', '/api/employees', { name: 'Ravi' });
  const post = (b) => req('POST', '/api/activities', { employee_id: emp.id, ...b });

  assert.equal((await post({ type: 'check_in' })).status, 400, 'missing GPS');
  assert.equal((await post({ type: 'check_in', lat: null, lng: null })).status, 400, 'null GPS');
  assert.equal((await post({ type: 'check_in', lat: 91, lng: 0 })).status, 400, 'lat out of range');
  assert.equal((await post({ type: 'teleport', lat: 1, lng: 1 })).status, 400, 'bad type');
  assert.equal((await post({ type: 'visit', lat: 1, lng: 1 })).status, 400, 'visit needs customer');
  assert.equal((await post({ type: 'sale', customer: 'X', lat: 1, lng: 1 })).status, 400, 'sale needs amount');
  assert.equal((await post({ type: 'sale', customer: 'X', amount: -5, lat: 1, lng: 1 })).status, 400, 'negative amount');

  let r = await post({ type: 'check_in', lat: 9.9312, lng: 76.2673, accuracy: 12 });
  assert.equal(r.status, 201);
  assert.equal(r.body.lat, 9.9312);
  await post({ type: 'visit', customer: 'Shop A', notes: 'Interested', lat: 9.9400, lng: 76.2700 });
  await post({ type: 'sale', customer: 'Shop B', amount: '1500.50', lat: 9.9500, lng: 76.2800 });
  await post({ type: 'check_out', lat: 9.9312, lng: 76.2673 });

  r = await req('GET', `/api/employees/${emp.id}/activities`);
  assert.equal(r.body.length, 4);
  assert.equal(r.body[0].type, 'check_out', 'newest first');

  const today = new Date().toISOString().slice(0, 10);
  r = await req('GET', `/api/activities?date=${today}&tz=0&type=sale`);
  assert.ok(r.body.every((a) => a.type === 'sale'));
  assert.ok(r.body.some((a) => a.customer === 'Shop B' && a.amount === 1500.5));

  r = await req('GET', `/api/summary?date=${today}&tz=0`);
  const row = r.body.employees.find((e) => e.employee_id === emp.id);
  assert.equal(row.visits, 2);
  assert.equal(row.sales_count, 1);
  assert.equal(row.sales_total, 1500.5);
  assert.equal(row.status, 'off_duty');
  assert.ok(row.distance_km > 2 && row.distance_km < 10, `distance ${row.distance_km}`);
  assert.equal(row.last.type, 'check_out');

  // A date with no activity
  r = await req('GET', `/api/summary?date=2000-01-01&tz=0`);
  assert.equal(r.body.employees.find((e) => e.employee_id === emp.id).status, 'not_started');

  assert.equal((await req('GET', '/api/summary?date=nope')).status, 400);
});

test('CSV export escapes values and blocks formula injection', async () => {
  const { body: emp } = await req('POST', '/api/employees', { name: 'Meera' });
  await req('POST', '/api/activities', {
    employee_id: emp.id, type: 'visit', customer: '=HYPERLINK("x")', notes: 'a, "b"', lat: -33.86, lng: 151.2,
  });
  const res = await fetch(`${base}/api/export.csv?employee_id=${emp.id}`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /^id,created_at,employee_name/);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"a, ""b"""'));
  assert.ok(csv.includes(',-33.86,151.2,'), 'negative coordinates are not mangled');
});

test('invalid JSON returns 400', async () => {
  const res = await fetch(`${base}/api/activities`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
  });
  assert.equal(res.status, 400);
});

test('ADMIN_PASSWORD protects dashboard and admin APIs but not the field app', async () => {
  const s = await start({ dbPath: ':memory:', adminPassword: 'secret' });
  const url = `http://127.0.0.1:${s.address().port}`;
  const auth = (p) => ({ Authorization: 'Basic ' + Buffer.from(`boss:${p}`).toString('base64') });
  try {
    assert.equal((await fetch(`${url}/admin`)).status, 401);
    assert.equal((await fetch(`${url}/admin.html`)).status, 401);
    assert.equal((await fetch(`${url}/api/summary`)).status, 401);
    assert.equal((await fetch(`${url}/api/activities`)).status, 401);
    assert.equal((await fetch(`${url}/api/export.csv`)).status, 401);
    assert.equal((await fetch(`${url}/api/summary`, { headers: auth('wrong') })).status, 401);
    assert.equal((await fetch(`${url}/admin`, { headers: auth('secret') })).status, 200);

    const add = await fetch(`${url}/api/employees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('secret') }, body: '{"name":"Z"}',
    });
    assert.equal(add.status, 201);
    const { id } = await add.json();

    // Field app endpoints stay open
    assert.equal((await fetch(`${url}/`)).status, 200);
    assert.equal((await fetch(`${url}/api/employees`)).status, 200);
    const log = await fetch(`${url}/api/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: id, type: 'check_in', lat: 1, lng: 2 }),
    });
    assert.equal(log.status, 201);
    assert.equal((await fetch(`${url}/api/employees/${id}/activities`)).status, 200);
  } finally {
    s.close();
  }
});
