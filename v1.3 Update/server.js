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

  const displayStatus = {
    none: 'OFF', on: 'On', available: 'On', treatment: 'Clinical',
    qa: 'QA / Physics', service: 'Service', maintenance: 'Maintenance',
    breakdown: 'Breakdown', offline: 'Offline'
  };
  const oldName = displayStatus[machine.status] || machine.status;
  const newName = displayStatus[status] || status;

  queries.insertStatusHistory.run({
    machine_id: id, old_status: machine.status, new_status: status,
    old_power: machine.power, new_power: machine.power,
    changed_by, reason: reason || ''
  });
  queries.updateStatus.run({ id, status });
  queries.insertAudit.run({
    machine_id: id, user_name: changed_by,
    action: 'STATUS_CHANGE',
    detail: `${oldName} → ${newName}${reason ? ': ' + reason : ''}`,
    ip_address: req.clientIp
  });

  const actInfo = queries.insertActivity.run({
    machine_id: id, user_name: changed_by, user_role: 'System',
    activity: 'Status change', notes: `${oldName} → ${newName}${reason ? ' (' + reason + ')' : ''}`
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
  let { machine_id, user_name, user_role, category, severity, description, status_change, screenshot_taken, fault_codes } = req.body;
  if (!machine_id || !user_name || !user_role || !category || !severity || !description)
    return res.status(400).json({ error: 'All fault fields required' });

  const machine = queries.getMachine.get(machine_id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  if (status_change === 'breakdown' && !severity.includes('High') && !severity.includes('Critical')) {
    severity = 'High';
  }

  const info = queries.insertFault.run({ machine_id, user_name, user_role, category, severity, description, screenshot_taken: screenshot_taken ? 1 : 0, fault_codes: fault_codes || null });

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

// PUT edit fault
app.put('/api/faults/:id', (req, res) => {
  const { id } = req.params;
  const { category, severity, description, screenshot_taken, fault_codes, downtime_hrs } = req.body;

  const fault = db.prepare('SELECT * FROM faults WHERE id=?').get(id);
  if (!fault) return res.status(404).json({ error: 'Not found' });

  db.prepare(
    'UPDATE faults SET category=?, severity=?, description=?, screenshot_taken=?, fault_codes=?, downtime_hrs=? WHERE id=?'
  ).run(category, severity, description, screenshot_taken ? 1 : 0, fault_codes, (downtime_hrs !== undefined ? parseFloat(downtime_hrs) : fault.downtime_hrs), id);

  const audit = db.prepare(`SELECT * FROM audit_trail WHERE machine_id=? AND action='FAULT_REPORTED' AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds') ORDER BY id DESC LIMIT 1`).get(fault.machine_id, fault.created_at, fault.created_at);
  if (audit) {
    const newDetail = `[${severity}] ${category}: ${description.substring(0, 100)}`;
    db.prepare('UPDATE audit_trail SET detail=? WHERE id=?').run(newDetail, audit.id);
  }

  if (downtime_hrs !== undefined && fault.resolved_at) {
    const resolvedAudit = db.prepare(`
        SELECT * FROM audit_trail 
        WHERE machine_id = ? 
        AND (action = 'FAULT_RESOLVED' OR action = 'BREAKDOWN_RESOLVED')
        AND created_at >= datetime(?, '-2 seconds') 
        AND created_at <= datetime(?, '+2 seconds')
        ORDER BY id DESC LIMIT 1
    `).get(fault.machine_id, fault.resolved_at, fault.resolved_at);

    if (resolvedAudit) {
        let newDetail = resolvedAudit.detail;
        if (newDetail.includes('Downtime:')) {
          newDetail = newDetail.replace(/Downtime: [0-9.]+h/, `Downtime: ${parseFloat(downtime_hrs || 0).toFixed(2)}h`);
        } else {
          newDetail += ` Downtime: ${parseFloat(downtime_hrs || 0).toFixed(2)}h`;
        }
        db.prepare('UPDATE audit_trail SET detail = ? WHERE id = ?').run(newDetail, resolvedAudit.id);
    }
  }
  
  const updatedFault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(id);
  broadcast('fault_updated', updatedFault);
  res.json(updatedFault);
});

// PATCH fault resolve
app.patch('/api/faults/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { resolved_by, downtime_hrs, category, severity, description } = req.body;
  if (!resolved_by) return res.status(400).json({ error: 'resolved_by required' });

  if (category && severity && description) {
    db.prepare('UPDATE faults SET category=?, severity=?, description=? WHERE id=?').run(category, severity, description, id);
  }

  queries.resolveFault.run({ id, resolved_by, downtime_hrs: parseFloat(downtime_hrs) || 0 });
  const fault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(id);

  queries.insertAudit.run({
    machine_id: fault.machine_id, user_name: resolved_by, action: 'FAULT_RESOLVED',
    detail: `Fault #${id} acknowledged. Downtime: ${downtime_hrs || 0}h`,
    ip_address: req.clientIp
  });

  broadcast('fault_updated', fault);
  res.json(fault);
});

// POST bulk acknowledge faults
app.post('/api/faults/bulk-acknowledge', (req, res) => {
  const { ids, resolved_by } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || !resolved_by) {
    return res.status(400).json({ error: 'ids array and resolved_by required' });
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const updatedFaults = [];
  let skipped_count = 0;

  const tx = db.transaction(() => {
    for (const id of ids) {
      const fault = db.prepare('SELECT * FROM faults WHERE id = ? AND status = ?').get(id, 'open');
      if (fault) {
        const m = queries.getMachine.get(fault.machine_id);
        const isBreakdown = fault.severity.includes('High') || fault.severity.includes('Critical') || (m && m.status === 'breakdown');
        
        // Breakdowns must be resolved via the dedicated modal, not just acknowledged.
        if (isBreakdown) {
          skipped_count++;
          continue;
        }

        db.prepare(`UPDATE faults SET status='resolved', resolved_by=?, resolved_at=? WHERE id=?`).run(resolved_by, now, id);
        queries.insertAudit.run({ machine_id: fault.machine_id, user_name: resolved_by, action: 'FAULT_RESOLVED', detail: `Fault #${id} acknowledged via bulk action.`, ip_address: req.clientIp });
        const updatedFault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(id);
        updatedFaults.push(updatedFault);
      }
    }
  });

  try {
    tx();
    updatedFaults.forEach(fault => {
      broadcast('fault_updated', fault);
    });
    res.json({ success: true, acknowledged: updatedFaults.length, skipped: skipped_count });
  } catch (e) {
    console.error('[api] bulk-acknowledge error:', e);
    res.status(500).json({ error: e.message });
  }
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

// PUT edit concession
app.put('/api/concessions/:id', (req, res) => {
  const { id } = req.params;
  const { type, description, user_name, review_by } = req.body;
  if (!type || !description || !user_name) return res.status(400).json({ error: 'Missing fields' });

  const c = db.prepare('SELECT * FROM concessions WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: 'Not found' });

  db.prepare('UPDATE concessions SET type=?, description=?, user_name=?, review_by=? WHERE id=?').run(type, description, user_name, review_by || null, id);

  queries.insertAudit.run({ machine_id: c.machine_id, user_name, action: 'CONCESSION_EDITED', detail: `Edited to [${type}] ${description}`, ip_address: req.clientIp });
  queries.insertActivity.run({ machine_id: c.machine_id, user_name, user_role: 'System', activity: 'Concession edited', notes: `[${type}] ${description}` });

  const updated = db.prepare('SELECT * FROM concessions WHERE id=?').get(id);
  broadcast('concession_updated', updated);
  res.json(updated);
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

// GET audit source
app.get('/api/audit/:id/source', (req, res) => {
  const audit = db.prepare('SELECT * FROM audit_trail WHERE id=?').get(req.params.id);
  if (!audit) return res.status(404).json({error: 'Not found'});
  let source = null, type = 'unknown';
  if (audit.machine_id) {
    const t = audit.created_at;
    const mid = audit.machine_id;
    if (audit.action === 'LOG_ENTRY') {
      source = db.prepare(`SELECT * FROM activity_log WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds') LIMIT 1`).get(mid, t, t);
      if(source) type = 'activity_log';
    } else if (['STATUS_CHANGE', 'POWER_CHANGE'].includes(audit.action)) {
      source = db.prepare(`SELECT * FROM status_history WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds') LIMIT 1`).get(mid, t, t);
      if(source) type = 'status_history';
    } else if (audit.action === 'FAULT_REPORTED') {
      source = db.prepare(`SELECT * FROM faults WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds') LIMIT 1`).get(mid, t, t);
      if(source) type = 'faults';
    } else if (['BREAKDOWN_RESOLVED', 'FAULT_RESOLVED'].includes(audit.action)) {
      source = db.prepare(`SELECT * FROM faults WHERE machine_id=? AND resolved_at >= datetime(?, '-2 seconds') AND resolved_at <= datetime(?, '+2 seconds') LIMIT 1`).get(mid, t, t);
      if(source) type = 'faults_resolve';
    }
  }
  res.json({ audit, source, type });
});

// PUT edit audit AND underlying source
app.put('/api/audit/:id/source', (req, res) => {
  const { id } = req.params;
  const { type, source_id, user_name, detail, activity, notes, reason, category, severity, description, downtime_hrs, created_at } = req.body;
  if (!user_name) return res.status(400).json({ error: 'user_name required' });
  
  const audit = db.prepare('SELECT * FROM audit_trail WHERE id=?').get(id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  
  const newDate = created_at || audit.created_at;

  if (type === 'activity_log' && source_id) {
    db.prepare('UPDATE activity_log SET user_name=?, activity=?, notes=?, created_at=? WHERE id=?').run(user_name, activity, notes, newDate, source_id);
    db.prepare('UPDATE audit_trail SET user_name=?, detail=?, created_at=? WHERE id=?').run(user_name, `${activity}: ${notes||''}`, newDate, id);
  } else if (type === 'status_history' && source_id) {
    db.prepare('UPDATE status_history SET changed_by=?, reason=?, created_at=? WHERE id=?').run(user_name, reason, newDate, source_id);
    const sh = db.prepare('SELECT * FROM status_history WHERE id=?').get(source_id);
    let newDetail = detail;
    if (audit.action === 'STATUS_CHANGE') {
      const displayStatus = { none: 'OFF', on: 'On', available: 'On', treatment: 'Clinical', qa: 'QA / Physics', service: 'Service', maintenance: 'Maintenance', breakdown: 'Breakdown', offline: 'Offline' };
      const oN = displayStatus[sh.old_status] || sh.old_status;
      const nN = displayStatus[sh.new_status] || sh.new_status;
      newDetail = `${oN} → ${nN}${reason ? ': ' + reason : ''}`;
      db.prepare(`UPDATE activity_log SET user_name=?, notes=?, created_at=? WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds') AND activity='Status change'`).run(user_name, `${oN} → ${nN}${reason ? ' (' + reason + ')' : ''}`, newDate, audit.machine_id, audit.created_at, audit.created_at);
    }
    if (audit.action === 'POWER_CHANGE') {
      newDetail = `Machine turned ${sh.new_power ? 'ON' : 'OFF'}${reason ? ': ' + reason : ''}`;
      db.prepare(`UPDATE activity_log SET user_name=?, notes=?, created_at=? WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds') AND activity='Power change'`).run(user_name, `Power turned ${sh.new_power ? 'ON' : 'OFF'}${reason ? ' (' + reason + ')' : ''}`, newDate, audit.machine_id, audit.created_at, audit.created_at);
    }
    db.prepare('UPDATE audit_trail SET user_name=?, detail=?, created_at=? WHERE id=?').run(user_name, newDetail, newDate, id);
  } else if (type === 'faults' && source_id) {
    db.prepare('UPDATE faults SET user_name=?, category=?, severity=?, description=?, created_at=? WHERE id=?').run(user_name, category, severity, description, newDate, source_id);
    db.prepare('UPDATE audit_trail SET user_name=?, detail=?, created_at=? WHERE id=?').run(user_name, `[${severity}] ${category}: ${description.substring(0, 100)}`, newDate, id);
  } else if (type === 'faults_resolve' && source_id) {
    db.prepare('UPDATE faults SET resolved_by=?, category=?, severity=?, description=?, downtime_hrs=?, resolved_at=? WHERE id=?').run(user_name, category, severity, description, downtime_hrs || 0, newDate, source_id);
    if (audit.action === 'BREAKDOWN_RESOLVED') {
       db.prepare(`UPDATE status_history SET changed_by=?, created_at=? WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds')`).run(user_name, newDate, audit.machine_id, audit.created_at, audit.created_at);
       db.prepare(`UPDATE activity_log SET user_name=?, created_at=? WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds')`).run(user_name, newDate, audit.machine_id, audit.created_at, audit.created_at);
    }
    let newDetail = audit.detail.replace(/Downtime: [0-9.]+h/, `Downtime: ${downtime_hrs || 0}h`);
    db.prepare('UPDATE audit_trail SET user_name=?, detail=?, created_at=? WHERE id=?').run(user_name, newDetail, newDate, id);
  } else {
    db.prepare('UPDATE audit_trail SET user_name=?, detail=?, created_at=? WHERE id=?').run(user_name, detail || audit.detail, newDate, id);
  }
  
  broadcast('init', { machines: queries.getAllMachinesIncludingArchived.all(), activity: queries.getAllActivity.all(), faults: queries.getAllFaults.all(), concessions: queries.getActiveConcessions.all(), settings: queries.getSettings.all().reduce((acc, r) => ({...acc, [r.key]: r.value}), {}) });
  res.json({ success: true });
});

// DELETE audit AND underlying source
app.delete('/api/audit/:id/source', (req, res) => {
  const { id } = req.params;
  const audit = db.prepare('SELECT * FROM audit_trail WHERE id=?').get(id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  
  if (audit.machine_id) {
    const t = audit.created_at;
    const mid = audit.machine_id;
    
    // Always clean up associated activity logs
    db.prepare(`DELETE FROM activity_log WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds')`).run(mid, t, t);
    
    if (['STATUS_CHANGE', 'POWER_CHANGE', 'BREAKDOWN_RESOLVED', 'FAULT_REPORTED'].includes(audit.action)) {
      db.prepare(`DELETE FROM status_history WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds')`).run(mid, t, t);
    }
    
    if (audit.action === 'FAULT_REPORTED') {
      db.prepare(`DELETE FROM faults WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds')`).run(mid, t, t);
    }
    
    if (audit.action === 'BREAKDOWN_RESOLVED' || audit.action === 'FAULT_RESOLVED') {
      // Delete placeholder ad-hoc faults that were created and resolved concurrently
      db.prepare(`DELETE FROM faults WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds') AND resolved_at >= datetime(?, '-2 seconds') AND resolved_at <= datetime(?, '+2 seconds')`).run(mid, t, t, t, t);
      // Un-resolve standard faults
      db.prepare(`UPDATE faults SET status='open', resolved_by=NULL, resolved_at=NULL, downtime_hrs=NULL WHERE machine_id=? AND resolved_at >= datetime(?, '-2 seconds') AND resolved_at <= datetime(?, '+2 seconds')`).run(mid, t, t);
    }
    
    if (audit.action === 'CONCESSION_ADDED') {
      db.prepare(`DELETE FROM concessions WHERE machine_id=? AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds')`).run(mid, t, t);
    }
  } else {
    const t = audit.created_at;
    db.prepare(`DELETE FROM activity_log WHERE created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds')`).run(t, t);
    if (audit.action === 'FAULT_RESOLVED') {
      db.prepare(`UPDATE faults SET status='open', resolved_by=NULL, resolved_at=NULL, downtime_hrs=NULL WHERE resolved_at >= datetime(?, '-2 seconds') AND resolved_at <= datetime(?, '+2 seconds')`).run(t, t);
    }
  }
  
  db.prepare('DELETE FROM audit_trail WHERE id=?').run(id);
  
  broadcast('init', { machines: queries.getAllMachinesIncludingArchived.all(), activity: queries.getAllActivity.all(), faults: queries.getAllFaults.all(), concessions: queries.getActiveConcessions.all(), settings: queries.getSettings.all().reduce((acc, r) => ({...acc, [r.key]: r.value}), {}) });
  res.json({ success: true });
});

// DELETE audit log entry
app.delete('/api/audit/:id', (req, res) => {
  const { id } = req.params;
  const audit = db.prepare('SELECT * FROM audit_trail WHERE id=?').get(id);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  queries.deleteAudit.run(id);
  res.json({ success: true });
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
  const { resolved_by, notes, downtime_hrs, next_status, category, severity, description, fault_id } = req.body;
  if (!resolved_by) return res.status(400).json({ error: 'resolved_by required' });

  const machine = queries.getMachine.get(id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  // Try to attach downtime to an open fault. If none exists, create a placeholder to store the downtime.
  let openFault;
  if (fault_id) {
    openFault = db.prepare('SELECT * FROM faults WHERE id = ?').get(fault_id);
  } else {
    openFault = db.prepare(`SELECT * FROM faults WHERE machine_id = ? AND status = 'open' AND (severity LIKE '%High%' OR severity LIKE '%Critical%') ORDER BY created_at DESC`).get(id);
  }
  
  if (!openFault) {
    const info = queries.insertFault.run({
      machine_id: id, user_name: resolved_by, user_role: 'System', 
      category: category || 'Other', severity: severity || 'High', 
      description: description || 'Breakdown downtime log (machine was placed in breakdown without an open fault).'
    });
    openFault = db.prepare('SELECT * FROM faults WHERE id = ?').get(info.lastInsertRowid);
    const newFault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(info.lastInsertRowid);
    broadcast('fault_added', newFault);
  }

  if (category && severity && description) {
    db.prepare('UPDATE faults SET category=?, severity=?, description=? WHERE id=?').run(category, severity, description, openFault.id);
  }

  queries.resolveFault.run({ id: openFault.id, resolved_by, downtime_hrs: parseFloat(downtime_hrs) || 0 });
  const updatedFault = db.prepare('SELECT f.*, m.name as machine_name FROM faults f JOIN machines m ON f.machine_id=m.id WHERE f.id=?').get(openFault.id);
  broadcast('fault_updated', updatedFault);

  const newStatus = next_status || machine.status;
  let newPower = machine.power;
  // Ensure power is turned on if transitioning to a clinical/qa status
  if (!['breakdown', 'service', 'maintenance', 'offline', 'none'].includes(newStatus) && newPower === 0) {
    newPower = 1;
    queries.updatePower.run({ id, power: 1 });
  }

  if (machine.status !== newStatus || machine.power !== newPower || machine.status === 'breakdown') {
    const displayStatus = {
      none: 'OFF', on: 'On', available: 'On', treatment: 'Clinical',
      qa: 'QA / Physics', service: 'Service', maintenance: 'Maintenance',
      breakdown: 'Breakdown', offline: 'Offline'
    };
    const newName = displayStatus[newStatus] || newStatus;

    queries.insertStatusHistory.run({ machine_id: id, old_status: machine.status, new_status: newStatus, old_power: machine.power, new_power: newPower, changed_by: resolved_by, reason: `Breakdown resolved${notes ? ': ' + notes : ''}` });
    queries.updateStatus.run({ id, status: newStatus });
    queries.insertAudit.run({ machine_id: id, user_name: resolved_by, action: 'BREAKDOWN_RESOLVED', detail: `Breakdown resolved. Status set to ${newName}. Downtime: ${downtime_hrs || 0}h`, ip_address: req.clientIp });
    const actInfo = queries.insertActivity.run({ machine_id: id, user_name: resolved_by, user_role: 'System', activity: 'Breakdown resolved', notes: `Status set to ${newName}. Downtime: ${downtime_hrs || 0}h${notes ? ' (' + notes + ')' : ''}` });
    const actEntry = db.prepare('SELECT a.*, m.name as machine_name FROM activity_log a JOIN machines m ON a.machine_id=m.id WHERE a.id=?').get(actInfo.lastInsertRowid);
    broadcast('activity_added', actEntry);
  }
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

// GET download config backup
app.get('/api/backup/download-config', (_req, res) => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbPath = path.join(__dirname, 'data', 'rtdashboard.db');
    const timestamp = new Date().toISOString().slice(0,10);
    const tmpPath = path.join(__dirname, 'data', `rtdashboard_config_${timestamp}_${Date.now()}.db`);
    
    fs.copyFileSync(dbPath, tmpPath);
    
    const Database = require('better-sqlite3');
    const tmpDb = new Database(tmpPath);
    tmpDb.pragma('journal_mode = DELETE');
    tmpDb.exec('DELETE FROM activity_log; DELETE FROM faults; DELETE FROM audit_trail; DELETE FROM status_history; DELETE FROM concessions; VACUUM;');
    tmpDb.close();
    
    res.download(tmpPath, `rtdashboard_config_${timestamp}.db`, (err) => {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    });
  } catch (e) {
    res.status(500).send('Error downloading config database');
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
  const { clinical_start, clinical_end, fault_categories, fault_severities, activity_categories, admin_pwd_enabled, admin_pwd, default_fault_category, default_fault_severity, default_activity_category } = req.body;
  if (clinical_start !== undefined) queries.updateSetting.run({ key: 'clinical_start', value: clinical_start.toString() });
  if (clinical_end !== undefined) queries.updateSetting.run({ key: 'clinical_end', value: clinical_end.toString() });
  if (fault_categories !== undefined) queries.updateSetting.run({ key: 'fault_categories', value: fault_categories });
  if (fault_severities !== undefined) queries.updateSetting.run({ key: 'fault_severities', value: fault_severities });
  if (activity_categories !== undefined) queries.updateSetting.run({ key: 'activity_categories', value: activity_categories });
  if (admin_pwd_enabled !== undefined) queries.updateSetting.run({ key: 'admin_pwd_enabled', value: admin_pwd_enabled.toString() });
  if (admin_pwd !== undefined) queries.updateSetting.run({ key: 'admin_pwd', value: admin_pwd.toString() });
  if (default_fault_category !== undefined) queries.updateSetting.run({ key: 'default_fault_category', value: default_fault_category });
  if (default_fault_severity !== undefined) queries.updateSetting.run({ key: 'default_fault_severity', value: default_fault_severity });
  if (default_activity_category !== undefined) queries.updateSetting.run({ key: 'default_activity_category', value: default_activity_category });
  const newSettings = queries.getSettings.all().reduce((acc, r) => ({...acc, [r.key]: r.value}), {});
  broadcast('settings_updated', newSettings);
  res.json(newSettings);
});

// Helper to calculate working hours (7am-8pm, Mon-Fri) between two dates
function getWorkingHours(start, end, startStr = '07:00', endStr = '20:00') {
  if (!startStr.includes(':')) startStr += ':00';
  if (!endStr.includes(':')) endStr += ':00';
  const [sH, sM] = startStr.split(':').map(Number);
  const [eH, eM] = endStr.split(':').map(Number);
  const startH = sH + sM/60;
  const endH = eH + eM/60;

  let current = new Date(start);
  const endDt = new Date(end);
  let totalHours = 0;
  while (current < endDt) {
    let day = current.getDay();
    let hour = current.getHours();
    let min = current.getMinutes();
    let currH = hour + min/60 + current.getSeconds()/3600;
    // Skip weekends
    if (day === 0 || day === 6) { current.setHours(24, 0, 0, 0); continue; }
    // Skip out of hours
    if (currH < startH) { current.setHours(sH, sM, 0, 0); continue; }
    if (currH >= endH) { current.setHours(24, 0, 0, 0); continue; }
    let nextBoundary = new Date(current);
    nextBoundary.setHours(eH, eM, 0, 0);
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
  const startStr = sRows.clinical_start || '07:00';
  const endStr = sRows.clinical_end || '20:00';

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
        const durationHrs = getWorkingHours(lastTime, hTime, startStr, endStr);
        if (status_times[currentStatus] !== undefined) status_times[currentStatus] += durationHrs;
        currentStatus = h.new_status;
        currentPower = h.new_power;
        lastTime = hTime;
      }
    }
    const durationHrs = getWorkingHours(lastTime, new Date().getTime(), startStr, endStr);
    if (status_times[currentStatus] !== undefined) status_times[currentStatus] += durationHrs;

    // Calculate total exact clinical hours possible in this reporting period
    const totalClinicalHours = getWorkingHours(since.getTime(), new Date().getTime(), startStr, endStr);

    // Sum all active non-downtime states
    const activeHours = status_times.treatment + status_times.available + status_times.on + 
                        status_times.qa + status_times.service + status_times.maintenance;

    // Any time not active and not officially documented as downtime becomes 'offline' (catch-all)
    let calculatedOffline = totalClinicalHours - activeHours - downtime;
    if (calculatedOffline < 0) calculatedOffline = 0; // Safeguard if user enters massive downtime

    // Group into 6 core states for the utilisation percentages
    const grouped_times = {
      treatment: status_times.treatment,
      available: status_times.available + status_times.on,
      qa: status_times.qa,
      service: status_times.service + status_times.maintenance,
      breakdown: downtime, // Single source of truth
      offline: calculatedOffline
    };

    // Calculate percentages based on the sum of grouped times to ensure it equals exactly 100%
    const totalGroupedHours = Object.values(grouped_times).reduce((a, b) => a + b, 0);
    const status_percentages = {};
    for (const [state, hours] of Object.entries(grouped_times)) {
      status_percentages[state] = totalGroupedHours > 0 
        ? parseFloat(((hours / totalGroupedHours) * 100).toFixed(2)) 
        : 0;
    }

    return {
      machine: m,
      fault_count: mFaults.length,
      open_faults: openFaults,
      downtime_hrs: downtime,
      activity_count: activity.filter(a => a.machine_id === m.id).length,
      status_times,
      grouped_times,
      status_percentages,
      total_clinical_hours: totalGroupedHours
    };
  });

  res.json({ period_days, period_label, since: sinceStr, summary, faults, activity, yearly_faults });
});

// GET release notes
app.get('/api/release-notes', (_req, res) => {
  const notesPath = path.join(__dirname, 'release_notes.txt');
  fs.readFile(notesPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading release_notes.txt:', err);
      return res.status(500).send('Could not read release notes.');
    }
    res.type('text/plain').send(data);
  });
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
