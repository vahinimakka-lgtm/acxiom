const express = require('express');
const { get, all, run } = require('../db');
const { flash } = require('../flash');
const { logAudit } = require('../audit');
const { requireRole, accessibleWhereClause, canAccessRecord } = require('../auth');
const { normalizeEmail, paginate, todayISO } = require('../utils');

const router = express.Router();

function buildSearchClause(query) {
  if (!query) {
    return { clause: '', params: [] };
  }

  const like = `%${query}%`;
  return {
    clause: ' AND (l.lead_code LIKE ? OR l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.source LIKE ? OR l.status LIKE ? OR l.priority LIKE ?)',
    params: [like, like, like, like, like, like, like],
  };
}

function leadFields(values = {}, users = [], customers = []) {
  return [
    { name: 'name', label: 'Lead Name', type: 'text', value: values.name || '', required: true },
    { name: 'email', label: 'Email', type: 'email', value: values.email || '', required: true },
    { name: 'phone', label: 'Phone', type: 'text', value: values.phone || '', required: true },
    { name: 'source', label: 'Source', type: 'text', value: values.source || '', required: true },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      value: values.status || 'New',
      options: ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted', 'Lost'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    {
      name: 'priority',
      label: 'Priority',
      type: 'select',
      value: values.priority || 'Medium',
      options: ['Low', 'Medium', 'High'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    { name: 'expected_value', label: 'Expected Value', type: 'number', value: values.expected_value || '', required: true, min: 0, step: '1' },
    { name: 'expected_close_date', label: 'Expected Close Date', type: 'date', value: values.expected_close_date || '' },
    { name: 'notes', label: 'Notes', type: 'textarea', value: values.notes || '' },
    {
      name: 'customer_id',
      label: 'Linked Customer',
      type: 'select',
      value: values.customer_id ? String(values.customer_id) : '',
      options: [{ value: '', label: 'None' }, ...customers.map((customer) => ({ value: String(customer.id), label: `${customer.customer_code} - ${customer.name}` }))],
    },
    {
      name: 'owner_id',
      label: 'Owner',
      type: 'select',
      value: values.owner_id ? String(values.owner_id) : '',
      options: users.map((user) => ({ value: String(user.id), label: `${user.name} (${user.role})` })),
    },
    {
      name: 'assigned_to_id',
      label: 'Assigned To',
      type: 'select',
      value: values.assigned_to_id ? String(values.assigned_to_id) : '',
      options: [{ value: '', label: 'Unassigned' }, ...users.map((user) => ({ value: String(user.id), label: `${user.name} (${user.role})` }))],
    },
  ];
}

function validateLead(payload) {
  const errors = [];
  if (!String(payload.name || '').trim()) errors.push('Lead name is required.');
  if (!normalizeEmail(payload.email)) errors.push('Email is required.');
  if (!String(payload.phone || '').trim()) errors.push('Phone is required.');
  if (!String(payload.source || '').trim()) errors.push('Source is required.');
  if (!String(payload.status || '').trim()) errors.push('Status is required.');
  if (!String(payload.priority || '').trim()) errors.push('Priority is required.');
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) errors.push('Email must be valid.');
  if (payload.phone && !/^[0-9()+\-\s]{7,20}$/.test(payload.phone)) errors.push('Phone number format is invalid.');
  if (payload.expected_value === '' || payload.expected_value === null || Number.isNaN(Number(payload.expected_value))) errors.push('Expected value must be numeric.');
  if (Number(payload.expected_value) < 0) errors.push('Expected value must be zero or greater.');
  return errors;
}

