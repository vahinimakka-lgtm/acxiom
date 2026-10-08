const express = require('express');
const bcrypt = require('bcryptjs');
const { all, get, run } = require('../db');
const { flash } = require('../flash');
const { logAudit } = require('../audit');
const { requireRole } = require('../auth');
const { isStrongPassword, passwordPolicyMessage, paginate } = require('../utils');

const router = express.Router();

router.use(requireRole('Admin'));

function userFields(values = {}) {
  return [
    { name: 'name', label: 'Name', type: 'text', value: values.name || '', required: true },
    { name: 'email', label: 'Email', type: 'email', value: values.email || '', required: true },
    { name: 'password', label: 'Password', type: 'password', value: '', required: true },
    { name: 'team_name', label: 'Team Name', type: 'text', value: values.team_name || '' },
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      value: values.role || 'Sales Executive',
      options: ['Admin', 'Manager', 'Sales Executive'].map((option) => ({ value: option, label: option })),
      required: true,
    },
  ];
}

router.get('/', (req, res) => res.redirect('/admin/users'));

router.get('/users', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const role = String(req.query.role || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Number(req.query.page || 1);
    const pageSize = 10;

    const params = [];
    const clauses = [];
    if (search) {
      clauses.push('(name LIKE ? OR email LIKE ? OR team_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (role) {
      clauses.push('role = ?');
      params.push(role);
    }
    if (status === 'Active') {
      clauses.push('is_active = 1');
    } else if (status === 'Inactive') {
      clauses.push('is_active = 0');
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await all(`SELECT * FROM users ${where} ORDER BY created_at DESC`, params);
    const pager = paginate(rows, page, pageSize);

    res.render('admin/users', {
      title: 'User Administration',
      users: pager.items,
      pagination: pager,
      search,
      filters: { role, status },
      createFields: userFields({ role: 'Sales Executive' }),
      createAction: '/admin/users',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const teamName = String(req.body.team_name || '').trim();
    const role = String(req.body.role || 'Sales Executive').trim();

    if (!name || !email || !password || !role) {
      flash(req, 'error', 'Name, email, password, and role are required.');
      return res.redirect('/admin/users');
    }

    if (!isStrongPassword(password)) {
      flash(req, 'error', passwordPolicyMessage());
      return res.redirect('/admin/users');
    }

    const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      flash(req, 'error', 'A user with that email already exists.');
      return res.redirect('/admin/users');
    }

    const hash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO users (name, email, password_hash, role, team_name, is_active, created_at, updated_at, password_updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [name, email, hash, role, teamName, now, now, now],
    );

    await logAudit(req, {
      module: 'Administration',
      action: 'Create User',
      entityName: 'User',
      recordId: result.lastID,
      newValue: { name, email, role, teamName },
    });

    flash(req, 'success', 'User created successfully.');
    return res.redirect('/admin/users');
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/role', async (req, res, next) => {
  try {
    const role = String(req.body.role || '').trim();
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      flash(req, 'error', 'User not found.');
      return res.redirect('/admin/users');
    }

    await run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [role, new Date().toISOString(), user.id]);
    await logAudit(req, { module: 'Administration', action: 'Role Update', entityName: 'User', recordId: user.id, oldValue: user, newValue: { role } });
    flash(req, 'success', 'Role updated.');
    return res.redirect('/admin/users');
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/toggle', async (req, res, next) => {
  try {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      flash(req, 'error', 'User not found.');
      return res.redirect('/admin/users');
    }

    const isActive = Number(user.is_active) === 1 ? 0 : 1;
    await run('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?', [isActive, new Date().toISOString(), user.id]);
    await logAudit(req, { module: 'Administration', action: 'Status Toggle', entityName: 'User', recordId: user.id, oldValue: user, newValue: { is_active: isActive } });
    flash(req, 'success', 'Account status updated.');
    return res.redirect('/admin/users');
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      flash(req, 'error', 'User not found.');
      return res.redirect('/admin/users');
    }

    if (!isStrongPassword(password)) {
      flash(req, 'error', passwordPolicyMessage());
      return res.redirect('/admin/users');
    }

    const hash = await bcrypt.hash(password, 12);
    await run('UPDATE users SET password_hash = ?, failed_login_count = 0, lockout_until = NULL, password_updated_at = ?, updated_at = ? WHERE id = ?', [hash, new Date().toISOString(), new Date().toISOString(), user.id]);
    await logAudit(req, { module: 'Administration', action: 'Reset Password', entityName: 'User', recordId: user.id, oldValue: user, newValue: { passwordReset: true } });
    flash(req, 'success', 'Password reset.');
    return res.redirect('/admin/users');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
