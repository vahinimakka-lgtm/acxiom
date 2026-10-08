const express = require('express');
const bcrypt = require('bcryptjs');
const { all, get, run } = require('../db');
const { flash } = require('../flash');
const { logAudit } = require('../audit');
const { authenticateUser, requireAuthentication } = require('../auth');
const { isStrongPassword, passwordPolicyMessage, normalizeEmail } = require('../utils');

const router = express.Router();

router.get('/login', (req, res) => {
  res.render('auth/login', { title: 'Sign in' });
});

router.post('/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const result = await authenticateUser({ email, password });

    if (!result.success) {
      await logAudit(req, {
        module: 'Authentication',
        action: 'Login Failed',
        entityName: 'User',
        recordId: email,
        newValue: { email },
        actor: { id: null, name: email },
      });
      flash(req, 'error', result.reason);
      return res.redirect('/login');
    }

    req.session.userId = result.user.id;
    req.user = result.user;
    await logAudit(req, {
      module: 'Authentication',
      action: 'Login',
      entityName: 'User',
      recordId: result.user.id,
      newValue: { email: result.user.email },
      actor: result.user,
    });
    flash(req, 'success', 'Signed in successfully.');
    return res.redirect('/dashboard');
  } catch (error) {
    next(error);
  }
});

router.get('/register', (req, res) => {
  res.render('auth/register', { title: 'Register' });
});

router.post('/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    const teamName = String(req.body.team_name || '').trim();

    if (!name || !email || !password) {
      flash(req, 'error', 'All required fields must be completed.');
      return res.redirect('/register');
    }

    if (password !== confirmPassword) {
      flash(req, 'error', 'Passwords do not match.');
      return res.redirect('/register');
    }

    if (!isStrongPassword(password)) {
      flash(req, 'error', passwordPolicyMessage());
      return res.redirect('/register');
    }

    const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      flash(req, 'error', 'An account with that email already exists.');
      return res.redirect('/register');
    }

    const now = new Date().toISOString();
    const hash = await bcrypt.hash(password, 12);
    const result = await run(
      `INSERT INTO users (name, email, password_hash, role, team_name, is_active, created_at, updated_at, password_updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [name, email, hash, 'Sales Executive', teamName, now, now, now],
    );

    const created = await get('SELECT id, name, email, role FROM users WHERE id = ?', [result.lastID]);
    await logAudit(req, {
      module: 'Authentication',
      action: 'Register',
      entityName: 'User',
      recordId: result.lastID,
      newValue: { email, role: 'Sales Executive' },
      actor: created,
    });

    flash(req, 'success', 'Account created. You can sign in now.');
    return res.redirect('/login');
  } catch (error) {
    next(error);
  }
});

router.post('/logout', requireAuthentication, async (req, res, next) => {
  try {
    const actor = req.user;
    await logAudit(req, {
      module: 'Authentication',
      action: 'Logout',
      entityName: 'User',
      recordId: actor.id,
      newValue: { email: actor.email },
      actor,
    });

    req.session.destroy(() => {
      res.redirect('/login');
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
