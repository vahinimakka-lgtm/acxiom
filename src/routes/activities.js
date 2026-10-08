const express = require('express');
const { get, all, run } = require('../db');
const { flash } = require('../flash');
const { logAudit } = require('../audit');
const { accessibleWhereClause, canAccessRecord } = require('../auth');
const { paginate, todayISO } = require('../utils');

const router = express.Router();

function buildSearchClause(query) {
  if (!query) {
    return { clause: '', params: [] };
  }

  const like = `%${query}%`;
  return {
    clause: ' AND (a.activity_code LIKE ? OR a.subject LIKE ? OR a.activity_type LIKE ? OR a.status LIKE ?)',
    params: [like, like, like, like],
  };
}

function activityFields(values = {}, users = [], customers = [], leads = [], opportunities = []) {
  return [
    {
      name: 'activity_type',
      label: 'Activity Type',
      type: 'select',
      value: values.activity_type || 'Call',
      options: ['Call', 'Meeting', 'Email', 'Task'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    { name: 'subject', label: 'Subject', type: 'text', value: values.subject || '', required: true },
    { name: 'description', label: 'Description', type: 'textarea', value: values.description || '' },
    { name: 'activity_date', label: 'Activity Date', type: 'date', value: values.activity_date || '', required: true },
    {
      name: 'customer_id',
      label: 'Customer',
      type: 'select',
      value: values.customer_id ? String(values.customer_id) : '',
      options: [{ value: '', label: 'None' }, ...customers.map((customer) => ({ value: String(customer.id), label: `${customer.customer_code} - ${customer.name}` }))],
    },
    {
      name: 'lead_id',
      label: 'Lead',
      type: 'select',
      value: values.lead_id ? String(values.lead_id) : '',
      options: [{ value: '', label: 'None' }, ...leads.map((lead) => ({ value: String(lead.id), label: `${lead.lead_code} - ${lead.name}` }))],
    },
    {
      name: 'opportunity_id',
      label: 'Opportunity',
      type: 'select',
      value: values.opportunity_id ? String(values.opportunity_id) : '',
      options: [{ value: '', label: 'None' }, ...opportunities.map((opportunity) => ({ value: String(opportunity.id), label: `${opportunity.opportunity_code} - ${opportunity.name}` }))],
    },
    {
      name: 'assigned_to_id',
      label: 'Assigned To',
      type: 'select',
      value: values.assigned_to_id ? String(values.assigned_to_id) : '',
      options: [{ value: '', label: 'Unassigned' }, ...users.map((user) => ({ value: String(user.id), label: `${user.name} (${user.role})` }))],
    },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      value: values.status || 'Open',
      options: ['Open', 'Completed', 'Cancelled'].map((option) => ({ value: option, label: option })),
      required: true,
    },
  ];
}

function validateActivity(payload) {
  const errors = [];
  if (!String(payload.activity_type || '').trim()) errors.push('Activity type is required.');
  if (!String(payload.subject || '').trim()) errors.push('Subject is required.');
  if (!String(payload.activity_date || '').trim()) errors.push('Activity date is required.');
  return errors;
}

async function activityContext() {
  const users = await all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');
  const customers = await all('SELECT id, customer_code, name FROM customers WHERE status != "Inactive" ORDER BY name');
  const leads = await all('SELECT id, lead_code, name FROM leads ORDER BY name');
  const opportunities = await all('SELECT id, opportunity_code, name FROM opportunities ORDER BY name');
  return { users, customers, leads, opportunities };
}

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Number(req.query.page || 1);
    const pageSize = 8;

    const scope = accessibleWhereClause(req.user, 'a', { ownerColumn: 'a.created_by', assignedColumn: 'a.assigned_to_id' });
    const searchClause = buildSearchClause(search);
    const statusClause = status ? ' AND a.status = ?' : '';
    const params = [...scope.params, ...searchClause.params, ...(status ? [status] : [])];

    const rows = await all(
      `SELECT a.*, c.name AS customer_name, l.name AS lead_name, o.name AS opportunity_name, u.name AS assignee_name
       FROM activities a
       LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN opportunities o ON o.id = a.opportunity_id
       LEFT JOIN users u ON u.id = a.assigned_to_id
       WHERE ${scope.clause}${searchClause.clause}${statusClause}
       ORDER BY a.activity_date DESC, a.created_at DESC`,
      params,
    );

    const pager = paginate(rows, page, pageSize);
    res.render('crm/list', {
      title: 'Activities',
      entityLabel: 'Activity',
      basePath: '/activities',
      createLabel: 'New Activity',
      search,
      filters: { status },
      rows: pager.items,
      pagination: pager,
      columns: [
        { label: 'Code', render: (row) => row.activity_code },
        { label: 'Type', render: (row) => row.activity_type },
        { label: 'Subject', render: (row) => row.subject },
        { label: 'Date', render: (row) => row.activity_date },
        { label: 'Status', render: (row) => row.status },
        { label: 'Customer', render: (row) => row.customer_name || 'None' },
        { label: 'Lead', render: (row) => row.lead_name || 'None' },
        { label: 'Opportunity', render: (row) => row.opportunity_name || 'None' },
      ],
      rowActions: (row) => [
        `<a class="btn btn-sm btn-outline-primary" href="/activities/${row.id}/edit">Edit</a>`,
        `<form class="d-inline" method="post" action="/activities/${row.id}?_method=DELETE" onsubmit="return confirm('Delete this activity?');"><button class="btn btn-sm btn-outline-danger" type="submit">Delete</button></form>`,
      ].join(' '),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const context = await activityContext();
    const values = { activity_type: 'Call', status: 'Open', activity_date: todayISO(), assigned_to_id: req.user.id };
    res.render('crm/form', {
      title: 'New Activity',
      entityLabel: 'Activity',
      basePath: '/activities',
      action: '/activities',
      method: 'POST',
      values,
      fields: activityFields(values, context.users, context.customers, context.leads, context.opportunities),
      submitLabel: 'Create Activity',
      cancelPath: '/activities',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const payload = {
      activity_type: String(req.body.activity_type || '').trim(),
      subject: String(req.body.subject || '').trim(),
      description: String(req.body.description || '').trim(),
      activity_date: String(req.body.activity_date || '').trim(),
      customer_id: req.body.customer_id ? Number(req.body.customer_id) : null,
      lead_id: req.body.lead_id ? Number(req.body.lead_id) : null,
      opportunity_id: req.body.opportunity_id ? Number(req.body.opportunity_id) : null,
      assigned_to_id: req.body.assigned_to_id ? Number(req.body.assigned_to_id) : req.user.id,
      status: String(req.body.status || 'Open').trim(),
    };

    const errors = validateActivity(payload);
    const context = await activityContext();
    if (errors.length > 0) {
      return res.status(400).render('crm/form', {
        title: 'New Activity',
        entityLabel: 'Activity',
        basePath: '/activities',
        action: '/activities',
        method: 'POST',
        values: payload,
        fields: activityFields(payload, context.users, context.customers, context.leads, context.opportunities),
        submitLabel: 'Create Activity',
        cancelPath: '/activities',
        errors,
      });
    }

    const existing = await get('SELECT COUNT(*) AS count FROM activities');
    const activityCode = `ACT-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO activities (activity_code, activity_type, subject, description, activity_date, customer_id, lead_id, opportunity_id, assigned_to_id, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [activityCode, payload.activity_type, payload.subject, payload.description, payload.activity_date, payload.customer_id, payload.lead_id, payload.opportunity_id, payload.assigned_to_id, payload.status, req.user.id, now, now],
    );

    await logAudit(req, {
      module: 'Activity',
      action: 'Create',
      entityName: 'Activity',
      recordId: result.lastID,
      newValue: payload,
    });

    flash(req, 'success', 'Activity created successfully.');
    return res.redirect('/activities');
  } catch (error) {
    next(error);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const activity = await get('SELECT * FROM activities WHERE id = ?', [req.params.id]);
    if (!activity) {
      flash(req, 'error', 'Activity not found.');
      return res.redirect('/activities');
    }

    if (!canAccessRecord(req.user, activity)) {
      flash(req, 'error', 'You cannot edit that activity.');
      return res.redirect('/activities');
    }

    const context = await activityContext();
    res.render('crm/form', {
      title: `Edit ${activity.subject}`,
      entityLabel: 'Activity',
      basePath: '/activities',
      action: `/activities/${activity.id}?_method=PUT`,
      method: 'POST',
      values: activity,
      fields: activityFields(activity, context.users, context.customers, context.leads, context.opportunities),
      submitLabel: 'Save Changes',
      cancelPath: '/activities',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const activity = await get('SELECT * FROM activities WHERE id = ?', [req.params.id]);
    if (!activity) {
      flash(req, 'error', 'Activity not found.');
      return res.redirect('/activities');
    }

    if (!canAccessRecord(req.user, activity)) {
      flash(req, 'error', 'You cannot edit that activity.');
      return res.redirect('/activities');
    }

    const payload = {
      activity_type: String(req.body.activity_type || '').trim(),
      subject: String(req.body.subject || '').trim(),
      description: String(req.body.description || '').trim(),
      activity_date: String(req.body.activity_date || '').trim(),
      customer_id: req.body.customer_id ? Number(req.body.customer_id) : null,
      lead_id: req.body.lead_id ? Number(req.body.lead_id) : null,
      opportunity_id: req.body.opportunity_id ? Number(req.body.opportunity_id) : null,
      assigned_to_id: req.body.assigned_to_id ? Number(req.body.assigned_to_id) : activity.assigned_to_id,
      status: String(req.body.status || 'Open').trim(),
    };

    const errors = validateActivity(payload);
    const context = await activityContext();
    if (errors.length > 0) {
      return res.status(400).render('crm/form', {
        title: `Edit ${activity.subject}`,
        entityLabel: 'Activity',
        basePath: '/activities',
        action: `/activities/${activity.id}?_method=PUT`,
        method: 'POST',
        values: payload,
        fields: activityFields(payload, context.users, context.customers, context.leads, context.opportunities),
        submitLabel: 'Save Changes',
        cancelPath: '/activities',
        errors,
      });
    }

    const now = new Date().toISOString();
    await run(
      `UPDATE activities SET activity_type = ?, subject = ?, description = ?, activity_date = ?, customer_id = ?, lead_id = ?, opportunity_id = ?, assigned_to_id = ?, status = ?, updated_at = ? WHERE id = ?`,
      [payload.activity_type, payload.subject, payload.description, payload.activity_date, payload.customer_id, payload.lead_id, payload.opportunity_id, payload.assigned_to_id, payload.status, now, activity.id],
    );

    await logAudit(req, {
      module: 'Activity',
      action: 'Update',
      entityName: 'Activity',
      recordId: activity.id,
      oldValue: activity,
      newValue: payload,
    });

    flash(req, 'success', 'Activity updated successfully.');
    return res.redirect('/activities');
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const activity = await get('SELECT * FROM activities WHERE id = ?', [req.params.id]);
    if (!activity) {
      flash(req, 'error', 'Activity not found.');
      return res.redirect('/activities');
    }

    if (!canAccessRecord(req.user, activity)) {
      flash(req, 'error', 'You cannot delete that activity.');
      return res.redirect('/activities');
    }

    await run('UPDATE activities SET status = ?, updated_at = ? WHERE id = ?', ['Cancelled', new Date().toISOString(), activity.id]);

    await logAudit(req, {
      module: 'Activity',
      action: 'Delete',
      entityName: 'Activity',
      recordId: activity.id,
      oldValue: activity,
      newValue: { status: 'Cancelled' },
    });

    flash(req, 'success', 'Activity cancelled.');
    return res.redirect('/activities');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
