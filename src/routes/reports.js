const express = require('express');
const { all } = require('../db');
const { accessibleWhereClause } = require('../auth');
const { formatMoney } = require('../utils');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const user = req.user;
    const customerScope = accessibleWhereClause(user, 'c', { ownerColumn: 'c.owner_id', assignedColumn: 'c.owner_id' });
    const leadScope = accessibleWhereClause(user, 'l', { ownerColumn: 'l.owner_id', assignedColumn: 'l.assigned_to_id' });
    const opportunityScope = accessibleWhereClause(user, 'o', { ownerColumn: 'o.owner_id', assignedColumn: 'o.assigned_to_id' });
    const followupScope = accessibleWhereClause(user, 'f', { ownerColumn: 'f.created_by', assignedColumn: 'f.assigned_to_id' });
    const activityScope = accessibleWhereClause(user, 'a', { ownerColumn: 'a.created_by', assignedColumn: 'a.assigned_to_id' });
    const auditScope = user.role === 'Admin' ? { clause: '1 = 1', params: [] } : { clause: 'module != "Administration"', params: [] };

    const [customers, leads, opportunities, followups, activities, pipeline, leadStatus, auditLogs, reportRows] = await Promise.all([
      all(`SELECT c.customer_code, c.name, c.status, u.name AS owner_name FROM customers c LEFT JOIN users u ON u.id = c.owner_id WHERE ${customerScope.clause} ORDER BY c.created_at DESC LIMIT 10`, customerScope.params),
      all(`SELECT l.lead_code, l.name, l.status, l.priority, l.expected_value, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE ${leadScope.clause} ORDER BY l.created_at DESC LIMIT 10`, leadScope.params),
      all(`SELECT o.opportunity_code, o.name, o.stage, o.status, o.amount, o.probability, u.name AS owner_name FROM opportunities o LEFT JOIN users u ON u.id = o.owner_id WHERE ${opportunityScope.clause} ORDER BY o.created_at DESC LIMIT 10`, opportunityScope.params),
      all(`SELECT f.followup_code, f.subject, f.status, f.follow_up_date, u.name AS assignee_name FROM followups f LEFT JOIN users u ON u.id = f.assigned_to_id WHERE ${followupScope.clause} ORDER BY f.follow_up_date ASC LIMIT 10`, followupScope.params),
      all(`SELECT a.activity_code, a.subject, a.status, a.activity_date, u.name AS assignee_name FROM activities a LEFT JOIN users u ON u.id = a.assigned_to_id WHERE ${activityScope.clause} ORDER BY a.activity_date DESC LIMIT 10`, activityScope.params),
      all(`SELECT stage, SUM(amount) AS totalAmount FROM opportunities o WHERE ${opportunityScope.clause} GROUP BY stage ORDER BY totalAmount DESC`, opportunityScope.params),
      all(`SELECT status, COUNT(*) AS totalCount FROM leads l WHERE ${leadScope.clause} GROUP BY status ORDER BY totalCount DESC`, leadScope.params),
      all(`SELECT * FROM audit_logs WHERE ${auditScope.clause} ORDER BY created_at DESC LIMIT 15`, auditScope.params),
      all(`SELECT 'Customers' AS label, COUNT(*) AS total FROM customers c WHERE ${customerScope.clause}
           UNION ALL SELECT 'Leads', COUNT(*) FROM leads l WHERE ${leadScope.clause}
           UNION ALL SELECT 'Opportunities', COUNT(*) FROM opportunities o WHERE ${opportunityScope.clause}
           UNION ALL SELECT 'Follow-Ups', COUNT(*) FROM followups f WHERE ${followupScope.clause}
           UNION ALL SELECT 'Activities', COUNT(*) FROM activities a WHERE ${activityScope.clause}`,
        []),
    ]);

    res.render('reports', {
      title: 'Reports',
      formatMoney,
      customers,
      leads,
      opportunities,
      followups,
      activities,
      pipeline,
      leadStatus,
      auditLogs,
      reportRows,
      showAudit: user.role === 'Admin' || user.role === 'Manager',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
