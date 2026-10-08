const express = require('express');
const bcrypt = require('bcryptjs');
const { all, get, run } = require('../db');
const { authenticateUser, accessibleWhereClause } = require('../auth');
const { normalizeEmail, todayISO } = require('../utils');

const router = express.Router();

function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function ensureApiAuth(req, res, next) {
  if (!req.user) {
    return jsonError(res, 401, 'Authentication required.');
  }

  return next();
}

router.post('/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const result = await authenticateUser({ email, password });
  if (!result.success) {
    return jsonError(res, 401, result.reason);
  }

  req.session.userId = result.user.id;
  return res.json({ ok: true, user: { id: result.user.id, name: result.user.name, email: result.user.email, role: result.user.role } });
});

router.post('/auth/logout', ensureApiAuth, async (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get('/reports/pipeline', ensureApiAuth, async (req, res, next) => {
  try {
    const scope = accessibleWhereClause(req.user, 'o', { ownerColumn: 'o.owner_id', assignedColumn: 'o.assigned_to_id' });
    const rows = await all(`SELECT stage, SUM(amount) AS totalAmount, COUNT(*) AS totalCount FROM opportunities o WHERE ${scope.clause} GROUP BY stage ORDER BY totalAmount DESC`, scope.params);
    res.json({ ok: true, rows });
  } catch (error) {
    next(error);
  }
});

async function listEntity(res, table, alias, scope, searchSql = '', params = []) {
  const rows = await all(`SELECT * FROM ${table} ${alias ? `AS ${alias}` : ''} WHERE ${scope.clause}${searchSql} ORDER BY created_at DESC`, [...scope.params, ...params]);
  return res.json({ ok: true, data: rows });
}

function buildSearchSql(query, fields) {
  if (!query) {
    return { sql: '', params: [] };
  }

  const like = `%${query}%`;
  const sql = ` AND (${fields.map((field) => `${field} LIKE ?`).join(' OR ')})`;
  return { sql, params: fields.map(() => like) };
}

router.get('/customers', ensureApiAuth, async (req, res, next) => {
  try {
    const scope = accessibleWhereClause(req.user, 'c', { ownerColumn: 'c.owner_id', assignedColumn: 'c.owner_id' });
    const search = String(req.query.q || '').trim();
    const searchSql = buildSearchSql(search, ['customer_code', 'name', 'email', 'phone', 'status']);
    const rows = await all(`SELECT * FROM customers c WHERE ${scope.clause}${searchSql.sql} ORDER BY created_at DESC`, [...scope.params, ...searchSql.params]);
    res.json({ ok: true, data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/customers', ensureApiAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const phone = String(req.body.phone || '').trim();
    if (!name || !email || !phone) return jsonError(res, 400, 'Name, email, and phone are required.');
    const existing = await get('SELECT COUNT(*) AS count FROM customers');
    const code = `CUST-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(`INSERT INTO customers (customer_code, name, email, phone, address, status, owner_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [code, name, email, phone, String(req.body.address || ''), String(req.body.status || 'Active'), req.user.id, req.user.id, now, now]);
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (error) {
    next(error);
  }
});

router.put('/customers/:id', ensureApiAuth, async (req, res, next) => {
  try {
    const record = await get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!record) return jsonError(res, 404, 'Customer not found.');
    await run(`UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, status = ?, updated_at = ? WHERE id = ?`, [String(req.body.name || record.name).trim(), normalizeEmail(req.body.email || record.email), String(req.body.phone || record.phone).trim(), String(req.body.address || record.address || ''), String(req.body.status || record.status), new Date().toISOString(), record.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/customers/:id', ensureApiAuth, async (req, res, next) => {
  try {
    const record = await get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!record) return jsonError(res, 404, 'Customer not found.');
    await run(`UPDATE customers SET status = 'Inactive', updated_at = ? WHERE id = ?`, [new Date().toISOString(), record.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/leads', ensureApiAuth, async (req, res, next) => {
  try {
    const scope = accessibleWhereClause(req.user, 'l', { ownerColumn: 'l.owner_id', assignedColumn: 'l.assigned_to_id' });
    const search = String(req.query.q || '').trim();
    const searchSql = buildSearchSql(search, ['lead_code', 'name', 'email', 'phone', 'status', 'source']);
    const rows = await all(`SELECT * FROM leads l WHERE ${scope.clause}${searchSql.sql} ORDER BY created_at DESC`, [...scope.params, ...searchSql.params]);
    res.json({ ok: true, data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/leads', ensureApiAuth, async (req, res, next) => {
  try {
    const existing = await get('SELECT COUNT(*) AS count FROM leads');
    const code = `LEAD-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(`INSERT INTO leads (lead_code, customer_id, name, email, phone, source, status, priority, expected_value, expected_close_date, notes, owner_id, assigned_to_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [code, req.body.customer_id ? Number(req.body.customer_id) : null, String(req.body.name || '').trim(), normalizeEmail(req.body.email), String(req.body.phone || '').trim(), String(req.body.source || '').trim(), String(req.body.status || 'New').trim(), String(req.body.priority || 'Medium').trim(), Number(req.body.expected_value || 0), String(req.body.expected_close_date || '') || null, String(req.body.notes || ''), req.user.id, req.user.id, req.user.id, now, now]);
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (error) {
    next(error);
  }
});

router.put('/leads/:id', ensureApiAuth, async (req, res, next) => {
  try {
    const record = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!record) return jsonError(res, 404, 'Lead not found.');
    await run(`UPDATE leads SET name = ?, email = ?, phone = ?, source = ?, status = ?, priority = ?, expected_value = ?, expected_close_date = ?, notes = ?, updated_at = ? WHERE id = ?`, [String(req.body.name || record.name).trim(), normalizeEmail(req.body.email || record.email), String(req.body.phone || record.phone).trim(), String(req.body.source || record.source).trim(), String(req.body.status || record.status), String(req.body.priority || record.priority), Number(req.body.expected_value || record.expected_value), String(req.body.expected_close_date || record.expected_close_date || '') || null, String(req.body.notes || record.notes || ''), new Date().toISOString(), record.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/leads/:id', ensureApiAuth, async (req, res, next) => {
  try {
    const record = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!record) return jsonError(res, 404, 'Lead not found.');
    await run(`UPDATE leads SET status = 'Lost', updated_at = ? WHERE id = ?`, [new Date().toISOString(), record.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/opportunities', ensureApiAuth, async (req, res, next) => {
  try {
    const scope = accessibleWhereClause(req.user, 'o', { ownerColumn: 'o.owner_id', assignedColumn: 'o.assigned_to_id' });
    const search = String(req.query.q || '').trim();
    const searchSql = buildSearchSql(search, ['opportunity_code', 'name', 'stage', 'status', 'source']);
    const rows = await all(`SELECT * FROM opportunities o WHERE ${scope.clause}${searchSql.sql} ORDER BY created_at DESC`, [...scope.params, ...searchSql.params]);
    res.json({ ok: true, data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/opportunities', ensureApiAuth, async (req, res, next) => {
  try {
    const existing = await get('SELECT COUNT(*) AS count FROM opportunities');
    const code = `OPP-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(`INSERT INTO opportunities (opportunity_code, customer_id, lead_id, name, amount, probability, stage, expected_close_date, status, source, notes, owner_id, assigned_to_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [code, req.body.customer_id ? Number(req.body.customer_id) : null, req.body.lead_id ? Number(req.body.lead_id) : null, String(req.body.name || '').trim(), Number(req.body.amount || 0), Number(req.body.probability || 0), String(req.body.stage || 'Qualification').trim(), String(req.body.expected_close_date || '') || null, String(req.body.status || 'Open').trim(), String(req.body.source || ''), String(req.body.notes || ''), req.user.id, req.user.id, req.user.id, now, now]);
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (error) {
    next(error);
  }
});

router.put('/opportunities/:id', ensureApiAuth, async (req, res, next) => {
  try {
    const record = await get('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!record) return jsonError(res, 404, 'Opportunity not found.');
    await run(`UPDATE opportunities SET name = ?, amount = ?, probability = ?, stage = ?, expected_close_date = ?, status = ?, source = ?, notes = ?, updated_at = ? WHERE id = ?`, [String(req.body.name || record.name).trim(), Number(req.body.amount || record.amount), Number(req.body.probability || record.probability), String(req.body.stage || record.stage), String(req.body.expected_close_date || record.expected_close_date || '') || null, String(req.body.status || record.status), String(req.body.source || record.source), String(req.body.notes || record.notes || ''), new Date().toISOString(), record.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/opportunities/:id', ensureApiAuth, async (req, res, next) => {
  try {
    const record = await get('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!record) return jsonError(res, 404, 'Opportunity not found.');
    await run(`UPDATE opportunities SET status = 'Lost', updated_at = ? WHERE id = ?`, [new Date().toISOString(), record.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/followups', ensureApiAuth, async (req, res, next) => {
  try {
    const scope = accessibleWhereClause(req.user, 'f', { ownerColumn: 'f.created_by', assignedColumn: 'f.assigned_to_id' });
    const search = String(req.query.q || '').trim();
    const searchSql = buildSearchSql(search, ['followup_code', 'subject', 'type', 'status', 'related_type']);
    const rows = await all(`SELECT * FROM followups f WHERE ${scope.clause}${searchSql.sql} ORDER BY created_at DESC`, [...scope.params, ...searchSql.params]);
    res.json({ ok: true, data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/followups', ensureApiAuth, async (req, res, next) => {
  try {
    const existing = await get('SELECT COUNT(*) AS count FROM followups');
    const code = `FUP-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(`INSERT INTO followups (followup_code, related_type, related_id, subject, follow_up_date, type, status, notes, assigned_to_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [code, String(req.body.related_type || 'Lead'), req.body.related_id ? Number(req.body.related_id) : null, String(req.body.subject || '').trim(), String(req.body.follow_up_date || todayISO()), String(req.body.type || 'Call'), String(req.body.status || 'Planned'), String(req.body.notes || ''), req.user.id, req.user.id, now, now]);
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (error) {
    next(error);
  }
});

router.put('/followups/:id', ensureApiAuth, async (req, res, next) => {
  try {
    const record = await get('SELECT * FROM followups WHERE id = ?', [req.params.id]);
    if (!record) return jsonError(res, 404, 'Follow-up not found.');
    await run(`UPDATE followups SET subject = ?, follow_up_date = ?, type = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`, [String(req.body.subject || record.subject).trim(), String(req.body.follow_up_date || record.follow_up_date), String(req.body.type || record.type), String(req.body.status || record.status), String(req.body.notes || record.notes || ''), new Date().toISOString(), record.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/followups/:id', ensureApiAuth, async (req, res, next) => {
  try {
    const record = await get('SELECT * FROM followups WHERE id = ?', [req.params.id]);
    if (!record) return jsonError(res, 404, 'Follow-up not found.');
    await run(`UPDATE followups SET status = 'Cancelled', updated_at = ? WHERE id = ?`, [new Date().toISOString(), record.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
