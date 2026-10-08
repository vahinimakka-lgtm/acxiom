const express = require('express');
const { all } = require('../db');
const { accessibleWhereClause } = require('../auth');
const { formatMoney } = require('../utils');

const router = express.Router();

async function countFor(table, alias, user, extra = '') {
  const scope = accessibleWhereClause(user, alias, extra.columns || {});
  const where = `${scope.clause}${extra.clause || ''}`;
  const params = [...scope.params, ...(extra.params || [])];
  const rows = await all(`SELECT COUNT(*) AS count FROM ${table} ${alias ? `AS ${alias}` : ''} WHERE ${where}`, params);
  return rows[0].count;
}

router.get('/', async (req, res, next) => {
  try {
    const user = req.user;
    const customerScope = accessibleWhereClause(user, 'c', { ownerColumn: 'c.owner_id', assignedColumn: 'c.owner_id' });
    const leadScope = accessibleWhereClause(user, 'l', { ownerColumn: 'l.owner_id', assignedColumn: 'l.assigned_to_id' });
    const opportunityScope = accessibleWhereClause(user, 'o', { ownerColumn: 'o.owner_id', assignedColumn: 'o.assigned_to_id' });
    const followupScope = accessibleWhereClause(user, 'f', { ownerColumn: 'f.created_by', assignedColumn: 'f.assigned_to_id' });
    const activityScope = accessibleWhereClause(user, 'a', { ownerColumn: 'a.created_by', assignedColumn: 'a.assigned_to_id' });

    const [customerCount, leadCount, openLeadCount, opportunityCount, openOpportunityCount, followupCount, pendingFollowupCount, activityCount, totalPipelineRows, upcomingFollowups, recentActivities] = await Promise.all([
      all(`SELECT COUNT(*) AS count FROM customers c WHERE ${customerScope.clause}`, customerScope.params).then((rows) => rows[0].count),
      all(`SELECT COUNT(*) AS count FROM leads l WHERE ${leadScope.clause}`, leadScope.params).then((rows) => rows[0].count),
      all(`SELECT COUNT(*) AS count FROM leads l WHERE ${leadScope.clause} AND l.status IN ('New', 'Contacted', 'Qualified')`, leadScope.params).then((rows) => rows[0].count),
      all(`SELECT COUNT(*) AS count FROM opportunities o WHERE ${opportunityScope.clause}`, opportunityScope.params).then((rows) => rows[0].count),
      all(`SELECT COUNT(*) AS count FROM opportunities o WHERE ${opportunityScope.clause} AND o.status = 'Open'`, opportunityScope.params).then((rows) => rows[0].count),
      all(`SELECT COUNT(*) AS count FROM followups f WHERE ${followupScope.clause}`, followupScope.params).then((rows) => rows[0].count),
      all(`SELECT COUNT(*) AS count FROM followups f WHERE ${followupScope.clause} AND f.status = 'Planned'`, followupScope.params).then((rows) => rows[0].count),
      all(`SELECT COUNT(*) AS count FROM activities a WHERE ${activityScope.clause}`, activityScope.params).then((rows) => rows[0].count),
      all(`SELECT stage, SUM(amount) AS totalAmount FROM opportunities o WHERE ${opportunityScope.clause} GROUP BY stage ORDER BY totalAmount DESC`, opportunityScope.params),
      all(`SELECT f.*, u.name AS assignee_name FROM followups f LEFT JOIN users u ON u.id = f.assigned_to_id WHERE ${followupScope.clause} AND f.follow_up_date >= date('now') ORDER BY f.follow_up_date ASC LIMIT 5`, followupScope.params),
      all(`SELECT a.*, u.name AS assignee_name FROM activities a LEFT JOIN users u ON u.id = a.assigned_to_id WHERE ${activityScope.clause} ORDER BY a.activity_date DESC LIMIT 5`, activityScope.params),
    ]);

    const stageLabels = totalPipelineRows.map((row) => row.stage);
    const stageValues = totalPipelineRows.map((row) => Number(row.totalAmount || 0));

    res.render('dashboard', {
      title: 'Dashboard',
      metrics: [
        { label: 'Customers', value: customerCount },
        { label: 'Leads', value: leadCount },
        { label: 'Open Leads', value: openLeadCount },
        { label: 'Opportunities', value: opportunityCount },
        { label: 'Open Opportunities', value: openOpportunityCount },
        { label: 'Follow-Ups', value: followupCount },
        { label: 'Pending Follow-Ups', value: pendingFollowupCount },
        { label: 'Activities', value: activityCount },
      ],
      pipelineChart: {
        labels: stageLabels,
        values: stageValues,
      },
      upcomingFollowups,
      recentActivities,
      formatMoney,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
