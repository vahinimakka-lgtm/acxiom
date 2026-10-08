const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run } = require('../db');
const { flash } = require('../flash');
const { logAudit } = require('../audit');
const { requireRole, accessibleWhereClause, canAccessRecord } = require('../auth');
const { normalizeEmail, escapeRegExp, paginate } = require('../utils');

const router = express.Router();

function buildSearchClause(query) {
  if (!query) {
    return { clause: '', params: [] };
  }

  const like = `%${query}%`;
  return {
    clause: ' AND (c.customer_code LIKE ? OR c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.address LIKE ? OR c.status LIKE ?)',
    params: [like, like, like, like, like, like],
  };
}

function customerFields(values = {}, errors = [], users = []) {
  return [
    { name: 'name', label: 'Customer Name', type: 'text', value: values.name || '', required: true },
    { name: 'email', label: 'Email', type: 'email', value: values.email || '', required: true },
    { name: 'phone', label: 'Phone', type: 'text', value: values.phone || '', required: true },
    { name: 'address', label: 'Address', type: 'textarea', value: values.address || '' },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      value: values.status || 'Active',
      options: ['Prospect', 'Active', 'Inactive'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    {
      name: 'owner_id',
      label: 'Owner',
      type: 'select',
      value: String(values.owner_id || ''),
      options: users.map((user) => ({ value: String(user.id), label: `${user.name} (${user.role})` })),
    },
  ];
}

function validateCustomer(payload) {
  const errors = [];
  if (!String(payload.name || '').trim()) errors.push('Customer name is required.');
  if (!normalizeEmail(payload.email)) errors.push('Email is required.');
  if (!String(payload.phone || '').trim()) errors.push('Phone is required.');
  if (!String(payload.status || '').trim()) errors.push('Status is required.');
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) errors.push('Email must be a valid address.');
  if (payload.phone && !/^[0-9()+\-\s]{7,20}$/.test(payload.phone)) errors.push('Phone number format is invalid.');
  return errors;
}

