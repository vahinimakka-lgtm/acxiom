const bcrypt = require('bcryptjs');
const { get, run } = require('./db');
const { flash } = require('./flash');

const roles = ['Admin', 'Manager', 'Sales Executive'];

function attachAccessHelpers(req, res, next) {
  res.locals.currentUser = req.user || null;
  res.locals.roles = roles;
  res.locals.isAuthenticated = Boolean(req.user);
  res.locals.isAdmin = req.user && req.user.role === 'Admin';
  res.locals.isManager = req.user && req.user.role === 'Manager';
  res.locals.isSales = req.user && req.user.role === 'Sales Executive';
  next();
}

async function loadCurrentUser(req, res, next) {
  if (!req.session.userId) {
    req.user = null;
    return next();
  }

  const user = await get('SELECT id, name, email, role, team_name, is_active, failed_login_count, lockout_until, password_updated_at, created_at FROM users WHERE id = ?', [req.session.userId]);
  if (!user) {
    req.session.userId = null;
    req.user = null;
    return next();
  }

  req.user = user;
  next();
}

function requireAuthentication(req, res, next) {
  if (!req.user) {
    flash(req, 'warning', 'Please sign in to continue.');
    return res.redirect('/login');
  }

  return next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      flash(req, 'warning', 'Please sign in to continue.');
      return res.redirect('/login');
    }

    if (!allowedRoles.includes(req.user.role)) {
      flash(req, 'error', 'You do not have permission to access that page.');
      return res.redirect('/dashboard');
    }

    return next();
  };
}

function canAccessRecord(user, record) {
  if (!user || !record) {
    return false;
  }

  if (user.role === 'Admin' || user.role === 'Manager') {
    return true;
  }

  const ownerId = Number(record.owner_id || record.created_by || 0);
  const assignedToId = Number(record.assigned_to_id || 0);
  return ownerId === Number(user.id) || assignedToId === Number(user.id);
}

async function authenticateUser({ email, password }) {
  const user = await get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    return { success: false, reason: 'Invalid email or password.' };
  }

  if (Number(user.is_active) !== 1) {
    return { success: false, reason: 'This account is inactive.' };
  }

  if (user.lockout_until && new Date(user.lockout_until) > new Date()) {
    return { success: false, reason: 'This account is locked. Try again later.' };
  }

  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) {
    const failedCount = Number(user.failed_login_count || 0) + 1;
    const lockout = failedCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await run('UPDATE users SET failed_login_count = ?, lockout_until = ?, updated_at = ? WHERE id = ?', [failedCount, lockout, new Date().toISOString(), user.id]);
    return { success: false, reason: 'Invalid email or password.' };
  }

  await run('UPDATE users SET failed_login_count = 0, lockout_until = NULL, updated_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
  return { success: true, user };
}

function accessibleWhereClause(user, alias, columns = {}) {
  if (!user || user.role === 'Admin' || user.role === 'Manager') {
    return { clause: '1 = 1', params: [] };
  }

  const ownerColumn = columns.ownerColumn || `${alias}.owner_id`;
  const assignedColumn = columns.assignedColumn || `${alias}.assigned_to_id`;
  return {
    clause: `(${ownerColumn} = ? OR ${assignedColumn} = ? OR ${alias}.created_by = ?)`,
    params: [user.id, user.id, user.id],
  };
}

module.exports = {
  roles,
  attachAccessHelpers,
  loadCurrentUser,
  requireAuthentication,
  requireRole,
  authenticateUser,
  canAccessRecord,
  accessibleWhereClause,
};
