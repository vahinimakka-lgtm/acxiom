const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const dbDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dbDir, 'acxiomcrm.sqlite3');

let database;

function openDatabase() {
  if (database) {
    return database;
  }

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  database = new sqlite3.Database(dbPath);
  database.serialize(() => {
    database.run('PRAGMA foreign_keys = ON');
  });

  return database;
}

function run(sql, params = []) {
  const db = openDatabase();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  const db = openDatabase();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

function all(sql, params = []) {
  const db = openDatabase();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

async function initSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      team_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      lockout_until TEXT,
      password_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT,
      status TEXT NOT NULL,
      owner_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(email)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)');

  await run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_code TEXT NOT NULL UNIQUE,
      customer_id INTEGER,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      expected_value REAL NOT NULL DEFAULT 0,
      expected_close_date TEXT,
      notes TEXT,
      owner_id INTEGER,
      assigned_to_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (owner_id) REFERENCES users(id),
      FOREIGN KEY (assigned_to_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_code TEXT NOT NULL UNIQUE,
      customer_id INTEGER,
      lead_id INTEGER,
      name TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      probability INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL,
      expected_close_date TEXT,
      status TEXT NOT NULL,
      source TEXT,
      notes TEXT,
      owner_id INTEGER,
      assigned_to_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      FOREIGN KEY (owner_id) REFERENCES users(id),
      FOREIGN KEY (assigned_to_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      followup_code TEXT NOT NULL UNIQUE,
      related_type TEXT NOT NULL,
      related_id INTEGER,
      subject TEXT NOT NULL,
      follow_up_date TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT,
      assigned_to_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (assigned_to_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_code TEXT NOT NULL UNIQUE,
      activity_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT,
      activity_date TEXT NOT NULL,
      customer_id INTEGER,
      lead_id INTEGER,
      opportunity_id INTEGER,
      assigned_to_id INTEGER,
      status TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id),
      FOREIGN KEY (assigned_to_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      record_id TEXT,
      old_value TEXT,
      new_value TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
}

async function seedIfEmpty() {
  const existing = await get('SELECT COUNT(*) AS count FROM users');
  if (existing.count > 0) {
    return;
  }

  const now = new Date().toISOString();
  const adminHash = await bcrypt.hash('Admin@123', 12);
  const managerHash = await bcrypt.hash('Manager@123', 12);
  const salesHash = await bcrypt.hash('Sales@123', 12);

  const users = [
    { name: 'Axiom Admin', email: 'admin@acxiom.local', passwordHash: adminHash, role: 'Admin', teamName: 'Operations' },
    { name: 'Axiom Manager', email: 'manager@acxiom.local', passwordHash: managerHash, role: 'Manager', teamName: 'Sales Team A' },
    { name: 'Axiom Sales', email: 'sales@acxiom.local', passwordHash: salesHash, role: 'Sales Executive', teamName: 'Sales Team A' },
  ];

  for (const user of users) {
    await run(
      `INSERT INTO users (name, email, password_hash, role, team_name, is_active, created_at, updated_at, password_updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [user.name, user.email, user.passwordHash, user.role, user.teamName, now, now, now],
    );
  }

  const admin = await get('SELECT id FROM users WHERE email = ?', ['admin@acxiom.local']);
  const manager = await get('SELECT id FROM users WHERE email = ?', ['manager@acxiom.local']);
  const sales = await get('SELECT id FROM users WHERE email = ?', ['sales@acxiom.local']);

  const customerOne = await run(
    `INSERT INTO customers (customer_code, name, email, phone, address, status, owner_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['CUST-0001', 'Northwind Traders', 'info@northwind.test', '5551001001', '1 Market Street', 'Active', manager.id, admin.id, now, now],
  );

  const customerTwo = await run(
    `INSERT INTO customers (customer_code, name, email, phone, address, status, owner_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['CUST-0002', 'Contoso Retail', 'sales@contoso.test', '5551001002', '22 Commerce Ave', 'Active', sales.id, admin.id, now, now],
  );

  const leadOne = await run(
    `INSERT INTO leads (lead_code, customer_id, name, email, phone, source, status, priority, expected_value, expected_close_date, notes, owner_id, assigned_to_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['LEAD-0001', customerOne.lastID, 'Northwind Expansion', 'buyer@northwind.test', '5552001001', 'Referral', 'Qualified', 'High', 48000, '2026-11-15', 'Enterprise expansion opportunity', manager.id, sales.id, admin.id, now, now],
  );

  const leadTwo = await run(
    `INSERT INTO leads (lead_code, customer_id, name, email, phone, source, status, priority, expected_value, expected_close_date, notes, owner_id, assigned_to_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['LEAD-0002', customerTwo.lastID, 'Contoso Upgrade', 'decision@contoso.test', '5552001002', 'Web', 'Contacted', 'Medium', 22000, '2026-11-20', 'Follow up on upgrade package', sales.id, sales.id, admin.id, now, now],
  );

  const opportunityOne = await run(
    `INSERT INTO opportunities (opportunity_code, customer_id, lead_id, name, amount, probability, stage, expected_close_date, status, source, notes, owner_id, assigned_to_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['OPP-0001', customerOne.lastID, leadOne.lastID, 'Northwind Annual Renewal', 48000, 65, 'Proposal', '2026-11-20', 'Open', 'Referral', 'Renewal with upsell', manager.id, sales.id, admin.id, now, now],
  );

  const opportunityTwo = await run(
    `INSERT INTO opportunities (opportunity_code, customer_id, lead_id, name, amount, probability, stage, expected_close_date, status, source, notes, owner_id, assigned_to_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['OPP-0002', customerTwo.lastID, leadTwo.lastID, 'Contoso Upgrade Package', 22000, 40, 'Qualification', '2026-12-01', 'Open', 'Web', 'Upgrade from legacy package', sales.id, sales.id, admin.id, now, now],
  );

  await run(
    `INSERT INTO followups (followup_code, related_type, related_id, subject, follow_up_date, type, status, notes, assigned_to_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['FUP-0001', 'Lead', leadOne.lastID, 'Proposal review call', '2026-10-12', 'Call', 'Planned', 'Discuss pricing', sales.id, admin.id, now, now],
  );

  await run(
    `INSERT INTO activities (activity_code, activity_type, subject, description, activity_date, customer_id, lead_id, opportunity_id, assigned_to_id, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['ACT-0001', 'Call', 'Renewal discovery', 'Initial discovery call with Northwind', '2026-10-08', customerOne.lastID, leadOne.lastID, opportunityOne.lastID, sales.id, 'Open', admin.id, now, now],
  );

  await run(
    `INSERT INTO audit_logs (user_id, user_name, module, action, entity_name, record_id, old_value, new_value, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [admin.id, 'Axiom Admin', 'Seed', 'Create', 'System', 'SEED', null, 'Seeded initial users, customers, leads, opportunities, and follow-ups', '127.0.0.1', now],
  );
}

async function initDb() {
  openDatabase();
  await initSchema();
  await seedIfEmpty();
}

module.exports = {
  openDatabase,
  run,
  get,
  all,
  initDb,
};
