const { run } = require('./db');

async function logAudit(req, entry) {
  const createdAt = new Date().toISOString();
  const user = entry.actor || req.user || null;
  await run(
    `INSERT INTO audit_logs (user_id, user_name, module, action, entity_name, record_id, old_value, new_value, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user ? user.id : null,
      user ? user.name : 'System',
      entry.module,
      entry.action,
      entry.entityName,
      String(entry.recordId || ''),
      entry.oldValue ? JSON.stringify(entry.oldValue) : null,
      entry.newValue ? JSON.stringify(entry.newValue) : null,
      entry.ipAddress || req.ip,
      createdAt,
    ],
  );
}

module.exports = {
  logAudit,
};