async function validateCustomerUniqueness(payload, customerId = null) {
  const duplicateEmail = customerId
    ? await get('SELECT id FROM customers WHERE lower(email) = lower(?) AND id != ? LIMIT 1', [payload.email, customerId])
    : await get('SELECT id FROM customers WHERE lower(email) = lower(?) LIMIT 1', [payload.email]);
  if (duplicateEmail) {
    return ['A customer with that email already exists.'];
  }

  const duplicatePhone = customerId
    ? await get('SELECT id FROM customers WHERE phone = ? AND id != ? LIMIT 1', [payload.phone, customerId])
    : await get('SELECT id FROM customers WHERE phone = ? LIMIT 1', [payload.phone]);
  if (duplicatePhone) {
    return ['A customer with that phone already exists.'];
  }

  return [];
}

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Number(req.query.page || 1);
    const pageSize = 8;

    const scope = accessibleWhereClause(req.user, 'c', { ownerColumn: 'c.owner_id', assignedColumn: 'c.owner_id' });
    const searchClause = buildSearchClause(search);
    const statusClause = status ? ' AND c.status = ?' : '';
    const statusParams = status ? [status] : [];

    const rows = await all(
      `SELECT c.*, u.name AS owner_name
       FROM customers c
       LEFT JOIN users u ON u.id = c.owner_id
       WHERE ${scope.clause}${searchClause.clause}${statusClause}
       ORDER BY c.created_at DESC`,
      [...scope.params, ...searchClause.params, ...statusParams],
    );

    const pager = paginate(rows, page, pageSize);
    const users = await all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');

    res.render('crm/list', {
      title: 'Customers',
      entityLabel: 'Customer',
      basePath: '/customers',
      createLabel: 'New Customer',
      search,
      filters: { status },
      rows: pager.items,
      pagination: pager,
      columns: [
        { label: 'Code', render: (row) => row.customer_code },
        { label: 'Name', render: (row) => row.name },
        { label: 'Email', render: (row) => row.email },
        { label: 'Phone', render: (row) => row.phone },
        { label: 'Status', render: (row) => row.status },
        { label: 'Owner', render: (row) => row.owner_name || 'Unassigned' },
      ],
      rowActions: (row) => {
        const buttons = [
          `<a class="btn btn-sm btn-outline-primary" href="/customers/${row.id}/edit">Edit</a>`,
          `<form class="d-inline" method="post" action="/customers/${row.id}?_method=DELETE" onsubmit="return confirm('Deactivate this customer?');"><button class="btn btn-sm btn-outline-danger" type="submit">Deactivate</button></form>`,
        ];
        return buttons.join(' ');
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/new', requireRole('Admin', 'Manager', 'Sales Executive'), async (req, res, next) => {
  try {
    const users = await all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');
    res.render('crm/form', {
      title: 'New Customer',
      entityLabel: 'Customer',
      basePath: '/customers',
      action: '/customers',
      method: 'POST',
      values: { owner_id: req.user.id, status: 'Active' },
      fields: customerFields({ owner_id: req.user.id, status: 'Active' }, [], users),
      submitLabel: 'Create Customer',
      cancelPath: '/customers',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireRole('Admin', 'Manager', 'Sales Executive'), async (req, res, next) => {
  try {
    const payload = {
      name: String(req.body.name || '').trim(),
      email: normalizeEmail(req.body.email),
      phone: String(req.body.phone || '').trim(),
      address: String(req.body.address || '').trim(),
      status: String(req.body.status || 'Active').trim(),
      owner_id: req.body.owner_id ? Number(req.body.owner_id) : req.user.id,
    };

    const errors = validateCustomer(payload);
    errors.push(...await validateCustomerUniqueness(payload));
    if (errors.length > 0) {
      const users = await all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');
      return res.status(400).render('crm/form', {
        title: 'New Customer',
        entityLabel: 'Customer',
        basePath: '/customers',
        action: '/customers',
        method: 'POST',
        values: payload,
        fields: customerFields(payload, errors, users),
        submitLabel: 'Create Customer',
        cancelPath: '/customers',
        errors,
      });
    }

    const existing = await get('SELECT COUNT(*) AS count FROM customers');
    const customerCode = `CUST-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO customers (customer_code, name, email, phone, address, status, owner_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [customerCode, payload.name, payload.email, payload.phone, payload.address, payload.status, payload.owner_id, req.user.id, now, now],
    );

    await logAudit(req, {
      module: 'Customer',
      action: 'Create',
      entityName: 'Customer',
      recordId: result.lastID,
      newValue: payload,
    });

    flash(req, 'success', 'Customer created successfully.');
    return res.redirect('/customers');
  } catch (error) {
    next(error);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const customer = await get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) {
      flash(req, 'error', 'Customer not found.');
      return res.redirect('/customers');
    }

    if (!canAccessRecord(req.user, customer)) {
      flash(req, 'error', 'You cannot edit that customer.');
      return res.redirect('/customers');
    }

    const users = await all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');
    res.render('crm/form', {
      title: `Edit ${customer.name}`,
      entityLabel: 'Customer',
      basePath: '/customers',
      action: `/customers/${customer.id}?_method=PUT`,
      method: 'POST',
      values: customer,
      fields: customerFields(customer, [], users),
      submitLabel: 'Save Changes',
      cancelPath: '/customers',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const customer = await get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) {
      flash(req, 'error', 'Customer not found.');
      return res.redirect('/customers');
    }

    if (!canAccessRecord(req.user, customer)) {
      flash(req, 'error', 'You cannot edit that customer.');
      return res.redirect('/customers');
    }

    const payload = {
      name: String(req.body.name || '').trim(),
      email: normalizeEmail(req.body.email),
      phone: String(req.body.phone || '').trim(),
      address: String(req.body.address || '').trim(),
      status: String(req.body.status || 'Active').trim(),
      owner_id: req.body.owner_id ? Number(req.body.owner_id) : customer.owner_id,
    };

    const errors = validateCustomer(payload);
    errors.push(...await validateCustomerUniqueness(payload, customer.id));
    if (errors.length > 0) {
      const users = await all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');
      return res.status(400).render('crm/form', {
        title: `Edit ${customer.name}`,
        entityLabel: 'Customer',
        basePath: '/customers',
        action: `/customers/${customer.id}?_method=PUT`,
        method: 'POST',
        values: payload,
        fields: customerFields(payload, errors, users),
        submitLabel: 'Save Changes',
        cancelPath: '/customers',
        errors,
      });
    }

    const now = new Date().toISOString();
    await run(
      `UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, status = ?, owner_id = ?, updated_at = ? WHERE id = ?`,
      [payload.name, payload.email, payload.phone, payload.address, payload.status, payload.owner_id, now, customer.id],
    );

    await logAudit(req, {
      module: 'Customer',
      action: 'Update',
      entityName: 'Customer',
      recordId: customer.id,
      oldValue: customer,
      newValue: payload,
    });

    flash(req, 'success', 'Customer updated successfully.');
    return res.redirect('/customers');
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const customer = await get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) {
      flash(req, 'error', 'Customer not found.');
      return res.redirect('/customers');
    }

    if (!canAccessRecord(req.user, customer)) {
      flash(req, 'error', 'You cannot deactivate that customer.');
      return res.redirect('/customers');
    }

    const now = new Date().toISOString();
    await run('UPDATE customers SET status = ?, updated_at = ? WHERE id = ?', ['Inactive', now, customer.id]);

    await logAudit(req, {
      module: 'Customer',
      action: 'Deactivate',
      entityName: 'Customer',
      recordId: customer.id,
      oldValue: customer,
      newValue: { status: 'Inactive' },
    });

    flash(req, 'success', 'Customer deactivated.');
    return res.redirect('/customers');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
