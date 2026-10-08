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
    clause: ' AND (f.followup_code LIKE ? OR f.subject LIKE ? OR f.type LIKE ? OR f.status LIKE ? OR f.related_type LIKE ?)',
    params: [like, like, like, like, like],
  };
}

function followupFields(values = {}, users = []) {
  return [
    {
      name: 'related_type',
      label: 'Related Type',
      type: 'select',
      value: values.related_type || 'Lead',
      options: ['Customer', 'Lead', 'Opportunity'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    { name: 'related_id', label: 'Related Record ID', type: 'number', value: values.related_id || '', required: true, min: 1, step: '1' },
    { name: 'subject', label: 'Subject', type: 'text', value: values.subject || '', required: true },
    { name: 'follow_up_date', label: 'Follow-Up Date', type: 'date', value: values.follow_up_date || '', required: true },
    {
      name: 'type',
      label: 'Type',
      type: 'select',
      value: values.type || 'Call',
      options: ['Call', 'Meeting', 'Email', 'Task'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      value: values.status || 'Planned',
      options: ['Planned', 'Completed', 'Missed', 'Cancelled'].map((option) => ({ value: option, label: option })),
      required: true,
    },
    { name: 'notes', label: 'Notes', type: 'textarea', value: values.notes || '' },
    {
      name: 'assigned_to_id',
      label: 'Assigned To',
      type: 'select',
      value: values.assigned_to_id ? String(values.assigned_to_id) : '',
      options: [{ value: '', label: 'Unassigned' }, ...users.map((user) => ({ value: String(user.id), label: `${user.name} (${user.role})` }))],
    },
  ];
}

function validateFollowup(payload) {
  const errors = [];
  if (!String(payload.related_type || '').trim()) errors.push('Related type is required.');
  if (!payload.related_id) errors.push('Related record ID is required.');
  if (!String(payload.subject || '').trim()) errors.push('Subject is required.');
  if (!String(payload.follow_up_date || '').trim()) errors.push('Follow-up date is required.');
  if (payload.follow_up_date && payload.status === 'Planned' && payload.follow_up_date < todayISO()) errors.push('Follow-up date cannot be earlier than today for a planned follow-up.');
  return errors;
}

async function followupUsers() {
  return all('SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name');
}

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Number(req.query.page || 1);
    const pageSize = 8;

    const scope = accessibleWhereClause(req.user, 'f', { ownerColumn: 'f.created_by', assignedColumn: 'f.assigned_to_id' });
    const searchClause = buildSearchClause(search);
    const statusClause = status ? ' AND f.status = ?' : '';
    const params = [...scope.params, ...searchClause.params, ...(status ? [status] : [])];

    const rows = await all(
      `SELECT f.*, u.name AS assignee_name
       FROM followups f
       LEFT JOIN users u ON u.id = f.assigned_to_id
       WHERE ${scope.clause}${searchClause.clause}${statusClause}
       ORDER BY f.follow_up_date ASC, f.created_at DESC`,
      params,
    );

    const pager = paginate(rows, page, pageSize);
    res.render('crm/list', {
      title: 'Follow-Ups',
      entityLabel: 'Follow-Up',
      basePath: '/followups',
      createLabel: 'New Follow-Up',
      search,
      filters: { status },
      rows: pager.items,
      pagination: pager,
      columns: [
        { label: 'Code', render: (row) => row.followup_code },
        { label: 'Subject', render: (row) => row.subject },
        { label: 'Related', render: (row) => `${row.related_type} #${row.related_id || '-'}` },
        { label: 'Date', render: (row) => row.follow_up_date },
        { label: 'Type', render: (row) => row.type },
        { label: 'Status', render: (row) => row.status },
        { label: 'Assigned To', render: (row) => row.assignee_name || 'Unassigned' },
      ],
      rowActions: (row) => [
        `<a class="btn btn-sm btn-outline-primary" href="/followups/${row.id}/edit">Edit</a>`,
        `<form class="d-inline" method="post" action="/followups/${row.id}?_method=DELETE" onsubmit="return confirm('Delete this follow-up?');"><button class="btn btn-sm btn-outline-danger" type="submit">Delete</button></form>`,
      ].join(' '),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const users = await followupUsers();
    const values = { related_type: 'Lead', type: 'Call', status: 'Planned', assigned_to_id: req.user.id, follow_up_date: todayISO() };
    res.render('crm/form', {
      title: 'New Follow-Up',
      entityLabel: 'Follow-Up',
      basePath: '/followups',
      action: '/followups',
      method: 'POST',
      values,
      fields: followupFields(values, users),
      submitLabel: 'Create Follow-Up',
      cancelPath: '/followups',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const payload = {
      related_type: String(req.body.related_type || '').trim(),
      related_id: req.body.related_id ? Number(req.body.related_id) : null,
      subject: String(req.body.subject || '').trim(),
      follow_up_date: String(req.body.follow_up_date || '').trim(),
      type: String(req.body.type || 'Call').trim(),
      status: String(req.body.status || 'Planned').trim(),
      notes: String(req.body.notes || '').trim(),
      assigned_to_id: req.body.assigned_to_id ? Number(req.body.assigned_to_id) : req.user.id,
    };

    const errors = validateFollowup(payload);
    const users = await followupUsers();
    if (errors.length > 0) {
      return res.status(400).render('crm/form', {
        title: 'New Follow-Up',
        entityLabel: 'Follow-Up',
        basePath: '/followups',
        action: '/followups',
        method: 'POST',
        values: payload,
        fields: followupFields(payload, users),
        submitLabel: 'Create Follow-Up',
        cancelPath: '/followups',
        errors,
      });
    }

    const existing = await get('SELECT COUNT(*) AS count FROM followups');
    const followupCode = `FUP-${String(existing.count + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO followups (followup_code, related_type, related_id, subject, follow_up_date, type, status, notes, assigned_to_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [followupCode, payload.related_type, payload.related_id, payload.subject, payload.follow_up_date, payload.type, payload.status, payload.notes, payload.assigned_to_id, req.user.id, now, now],
    );

    await logAudit(req, {
      module: 'FollowUp',
      action: 'Create',
      entityName: 'FollowUp',
      recordId: result.lastID,
      newValue: payload,
    });

    flash(req, 'success', 'Follow-up created successfully.');
    return res.redirect('/followups');
  } catch (error) {
    next(error);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const followup = await get('SELECT * FROM followups WHERE id = ?', [req.params.id]);
    if (!followup) {
      flash(req, 'error', 'Follow-up not found.');
      return res.redirect('/followups');
    }

    if (!canAccessRecord(req.user, followup)) {
      flash(req, 'error', 'You cannot edit that follow-up.');
      return res.redirect('/followups');
    }

    const users = await followupUsers();
    res.render('crm/form', {
      title: `Edit ${followup.subject}`,
      entityLabel: 'Follow-Up',
      basePath: '/followups',
      action: `/followups/${followup.id}?_method=PUT`,
      method: 'POST',
      values: followup,
      fields: followupFields(followup, users),
      submitLabel: 'Save Changes',
      cancelPath: '/followups',
      errors: [],
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const followup = await get('SELECT * FROM followups WHERE id = ?', [req.params.id]);
    if (!followup) {
      flash(req, 'error', 'Follow-up not found.');
      return res.redirect('/followups');
    }

    if (!canAccessRecord(req.user, followup)) {
      flash(req, 'error', 'You cannot edit that follow-up.');
      return res.redirect('/followups');
    }

    const payload = {
      related_type: String(req.body.related_type || '').trim(),
      related_id: req.body.related_id ? Number(req.body.related_id) : null,
      subject: String(req.body.subject || '').trim(),
      follow_up_date: String(req.body.follow_up_date || '').trim(),
      type: String(req.body.type || 'Call').trim(),
      status: String(req.body.status || 'Planned').trim(),
      notes: String(req.body.notes || '').trim(),
      assigned_to_id: req.body.assigned_to_id ? Number(req.body.assigned_to_id) : followup.assigned_to_id,
    };

    const errors = validateFollowup(payload);
    const users = await followupUsers();
    if (errors.length > 0) {
      return res.status(400).render('crm/form', {
        title: `Edit ${followup.subject}`,
        entityLabel: 'Follow-Up',
        basePath: '/followups',
        action: `/followups/${followup.id}?_method=PUT`,
        method: 'POST',
        values: payload,
        fields: followupFields(payload, users),
        submitLabel: 'Save Changes',
        cancelPath: '/followups',
        errors,
      });
    }

    const now = new Date().toISOString();
    await run(
      `UPDATE followups SET related_type = ?, related_id = ?, subject = ?, follow_up_date = ?, type = ?, status = ?, notes = ?, assigned_to_id = ?, updated_at = ? WHERE id = ?`,
      [payload.related_type, payload.related_id, payload.subject, payload.follow_up_date, payload.type, payload.status, payload.notes, payload.assigned_to_id, now, followup.id],
    );

    await logAudit(req, {
      module: 'FollowUp',
      action: 'Update',
      entityName: 'FollowUp',
      recordId: followup.id,
      oldValue: followup,
      newValue: payload,
    });

    flash(req, 'success', 'Follow-up updated successfully.');
    return res.redirect('/followups');
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const followup = await get('SELECT * FROM followups WHERE id = ?', [req.params.id]);
    if (!followup) {
      flash(req, 'error', 'Follow-up not found.');
      return res.redirect('/followups');
    }

    if (!canAccessRecord(req.user, followup)) {
      flash(req, 'error', 'You cannot delete that follow-up.');
      return res.redirect('/followups');
    }

    await run('UPDATE followups SET status = ?, updated_at = ? WHERE id = ?', ['Cancelled', new Date().toISOString(), followup.id]);

    await logAudit(req, {
      module: 'FollowUp',
      action: 'Delete',
      entityName: 'FollowUp',
      recordId: followup.id,
      oldValue: followup,
      newValue: { status: 'Cancelled' },
    });

    flash(req, 'success', 'Follow-up cancelled.');
    return res.redirect('/followups');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
