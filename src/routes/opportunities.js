const express = require('express');
const { get, all, run } = require('../db');
const { flash } = require('../flash');
const { logAudit } = require('../audit');
const { accessibleWhereClause, canAccessRecord } = require('../auth');
const { normalizeEmail, paginate, todayISO, formatMoney } = require('../utils');

const router = express.Router();

function buildSearchClause(query) {
  if (!query) {
    return { clause: '', params: [] };
  }

  const like = `%${query}%`;
  return {
    clause: ' AND (o.opportunity_code LIKE ? OR o.name LIKE ? OR o.source LIKE ? OR o.stage LIKE ? OR o.status LIKE ?)',
    params: [like, like, like, like, like],
  };
}

function opportunityFields(values = {}, users = [], customers = [], leads = []) {
  return [
    { name: 'name', label: 'Opportunity Name', type: 'text', value: values.name || '', required: true },
    {
      name: 'customer_id',
      label: 'Customer',
      type: 'select',
      value: values.customer_id ? String(values.customer_id) : '',
      options: [{ value: '', label: 'Choose a customer' }, ...customers.map((customer) => ({ value: String(customer.id), label: `${customer.customer_code} - ${customer.name}` }))],
      required: true,
    },
    {
      name: 'lead_id',
      label: 'Lead',
      type: 'select',
      value: values.lead_id ? String(values.lead_id) : '',
      options: [{ value: '', label: 'None' }, ...leads.map((lead) => ({ value: String(lead.id), label: `${lead.lead_code} - ${lead.name}` }))],
    },
    { name: 'amount', label: 'Amount', type: 'number', value: values.amount || '', required: true, min: 0, step: '1' },
    { name: 'probability', label: 'Probability', type: 'number', value: values.probability || '', required: true, min: 0, max: 100, step: '1' },
    {
      name: 'stage',
      label: 'Stage',
      type: 'select',
      value: values.stage || 'Qualification',
      options: ['Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    { name: 'expected_close_date', label: 'Expected Close Date', type: 'date', value: values.expected_close_date || '' },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      value: values.status || 'Open',
      options: ['Open', 'Won', 'Lost'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    { name: 'source', label: 'Source', type: 'text', value: values.source || '' },
    { name: 'notes', label: 'Notes', type: 'textarea', value: values.notes || '' },
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

function validateOpportunity(payload) {
  const errors = [];
  if (!String(payload.name || '').trim()) errors.push('Opportunity name is required.');
  if (!payload.customer_id) errors.push('Customer is required.');
  if (Number.isNaN(Number(payload.amount)) || Number(payload.amount) <= 0) errors.push('Amount must be greater than zero.');
  if (Number.isNaN(Number(payload.probability)) || Number(payload.probability) < 0 || Number(payload.probability) > 100) errors.push('Probability must be between 0 and 100.');
  if (!String(payload.stage || '').trim()) errors.push('Stage is required.');
  if (!String(payload.status || '').trim()) errors.push('Status is required.');
  if (payload.expected_close_date && payload.status === 'Open' && payload.expected_close_date < todayISO()) errors.push('Expected close date cannot be in the past for an open opportunity.');
  return errors;
}

async function opportunityContext() {
  const users = await all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');
  const customers = await all('SELECT id, customer_code, name FROM customers WHERE status != "Inactive" ORDER BY name');
  const leads = await all('SELECT id, lead_code, name FROM leads ORDER BY name');
  return { users, customers, leads };
}

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const stage = String(req.query.stage || '').trim();
    const page = Number(req.query.page || 1);
    const pageSize = 8;

    const scope = accessibleWhereClause(req.user, 'o', { ownerColumn: 'o.owner_id', assignedColumn: 'o.assigned_to_id' });
    const searchClause = buildSearchClause(search);
    const statusClause = status ? ' AND o.status = ?' : '';
    const stageClause = stage ? ' AND o.stage = ?' : '';
    const params = [...scope.params, ...searchClause.params, ...(status ? [status] : []), ...(stage ? [stage] : [])];

    const rows = await all(
      `SELECT o.*, c.name AS customer_name, u1.name AS owner_name, u2.name AS assignee_name
       FROM opportunities o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users u1 ON u1.id = o.owner_id
       LEFT JOIN users u2 ON u2.id = o.assigned_to_id
       WHERE ${scope.clause}${searchClause.clause}${statusClause}${stageClause}
       ORDER BY o.created_at DESC`,
      params,
    );

    const pager = paginate(rows, page, pageSize);
    res.render('crm/list', {
      title: 'Opportunities',
      entityLabel: 'Opportunity',
      basePath: '/opportunities',
      createLabel: 'New Opportunity',
      search,
      filters: { status, stage },
      rows: pager.items,
      pagination: pager,
      columns: [
        { label: 'Code', render: (row) => row.opportunity_code },
        { label: 'Name', render: (row) => row.name },
        { label: 'Customer', render: (row) => row.customer_name || 'None' },
        { label: 'Stage', render: (row) => row.stage },
        { label: 'Status', render: (row) => row.status },
        { label: 'Amount', render: (row) => formatMoney(row.amount) },
        { label: 'Probability', render: (row) => `${row.probability}%` },
        { label: 'Owner', render: (row) => row.owner_name || 'Unassigned' },
      ],
      rowActions: (row) => [
        `<a class="btn btn-sm btn-outline-primary" href="/opportunities/${row.id}/edit">Edit</a>`,
        `<form class="d-inline" method="post" action="/opportunities/${row.id}?_method=DELETE" onsubmit="return confirm('Delete this opportunity?');"><button class="btn btn-sm btn-outline-danger" type="submit">Delete</button></form>`,
      ].join(' '),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const context = await opportunityContext();
    const values = { status: 'Open', stage: 'Qualification', probability: 50, owner_id: req.user.id, assigned_to_id: req.user.id };
    res.render('crm/form', {
      title: 'New Opportunity',
      entityLabel: 'Opportunity',
      basePath: '/opportunities',
      action: '/opportunities',
      method: 'POST',
      values,
      fields: opportunityFields(values, context.users, context.customers, context.leads),
      submitLabel: 'Create Opportunity',
      cancelPath: '/opportunities',
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
      customer_id: req.body.customer_id ? Number(req.body.customer_id) : null,
      lead_id: req.body.lead_id ? Number(req.body.lead_id) : null,
      amount: Number(req.body.amount || 0),
      probability: Number(req.body.probability || 0),
      stage: String(req.body.stage || 'Qualification').trim(),
      expected_close_date: String(req.body.expected_close_date || '').trim(),
      status: String(req.body.status || 'Open').trim(),
      source: String(req.body.source || '').trim(),
      notes: String(req.body.notes || '').trim(),
      owner_id: req.body.owner_id ? Number(req.body.owner_id) : req.user.id,
      assigned_to_id: req.body.assigned_to_id ? Number(req.body.assigned_to_id) : req.user.id,
    };

    const errors = validateOpportunity(payload);
    const context = await opportunityContext();
    if (errors.length > 0) {
      return res.status(400).render('crm/form', {
        title: 'New Opportunity',
        entityLabel: 'Opportunity',
        basePath: '/opportunities',
        action: '/opportunities',
        method: 'POST',
        values: payload,
        fields: opportunityFields(payload, context.users, context.customers, context.leads),
        submitLabel: 'Create Opportunity',
        cancelPath: '/opportunities',
        errors,
      });
    }

    const existing = await get('SELECT COUNT(*) AS count FROM opportunities');
    const opportunityCode = `OPP-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO opportunities (opportunity_code, customer_id, lead_id, name, amount, probability, stage, expected_close_date, status, source, notes, owner_id, assigned_to_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [opportunityCode, payload.customer_id, payload.lead_id, payload.name, payload.amount, payload.probability, payload.stage, payload.expected_close_date || null, payload.status, payload.source, payload.notes, payload.owner_id, payload.assigned_to_id, req.user.id, now, now],
    );

    await logAudit(req, {
      module: 'Opportunity',
      action: 'Create',
      entityName: 'Opportunity',
      recordId: result.lastID,
      newValue: payload,
    });

    flash(req, 'success', 'Opportunity created successfully.');
    return res.redirect('/opportunities');
  } catch (error) {
    next(error);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const opportunity = await get('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!opportunity) {
      flash(req, 'error', 'Opportunity not found.');
      return res.redirect('/opportunities');
    }

    if (!canAccessRecord(req.user, opportunity)) {
      flash(req, 'error', 'You cannot edit that opportunity.');
      return res.redirect('/opportunities');
    }

    const context = await opportunityContext();
    res.render('crm/form', {
      title: `Edit ${opportunity.name}`,
      entityLabel: 'Opportunity',
      basePath: '/opportunities',
      action: `/opportunities/${opportunity.id}?_method=PUT`,
      method: 'POST',
      values: opportunity,
      fields: opportunityFields(opportunity, context.users, context.customers, context.leads),
      submitLabel: 'Save Changes',
      cancelPath: '/opportunities',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const opportunity = await get('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!opportunity) {
      flash(req, 'error', 'Opportunity not found.');
      return res.redirect('/opportunities');
    }

    if (!canAccessRecord(req.user, opportunity)) {
      flash(req, 'error', 'You cannot edit that opportunity.');
      return res.redirect('/opportunities');
    }

    const payload = {
      name: String(req.body.name || '').trim(),
      customer_id: req.body.customer_id ? Number(req.body.customer_id) : null,
      lead_id: req.body.lead_id ? Number(req.body.lead_id) : null,
      amount: Number(req.body.amount || 0),
      probability: Number(req.body.probability || 0),
      stage: String(req.body.stage || 'Qualification').trim(),
      expected_close_date: String(req.body.expected_close_date || '').trim(),
      status: String(req.body.status || 'Open').trim(),
      source: String(req.body.source || '').trim(),
      notes: String(req.body.notes || '').trim(),
      owner_id: req.body.owner_id ? Number(req.body.owner_id) : opportunity.owner_id,
      assigned_to_id: req.body.assigned_to_id ? Number(req.body.assigned_to_id) : opportunity.assigned_to_id,
    };

    const errors = validateOpportunity(payload);
    const context = await opportunityContext();
    if (errors.length > 0) {
      return res.status(400).render('crm/form', {
        title: `Edit ${opportunity.name}`,
        entityLabel: 'Opportunity',
        basePath: '/opportunities',
        action: `/opportunities/${opportunity.id}?_method=PUT`,
        method: 'POST',
        values: payload,
        fields: opportunityFields(payload, context.users, context.customers, context.leads),
        submitLabel: 'Save Changes',
        cancelPath: '/opportunities',
        errors,
      });
    }

    const now = new Date().toISOString();
    await run(
      `UPDATE opportunities SET customer_id = ?, lead_id = ?, name = ?, amount = ?, probability = ?, stage = ?, expected_close_date = ?, status = ?, source = ?, notes = ?, owner_id = ?, assigned_to_id = ?, updated_at = ? WHERE id = ?`,
      [payload.customer_id, payload.lead_id, payload.name, payload.amount, payload.probability, payload.stage, payload.expected_close_date || null, payload.status, payload.source, payload.notes, payload.owner_id, payload.assigned_to_id, now, opportunity.id],
    );

    await logAudit(req, {
      module: 'Opportunity',
      action: 'Update',
      entityName: 'Opportunity',
      recordId: opportunity.id,
      oldValue: opportunity,
      newValue: payload,
    });

    flash(req, 'success', 'Opportunity updated successfully.');
    return res.redirect('/opportunities');
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const opportunity = await get('SELECT * FROM opportunities WHERE id = ?', [req.params.id]);
    if (!opportunity) {
      flash(req, 'error', 'Opportunity not found.');
      return res.redirect('/opportunities');
    }

    if (!canAccessRecord(req.user, opportunity)) {
      flash(req, 'error', 'You cannot delete that opportunity.');
      return res.redirect('/opportunities');
    }

    const now = new Date().toISOString();
    await run('UPDATE opportunities SET status = ?, updated_at = ? WHERE id = ?', ['Lost', now, opportunity.id]);

    await logAudit(req, {
      module: 'Opportunity',
      action: 'Delete',
      entityName: 'Opportunity',
      recordId: opportunity.id,
      oldValue: opportunity,
      newValue: { status: 'Lost' },
    });

    flash(req, 'success', 'Opportunity marked as lost.');
    return res.redirect('/opportunities');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
