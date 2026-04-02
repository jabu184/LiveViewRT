// server.js — LiveViewRT main server
'use strict';

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const fs      = require('fs');
const { db, queries } = require('./db');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // listen on all interfaces

// ── MIDDLEWARE ────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Attach client IP to every request
app.use((req, _res, next) => {
  req.clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  next();
});

// ── WEBSOCKET BROADCAST ───────────────────────────────────────────────

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws, req) => {
  console.log(`[ws] Client connected from ${req.socket.remoteAddress}`);
  // Send current full state on connect
  ws.send(JSON.stringify({
    type: 'init',
    payload: {
      machines:  queries.getAllMachinesIncludingArchived.all(),
      activity:  queries.getAllActivity.all(),
      faults:    queries.getAllFaults.all(),
      concessions: queries.getActiveConcessions.all(),
      settings: queries.getSettings.all().reduce((acc, r) => ({...acc, [r.key]: r.value}), {})
    },
    ts: new Date().toISOString()
  }));
  ws.on('error', err => console.error('[ws] error:', err));
});

// ── API ROUTES ────────────────────────────────────────────────────────

// GET all machines
app.get('/api/machines', (_req, res) => {
  res.json(queries.getAllMachinesIncludingArchived.all());
});

// POST new machine
app.post('/api/machines', (req, res) => {
  const { id, name, model, location, energy, installed } = req.body;
  if (!id || !name || !model) return res.status(400).json({ error: 'id, name, model required' });
  try {
    queries.insertMachine.run({ id, name, model, location: location||'', energy: energy||'', installed: installed||'' });
    queries.insertAudit.run({ machine_id: id, user_name: 'System', action: 'MACHINE_ADDED', detail: `Added machine ${name}`, ip_address: req.clientIp });
    const newMachine = queries.getMachine.get(id);
    broadcast('machine_added', newMachine);
    res.json(newMachine);
  } catch(e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return res.status(400).json({ error: 'Machine ID already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT edit machine
app.put('/api/machines/:id', (req, res) => {
  const { id } = req.params;
  const { name, model, location, energy, installed } = req.body;
  if (!name || !model) return res.status(400).json({ error: 'name, model required' });
  const m = queries.getMachine.get(id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  queries.updateMachine.run({ id, name, model, location: location||'', energy: energy||'', installed: installed||'' });
  queries.insertAudit.run({ machine_id: id, user_name: 'System', action: 'MACHINE_EDITED', detail: `Edited machine ${name}`, ip_address: req.clientIp });
  const updated = queries.getMachine.get(id);
  broadcast('machine_updated', updated);
  res.json(updated);
});

// DELETE archive machine
app.delete('/api/machines/:id', (req, res) => {
  const { id } = req.params;
  const m = queries.getMachine.get(id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  queries.archiveMachine.run({ id });
  queries.insertAudit.run({ machine_id: id, user_name: 'System', action: 'MACHINE_ARCHIVED', detail: `Archived machine ${m.name}`, ip_address: req.clientIp });
  broadcast('machine_archived', { id });
  res.json({ success: true });
});

// PATCH reorder machines
app.patch('/api/machines/order', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid order array' });
  
  const tx = db.transaction((ord) => {
    ord.forEach((id, idx) => {
      queries.updateMachineOrder.run({ id, display_order: idx + 1 });
    });
  });
  tx(order);
  
  const allMachines = queries.getAllMachinesIncludingArchived.all();
  broadcast('machines_reordered', allMachines);
  res.json({ success: true });
});

// PATCH unarchive machine
app.patch('/api/machines/:id/unarchive', (req, res) => {
  const { id } = req.params;
  const m = queries.getMachine.get(id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  queries.unarchiveMachine.run({ id });
  queries.insertAudit.run({ machine_id: id, user_name: 'System', action: 'MACHINE_UNARCHIVED', detail: `Unarchived machine ${m.name}`, ip_address: req.clientIp });
  broadcast('machine_unarchived', { id });
  res.json({ success: true });
});

// DELETE completely destroy machine
app.delete('/api/machines/:id/destroy', (req, res) => {
  const { id } = req.params;
  const m = queries.getMachine.get(id);
  if (!m) return res.status(404).json({ error: 'Not found' });

  const destroyTransaction = db.transaction(() => {
    queries.deleteStatusHistory.run(id);
    queries.deleteActivityLog.run(id);
    queries.deleteFaults.run(id);
    queries.deleteConcessions.run(id);
    queries.deleteAuditTrail.run(id);
    queries.deleteMachine.run(id);
  });
  destroyTransaction();

  queries.insertAudit.run({ machine_id: null, user_name: 'System', action: 'MACHINE_DELETED', detail: `Permanently deleted machine ${m.name} (${id}) and all associated data`, ip_address: req.clientIp });
  broadcast('machine_deleted', { id });
  res.json({ success: true });
});

// PATCH machine status
app.patch('/api/machines/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, changed_by, reason } = req.body;
  if (!status || !changed_by) return res.status(400).json({ error: 'status and changed_by required' });

  const machine = queries.getMachine.get(id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  const validStatuses = ['none','on','available','treatment','qa','service','maintenance','breakdown','offline'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  if (machine.power === 0 && !['breakdown', 'service', 'maintenance', 'offline'].includes(status)) {
    return res.status(400).json({ error: 'Machine must be ON to set this status' });
  }

  queries.insertStatusHistory.run({
    machine_id: id, old_status: machine.status, new_status: status,
    old_power: machine.power, new_power: machine.power,
    changed_by, reason: reason || ''
  });
  queries.updateStatus.run({ id, status });
  queries.insertAudit.run({
    machine_id: id, user_name: changed_by,
    action: 'STATUS_CHANGE',
    detail: `${machine.status} → ${status}${reason ? ': ' + reason : ''}`,
    ip_address: req.clientIp
  });

  const actInfo = queries.insertActivity.run({
    machine_id: id, user_name: changed_by, user_role: 'System',
    activity: 'Status change', notes: `${machine.status} → ${status}${reason ? ' (' + reason + ')' : ''}`
  });
  const actEntry = db.prepare('SELECT a.*, m.name as machine_name FROM activity_log a JOIN machines m ON a.machine_id=m.id WHERE a.id=?').get(actInfo.lastInsertRowid);
  broadcast('activity_added', actEntry);

  const updated = queries.getMachine.get(id);
  broadcast('machine_updated', updated);
  res.json(updated);
});

// PATCH machine power
app.patch('/api/machines/:id/power', (req, res) => {
  const { id } = req.params;
  const { power, changed_by, notes } = req.body;
  if (power === undefined || !changed_by) return res.status(400).json({ error: 'power and changed_by required' });

  const machine = queries.getMachine.get(id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  const newPower = power ? 1 : 0;
  
  let newStatus = machine.status;
  if (power) {
    if (!['breakdown', 'service', 'maintenance'].includes(machine.status)) newStatus = 'on';
  } else {
    if (!['breakdown', 'service', 'maintenance', 'offline'].includes(machine.status)) newStatus = 'none';
  }

  queries.insertStatusHistory.run({
    machine_id: id, old_status: machine.status, new_status: newStatus,
    old_power: machine.power, new_power: newPower,
    changed_by, reason: `Power turned ${power ? 'ON' : 'OFF'}`
  });
  queries.updatePower.run({ id, power: newPower });
  if (newStatus !== machine.status) queries.updateStatus.run({ id, status: newStatus });
  queries.insertAudit.run({
    machine_id: id, user_name: changed_by,
    action: 'POWER_CHANGE',
    detail: `Machine turned ${power ? 'ON' : 'OFF'}${notes ? ': ' + notes : ''}`,
    ip_address: req.clientIp
  });

  const actInfo = queries.insertActivity.run({
    machine_id: id, user_name: changed_by, user_role: 'System',
    activity: 'Power change', notes: `Power turned ${power ? 'ON' : 'OFF'}${notes ? ' (' + notes + ')' : ''}`
  });
  const actEntry = db.prepare('SELECT a.*, m.name as machine_name FROM activity_log a JOIN machines m ON a.machine_id=m.id WHERE a.id=?').get(actInfo.lastInsertRowid);
  broadcast('activity_added', actEntry);

  const updated = queries.getMachine.get(id);
  broadcast('machine_updated', updated);
  res.json(updated);
});

// GET activity log (all or by machine)
app.get('/api/activity', (req, res) => {
  const { machine_id } = req.query;
  const rows = machine_id
    ? queries.getActivity.all(machine_id)
    : queries.getAllActivity.all();
  res.json(rows);
});

// POST activity log entry
app.post('/api/activity', (req, res) => {
  const { machine_id, user_name, user_role, activity, notes } = req.body;
  if (!machine_id || !user_name || !user_role || !activity)
    return res.status(400).json({ error: 'machine_id, user_name, user_role, activity required' });

  const info = queries.insertActivity.run({ machine_id, user_name, user_role, activity, notes: notes || '' });
  queries.insertAudit.run({
    machine_id, user_name, action: 'LOG_ENTRY',
    detail: `${activity}: ${notes || ''}`,
    ip_address: req.clientIp
  });

  const entry = db.prepare('SELECT a.*, m.name as machine_name FROM activity_log a JOIN machines m ON a.machine_id=m.id WHERE a.id=?').get(info.lastInsertRowid);
  broadcast('activity_added', entry);
  res.json(entry);
});

// GET faults
app.get('/api/faults', (req, res) => {
  const { machine_id } = req.query;
  const rows = machine_id
    ? queries.getFaults.all(machine_id)
    : queries.getAllFaults.all();
  res.json(rows);
});

// POST fault
app.post('/api/faults', (req, res) => {
  const { machine_id, user_name, user_role, category, severity, description, status_change } = req.body;
  if (!machine_id || !user_name || !user_role || !category || !severity || !description)
    return res.status(400).json({ error: 'All fault fields required' });

  const machine = queries.getMachine.get(machine_id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  const info = queries.insertFault.run({ machine_id, user_name, user_role, category, severity, description });

  if (status_change) {
    queries.insertStatusHistory.run({
      machine_id, old_status: machine.status, new_status: status_change,
      old_power: machine.power, new_power: machine.power,
      changed_by: user_name, reason: `Fault reported: ${category}`
    });
    queries.updateStatus.run({ id: machine_id, status: status_change });
  }

  queries.insertAudit.run({
    machine_id, user_name, action: 'FAULT_REPORTED',
    detail: `[${severity}] ${category}: ${description.substring(0, 100)}`,
    ip_address: req.clientIp
  });

  const actInfo = queries.insertActivity.run({
    machine_id, user_name, user_role,
    activity: 'Fault reported', notes: `[${severity}] ${category}`
  });
  const actEntry = db.prepare('SELECT a.*, m.name as machine_name FROM activity_log a JOIN machines m ON a.machine_id=m.id WHERE a.id=?').get(actInfo.lastInsertRowid);
  broadcast('activity_added', actEntry);

  const fault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(info.lastInsertRowid);
  broadcast('fault_added', fault);
  if (status_change) broadcast('machine_updated', queries.getMachine.get(machine_id));
  res.json(fault);
});

// DELETE fault
app.delete('/api/faults/:id', (req, res) => {
  const { id } = req.params;
  const fault = db.prepare('SELECT * FROM faults WHERE id=?').get(id);
  if (!fault) return res.status(404).json({ error: 'Not found' });
  queries.deleteFault.run(id);
  queries.insertAudit.run({
    machine_id: fault.machine_id, user_name: 'System', action: 'FAULT_DELETED',
    detail: `Deleted fault #${id} (${fault.category})`,
    ip_address: req.clientIp
  });
  broadcast('fault_deleted', { id: parseInt(id), machine_id: fault.machine_id });
  res.json({ success: true });
});

// PATCH fault resolve
app.patch('/api/faults/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { resolved_by, downtime_hrs } = req.body;
  if (!resolved_by) return res.status(400).json({ error: 'resolved_by required' });

  queries.resolveFault.run({ id, resolved_by, downtime_hrs: parseFloat(downtime_hrs) || 0 });
  queries.insertAudit.run({
    machine_id: null, user_name: resolved_by, action: 'FAULT_RESOLVED',
    detail: `Fault #${id} acknowledged. Downtime: ${downtime_hrs || 0}h`,
    ip_address: req.clientIp
  });

  const fault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(id);
  broadcast('fault_updated', fault);
  res.json(fault);
});

// POST concession / restriction
app.post('/api/concessions', (req, res) => {
  const { machine_id, type, description, user_name, review_by } = req.body;
  if (!machine_id || !type || !description || !user_name) return res.status(400).json({ error: 'All fields required' });

  const info = queries.insertConcession.run({ machine_id, type, description, user_name, review_by: review_by || null });
  queries.insertAudit.run({ machine_id, user_name, action: 'CONCESSION_ADDED', detail: `[${type}] ${description}`, ip_address: req.clientIp });
  queries.insertActivity.run({ machine_id, user_name, user_role: 'System', activity: 'Concession added', notes: `[${type}] ${description}` });

  const c = db.prepare('SELECT * FROM concessions WHERE id=?').get(info.lastInsertRowid);
  broadcast('concession_added', c);
  res.json(c);
});

// PATCH remove concession
app.patch('/api/concessions/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { user_name } = req.body;
  if (!user_name) return res.status(400).json({ error: 'user_name required' });

  const c = db.prepare('SELECT * FROM concessions WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: 'Not found' });

  queries.resolveConcession.run(id);
  queries.insertAudit.run({ machine_id: c.machine_id, user_name, action: 'CONCESSION_REMOVED', detail: `Removed [${c.type}] ${c.description}`, ip_address: req.clientIp });
  queries.insertActivity.run({ machine_id: c.machine_id, user_name, user_role: 'System', activity: 'Concession removed', notes: `Removed [${c.type}] ${c.description}` });
  c.active = 0;
  broadcast('concession_updated', c);
  res.json(c);
});

// GET audit trail
app.get('/api/audit', (req, res) => {
  const { days } = req.query;
  if (days === 'all') {
    res.json(queries.getAuditByPeriod.all({ since: '1970-01-01 00:00:00' }));
  } else if (days) {
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));
    res.json(queries.getAuditByPeriod.all({ since: since.toISOString().replace('T', ' ').substring(0, 19) }));
  } else {
    res.json(queries.getAudit.all());
  }
});

// GET status history for a machine
app.get('/api/machines/:id/history', (req, res) => {
  res.json(queries.getStatusHistory.all(req.params.id));
});

// GET breakdown start time
app.get('/api/machines/:id/breakdown-time', (req, res) => {
  const { id } = req.params;
  const m = queries.getMachine.get(id);
  if (!m || m.status !== 'breakdown') return res.json({ startTime: null });
  const bdRecord = queries.getLastBreakdown.get(id);
  if (bdRecord) {
    res.json({ startTime: bdRecord.created_at.replace(' ', 'T') + 'Z' });
  } else {
    res.json({ startTime: null });
  }
});

// POST resolve breakdown
app.post('/api/machines/:id/resolve-breakdown', (req, res) => {
  const { id } = req.params;
  const { resolved_by, notes, downtime_hrs, next_status } = req.body;
  if (!resolved_by) return res.status(400).json({ error: 'resolved_by required' });

  const machine = queries.getMachine.get(id);
  if (!machine || machine.status !== 'breakdown') return res.status(400).json({ error: 'Machine is not in breakdown' });

  // Try to attach downtime to an open fault. If none exists, create a placeholder to store the downtime.
  let openFault = db.prepare(`SELECT * FROM faults WHERE machine_id = ? AND status = 'open' AND (severity LIKE '%High%' OR severity LIKE '%Critical%') ORDER BY created_at DESC`).get(id);
  
  if (!openFault) {
    const info = queries.insertFault.run({
      machine_id: id, user_name: resolved_by, user_role: 'System', 
      category: 'Other', severity: 'High', 
      description: 'Breakdown downtime log (machine was placed in breakdown without an open fault).'
    });
    openFault = db.prepare('SELECT * FROM faults WHERE id = ?').get(info.lastInsertRowid);
    const newFault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(info.lastInsertRowid);
    broadcast('fault_added', newFault);
  }

  queries.resolveFault.run({ id: openFault.id, resolved_by, downtime_hrs: parseFloat(downtime_hrs) || 0 });
  const updatedFault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(openFault.id);
  broadcast('fault_updated', updatedFault);

  const newStatus = next_status || 'offline';
  let newPower = machine.power;
  // Ensure power is turned on if transitioning to a clinical/qa status
  if (!['breakdown', 'service', 'maintenance', 'offline', 'none'].includes(newStatus) && newPower === 0) {
    newPower = 1;
    queries.updatePower.run({ id, power: 1 });
  }

  queries.insertStatusHistory.run({ machine_id: id, old_status: machine.status, new_status: newStatus, old_power: machine.power, new_power: newPower, changed_by: resolved_by, reason: `Breakdown resolved${notes ? ': ' + notes : ''}` });
  queries.updateStatus.run({ id, status: newStatus });
  queries.insertAudit.run({ machine_id: id, user_name: resolved_by, action: 'BREAKDOWN_RESOLVED', detail: `Breakdown resolved. Status set to ${newStatus}. Downtime: ${downtime_hrs || 0}h`, ip_address: req.clientIp });
  const actInfo = queries.insertActivity.run({ machine_id: id, user_name: resolved_by, user_role: 'System', activity: 'Breakdown resolved', notes: `Status set to ${newStatus}. Downtime: ${downtime_hrs || 0}h${notes ? ' (' + notes + ')' : ''}` });
  const actEntry = db.prepare('SELECT a.*, m.name as machine_name FROM activity_log a JOIN machines m ON a.machine_id=m.id WHERE a.id=?').get(actInfo.lastInsertRowid);
  broadcast('activity_added', actEntry);
  const updated = queries.getMachine.get(id);
  broadcast('machine_updated', updated);
  res.json(updated);
});

// GET settings
app.get('/api/settings', (req, res) => {
  res.json(queries.getSettings.all().reduce((acc, r) => ({...acc, [r.key]: r.value}), {}));
});

// POST server backup
app.post('/api/backup', (req, res) => {
  const { force } = req.body;
  const user_name = req.body.user_name || 'System';
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const d = new Date();
    const timestamp = d.getFullYear() + '-' + 
                      String(d.getMonth()+1).padStart(2,'0') + '-' + 
                      String(d.getDate()).padStart(2,'0') + '_' + 
                      String(d.getHours()).padStart(2,'0') + '-' + 
                      String(d.getMinutes()).padStart(2,'0');
    const backupName = `rtdashboard_backup_${timestamp}.db`;
    const backupPath = path.join(__dirname, 'data', backupName);
    const dbPath = path.join(__dirname, 'data', 'rtdashboard.db');

    if (fs.existsSync(backupPath) && !force) {
      return res.status(409).json({ exists: true, file: backupName });
    }

    fs.copyFileSync(dbPath, backupPath);
    queries.insertAudit.run({ machine_id: null, user_name, action: 'BACKUP_CREATED', detail: `Created server backup: ${backupName}`, ip_address: req.clientIp });
    res.json({ success: true, file: backupName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET download backup
app.get('/api/backup/download', (_req, res) => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbPath = path.join(__dirname, 'data', 'rtdashboard.db');
    const timestamp = new Date().toISOString().slice(0,10);
    res.download(dbPath, `rtdashboard_${timestamp}.db`);
  } catch (e) {
    res.status(500).send('Error downloading database');
  }
});

// POST restore database
app.post('/api/restore', (req, res) => {
  const user_name = req.query.user_name;
  if (!user_name) return res.status(400).json({ error: 'user_name required' });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Invalid file payload' });
  try {
    queries.insertAudit.run({ machine_id: null, user_name, action: 'DATABASE_RESTORED', detail: `Database restored from upload`, ip_address: req.clientIp });
    res.json({ success: true, message: 'Database restored. Server restarting...' });
    setTimeout(() => {
      const dbPath = path.join(__dirname, 'data', 'rtdashboard.db');
      db.close();
      fs.writeFileSync(dbPath, req.body);
      if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
      process.exit(0);
    }, 1000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH settings
app.patch('/api/settings', (req, res) => {
  const { clinical_start, clinical_end, fault_categories, fault_severities, admin_pwd_enabled, admin_pwd } = req.body;
  if (clinical_start !== undefined) queries.updateSetting.run({ key: 'clinical_start', value: clinical_start.toString() });
  if (clinical_end !== undefined) queries.updateSetting.run({ key: 'clinical_end', value: clinical_end.toString() });
  if (fault_categories !== undefined) queries.updateSetting.run({ key: 'fault_categories', value: fault_categories });
  if (fault_severities !== undefined) queries.updateSetting.run({ key: 'fault_severities', value: fault_severities });
  if (admin_pwd_enabled !== undefined) queries.updateSetting.run({ key: 'admin_pwd_enabled', value: admin_pwd_enabled.toString() });
  if (admin_pwd !== undefined) queries.updateSetting.run({ key: 'admin_pwd', value: admin_pwd.toString() });
  const newSettings = queries.getSettings.all().reduce((acc, r) => ({...acc, [r.key]: r.value}), {});
  broadcast('settings_updated', newSettings);
  res.json(newSettings);
});

// Helper to calculate working hours (7am-8pm, Mon-Fri) between two dates
function getWorkingHours(start, end, startH = 7, endH = 20) {
  let current = new Date(start);
  const endDt = new Date(end);
  let totalHours = 0;
  while (current < endDt) {
    let day = current.getDay();
    let hour = current.getHours();
    // Skip weekends
    if (day === 0 || day === 6) { current.setHours(24, 0, 0, 0); continue; }
    // Skip out of hours
    if (hour < startH) { current.setHours(startH, 0, 0, 0); continue; }
    if (hour >= endH) { current.setHours(24, 0, 0, 0); continue; }
    let nextBoundary = new Date(current);
    nextBoundary.setHours(endH, 0, 0, 0);
    if (endDt < nextBoundary) nextBoundary = endDt;
    totalHours += (nextBoundary - current) / 3600000;
    current = nextBoundary;
  }
  return totalHours;
}

// GET admin report summary
app.get('/api/report', (req, res) => {
  const daysParam = req.query.days;
  let period_days;
  let since = new Date();
  let sinceStr;

  if (daysParam === 'all') {
    const firstRow = db.prepare(`
      SELECT MIN(created_at) as min_dt FROM (
        SELECT created_at FROM status_history
        UNION ALL
        SELECT created_at FROM faults
        UNION ALL
        SELECT created_at FROM activity_log
      )
    `).get();
    if (firstRow && firstRow.min_dt) {
      since = new Date(firstRow.min_dt.replace(' ', 'T') + 'Z');
    } else {
      since.setDate(since.getDate() - 30);
    }
    period_days = Math.max(1, Math.ceil((new Date() - since) / (1000 * 60 * 60 * 24)));
    sinceStr = since.toISOString().replace('T', ' ').substring(0, 19);
  } else {
    period_days = parseInt(daysParam) || 30;
    since.setDate(since.getDate() - period_days);
    sinceStr = since.toISOString().replace('T', ' ').substring(0, 19);
  }
  
  const period_label = daysParam === 'all' ? 'All Time' : `Last ${period_days} Days`;

  const machines = queries.getAllMachinesIncludingArchived.all();
  const faults = queries.getFaultsByPeriod.all({ since: sinceStr });
  
  const yearSince = new Date();
  yearSince.setFullYear(yearSince.getFullYear() - 1);
  const yearly_faults = queries.getFaultsByPeriod.all({ since: yearSince.toISOString().replace('T', ' ').substring(0, 19) });

  const sRows = queries.getSettings.all().reduce((acc, r) => ({...acc, [r.key]: r.value}), {});
  const startH = parseInt(sRows.clinical_start || '7');
  const endH = parseInt(sRows.clinical_end || '20');

  const activity = db.prepare(`
    SELECT a.*, m.name as machine_name FROM activity_log a JOIN machines m ON a.machine_id=m.id
    WHERE a.created_at >= ? ORDER BY a.created_at DESC
  `).all(sinceStr);

  const summary = machines.map(m => {
    const mFaults = faults.filter(f => f.machine_id === m.id);
    const downtime = mFaults.reduce((s, f) => s + (f.downtime_hrs || 0), 0);
    const openFaults = mFaults.filter(f => f.status === 'open').length;

    let currentStatus = 'none';
    let currentPower = 0;
    let lastTime = since.getTime();
    const status_times = { on: 0, available: 0, treatment: 0, qa: 0, service: 0, maintenance: 0, breakdown: 0, offline: 0, none: 0 };

    const mHist = queries.getStatusHistoryAll.all(m.id);
    for (const h of mHist) {
      const hTime = new Date(h.created_at.replace(' ', 'T') + 'Z').getTime();
      if (hTime <= since.getTime()) {
        currentStatus = h.new_status;
        currentPower = h.new_power;
      } else {
        const durationHrs = getWorkingHours(lastTime, hTime, startH, endH);
        if (status_times[currentStatus] !== undefined) status_times[currentStatus] += durationHrs;
        currentStatus = h.new_status;
        currentPower = h.new_power;
        lastTime = hTime;
      }
    }
    const durationHrs = getWorkingHours(lastTime, new Date().getTime(), startH, endH);
    if (status_times[currentStatus] !== undefined) status_times[currentStatus] += durationHrs;

    return {
      machine: m,
      fault_count: mFaults.length,
      open_faults: openFaults,
      downtime_hrs: downtime,
      activity_count: activity.filter(a => a.machine_id === m.id).length,
      status_times
    };
  });

  res.json({ period_days, period_label, since: sinceStr, summary, faults, activity, yearly_faults });
});

// Catch-all — serve frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`\n┌─────────────────────────────────────────┐`);
  console.log(`│  LiveViewRT running on port ${PORT}          │`);
  console.log(`│  http://localhost:${PORT}                   │`);
  console.log(`│  Database: data/rtdashboard.db          │`);
  console.log(`└─────────────────────────────────────────┘\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => { db.close(); server.close(); });
process.on('SIGINT',  () => { db.close(); server.close(); process.exit(0); });