async function getLeadContext(req) {
  const users = await all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');
  const customers = await all('SELECT id, customer_code, name FROM customers WHERE status != "Inactive" ORDER BY name');
  return { users, customers };
}

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Number(req.query.page || 1);
    const pageSize = 8;

    const scope = accessibleWhereClause(req.user, 'l', { ownerColumn: 'l.owner_id', assignedColumn: 'l.assigned_to_id' });
    const searchClause = buildSearchClause(search);
    const statusClause = status ? ' AND l.status = ?' : '';
    const statusParams = status ? [status] : [];

    const rows = await all(
      `SELECT l.*, c.name AS customer_name, u1.name AS owner_name, u2.name AS assignee_name
       FROM leads l
       LEFT JOIN customers c ON c.id = l.customer_id
       LEFT JOIN users u1 ON u1.id = l.owner_id
       LEFT JOIN users u2 ON u2.id = l.assigned_to_id
       WHERE ${scope.clause}${searchClause.clause}${statusClause}
       ORDER BY l.created_at DESC`,
      [...scope.params, ...searchClause.params, ...statusParams],
    );

    const pager = paginate(rows, page, pageSize);
    res.render('crm/list', {
      title: 'Leads',
      entityLabel: 'Lead',
      basePath: '/leads',
      createLabel: 'New Lead',
      search,
      filters: { status },
      rows: pager.items,
      pagination: pager,
      columns: [
        { label: 'Code', render: (row) => row.lead_code },
        { label: 'Name', render: (row) => row.name },
        { label: 'Source', render: (row) => row.source },
        { label: 'Status', render: (row) => row.status },
        { label: 'Priority', render: (row) => row.priority },
        { label: 'Customer', render: (row) => row.customer_name || 'None' },
        { label: 'Owner', render: (row) => row.owner_name || 'Unassigned' },
      ],
      rowActions: (row) => {
        const buttons = [
          `<a class="btn btn-sm btn-outline-primary" href="/leads/${row.id}/edit">Edit</a>`,
          `<form class="d-inline" method="post" action="/leads/${row.id}?_method=DELETE" onsubmit="return confirm('Delete this lead?');"><button class="btn btn-sm btn-outline-danger" type="submit">Delete</button></form>`,
        ];

        if (row.status === 'Qualified' || row.status === 'Contacted') {
          buttons.push(`<form class="d-inline" method="post" action="/leads/${row.id}/convert" onsubmit="return confirm('Convert this lead into a customer and opportunity?');"><button class="btn btn-sm btn-outline-success" type="submit">Convert</button></form>`);
        }

        return buttons.join(' ');
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const context = await getLeadContext(req);
    res.render('crm/form', {
      title: 'New Lead',
      entityLabel: 'Lead',
      basePath: '/leads',
      action: '/leads',
      method: 'POST',
      values: { status: 'New', priority: 'Medium', owner_id: req.user.id, assigned_to_id: req.user.id },
      fields: leadFields({ status: 'New', priority: 'Medium', owner_id: req.user.id, assigned_to_id: req.user.id }, context.users, context.customers),
      submitLabel: 'Create Lead',
      cancelPath: '/leads',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const payload = {
      name: String(req.body.name || '').trim(),
      email: normalizeEmail(req.body.email),
      phone: String(req.body.phone || '').trim(),
      source: String(req.body.source || '').trim(),
      status: String(req.body.status || 'New').trim(),
      priority: String(req.body.priority || 'Medium').trim(),
      expected_value: Number(req.body.expected_value || 0),
      expected_close_date: String(req.body.expected_close_date || '').trim(),
      notes: String(req.body.notes || '').trim(),
      customer_id: req.body.customer_id ? Number(req.body.customer_id) : null,
      owner_id: req.body.owner_id ? Number(req.body.owner_id) : req.user.id,
      assigned_to_id: req.body.assigned_to_id ? Number(req.body.assigned_to_id) : req.user.id,
    };

    const errors = validateLead(payload);
    const context = await getLeadContext(req);
    if (errors.length > 0) {
      return res.status(400).render('crm/form', {
        title: 'New Lead',
        entityLabel: 'Lead',
        basePath: '/leads',
        action: '/leads',
        method: 'POST',
        values: payload,
        fields: leadFields(payload, context.users, context.customers),
        submitLabel: 'Create Lead',
        cancelPath: '/leads',
        errors,
      });
    }

    const existing = await get('SELECT COUNT(*) AS count FROM leads');
    const leadCode = `LEAD-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO leads (lead_code, customer_id, name, email, phone, source, status, priority, expected_value, expected_close_date, notes, owner_id, assigned_to_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [leadCode, payload.customer_id, payload.name, payload.email, payload.phone, payload.source, payload.status, payload.priority, payload.expected_value, payload.expected_close_date || null, payload.notes, payload.owner_id, payload.assigned_to_id, req.user.id, now, now],
    );

    await logAudit(req, {
      module: 'Lead',
      action: 'Create',
      entityName: 'Lead',
      recordId: result.lastID,
      newValue: payload,
    });

    flash(req, 'success', 'Lead created successfully.');
    return res.redirect('/leads');
  } catch (error) {
    next(error);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const lead = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!lead) {
      flash(req, 'error', 'Lead not found.');
      return res.redirect('/leads');
    }

    if (!canAccessRecord(req.user, lead)) {
      flash(req, 'error', 'You cannot edit that lead.');
      return res.redirect('/leads');
    }

    const context = await getLeadContext(req);
    res.render('crm/form', {
      title: `Edit ${lead.name}`,
      entityLabel: 'Lead',
      basePath: '/leads',
      action: `/leads/${lead.id}?_method=PUT`,
      method: 'POST',
      values: lead,
      fields: leadFields(lead, context.users, context.customers),
      submitLabel: 'Save Changes',
      cancelPath: '/leads',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const lead = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!lead) {
      flash(req, 'error', 'Lead not found.');
      return res.redirect('/leads');
    }

    if (!canAccessRecord(req.user, lead)) {
      flash(req, 'error', 'You cannot edit that lead.');
      return res.redirect('/leads');
    }

    const payload = {
      name: String(req.body.name || '').trim(),
      email: normalizeEmail(req.body.email),
      phone: String(req.body.phone || '').trim(),
      source: String(req.body.source || '').trim(),
      status: String(req.body.status || 'New').trim(),
      priority: String(req.body.priority || 'Medium').trim(),
      expected_value: Number(req.body.expected_value || 0),
      expected_close_date: String(req.body.expected_close_date || '').trim(),
      notes: String(req.body.notes || '').trim(),
      customer_id: req.body.customer_id ? Number(req.body.customer_id) : null,
      owner_id: req.body.owner_id ? Number(req.body.owner_id) : lead.owner_id,
      assigned_to_id: req.body.assigned_to_id ? Number(req.body.assigned_to_id) : lead.assigned_to_id,
    };

    const errors = validateLead(payload);
    const context = await getLeadContext(req);
    if (errors.length > 0) {
      return res.status(400).render('crm/form', {
        title: `Edit ${lead.name}`,
        entityLabel: 'Lead',
        basePath: '/leads',
        action: `/leads/${lead.id}?_method=PUT`,
        method: 'POST',
        values: payload,
        fields: leadFields(payload, context.users, context.customers),
        submitLabel: 'Save Changes',
        cancelPath: '/leads',
        errors,
      });
    }

    const now = new Date().toISOString();
    await run(
      `UPDATE leads SET customer_id = ?, name = ?, email = ?, phone = ?, source = ?, status = ?, priority = ?, expected_value = ?, expected_close_date = ?, notes = ?, owner_id = ?, assigned_to_id = ?, updated_at = ? WHERE id = ?`,
      [payload.customer_id, payload.name, payload.email, payload.phone, payload.source, payload.status, payload.priority, payload.expected_value, payload.expected_close_date || null, payload.notes, payload.owner_id, payload.assigned_to_id, now, lead.id],
    );

    await logAudit(req, {
      module: 'Lead',
      action: 'Update',
      entityName: 'Lead',
      recordId: lead.id,
      oldValue: lead,
      newValue: payload,
    });

    flash(req, 'success', 'Lead updated successfully.');
    return res.redirect('/leads');
  } catch (error) {
    next(error);
  }
});

router.post('/:id/convert', async (req, res, next) => {
  try {
    const lead = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!lead) {
      flash(req, 'error', 'Lead not found.');
      return res.redirect('/leads');
    }

    if (!canAccessRecord(req.user, lead)) {
      flash(req, 'error', 'You cannot convert that lead.');
      return res.redirect('/leads');
    }

    const now = new Date().toISOString();
    let customerId = lead.customer_id;

    if (!customerId) {
      const customerCount = await get('SELECT COUNT(*) AS count FROM customers');
      const customerCode = `CUST-${String(customerCount.count + 1).padStart(4, '0')}`;
      const createdCustomer = await run(
        `INSERT INTO customers (customer_code, name, email, phone, address, status, owner_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [customerCode, lead.name, lead.email, lead.phone, '', 'Active', lead.owner_id || req.user.id, req.user.id, now, now],
      );
      customerId = createdCustomer.lastID;
    }

    const opportunityCount = await get('SELECT COUNT(*) AS count FROM opportunities');
    const opportunityCode = `OPP-${String(opportunityCount.count + 1).padStart(4, '0')}`;
    await run(
      `INSERT INTO opportunities (opportunity_code, customer_id, lead_id, name, amount, probability, stage, expected_close_date, status, source, notes, owner_id, assigned_to_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [opportunityCode, customerId, lead.id, `${lead.name} Opportunity`, Number(lead.expected_value || 0), 50, 'Qualification', lead.expected_close_date || null, 'Open', lead.source, lead.notes || '', lead.owner_id || req.user.id, lead.assigned_to_id || req.user.id, req.user.id, now, now],
    );

    await run('UPDATE leads SET customer_id = ?, status = ?, updated_at = ? WHERE id = ?', [customerId, 'Converted', now, lead.id]);

    await logAudit(req, {
      module: 'Lead',
      action: 'Convert',
      entityName: 'Lead',
      recordId: lead.id,
      oldValue: lead,
      newValue: { customerId, status: 'Converted' },
    });

    flash(req, 'success', 'Lead converted into a customer and opportunity.');
    return res.redirect('/leads');
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const lead = await get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!lead) {
      flash(req, 'error', 'Lead not found.');
      return res.redirect('/leads');
    }

    if (!canAccessRecord(req.user, lead)) {
      flash(req, 'error', 'You cannot delete that lead.');
      return res.redirect('/leads');
    }

    const now = new Date().toISOString();
    await run('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?', ['Lost', now, lead.id]);

    await logAudit(req, {
      module: 'Lead',
      action: 'Delete',
      entityName: 'Lead',
      recordId: lead.id,
      oldValue: lead,
      newValue: { status: 'Lost' },
    });

    flash(req, 'success', 'Lead marked as lost.');
    return res.redirect('/leads');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
