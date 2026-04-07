// db.js — database initialisation and access layer
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new Database(path.join(DATA_DIR, 'rtdashboard.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS machines (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    model       TEXT NOT NULL,
    location    TEXT NOT NULL,
    energy      TEXT NOT NULL,
    installed   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'none',
    power       INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT NOT NULL REFERENCES machines(id),
    user_name   TEXT NOT NULL,
    user_role   TEXT NOT NULL,
    activity    TEXT NOT NULL,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS faults (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT NOT NULL REFERENCES machines(id),
    user_name   TEXT NOT NULL,
    user_role   TEXT NOT NULL,
    category    TEXT NOT NULL,
    severity    TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    resolved_by TEXT,
    resolved_at TEXT,
    downtime_hrs REAL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_trail (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT,
    user_name   TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail      TEXT,
    ip_address  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS status_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT NOT NULL REFERENCES machines(id),
    old_status  TEXT,
    new_status  TEXT NOT NULL,
    old_power   INTEGER,
    new_power   INTEGER,
    changed_by  TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS concessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT NOT NULL REFERENCES machines(id),
    type        TEXT NOT NULL,
    description TEXT NOT NULL,
    user_name   TEXT NOT NULL,
    review_by   TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Safely add the review_by column if upgrading from an older version of the schema
try { db.exec('ALTER TABLE concessions ADD COLUMN review_by TEXT'); } catch (e) { /* Ignore if it already exists */ }
try { db.exec('ALTER TABLE machines ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* Ignore if it already exists */ }
try { db.exec('ALTER TABLE machines ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* Ignore if it already exists */ }

// ── SEED DEFAULT MACHINES if table empty ─────────────────────────────

const count = db.prepare('SELECT COUNT(*) as n FROM machines').get();
if (count.n === 0) {
  const insert = db.prepare(`
    INSERT INTO machines (id, name, model, location, energy, installed, status, power)
    VALUES (@id, @name, @model, @location, @energy, @installed, @status, @power)
  `);
  const machines = [
    { id:'LA8', name:'LA8', model:'Varian TrueBeam',     location:'Treatment Room 1', energy:'6/10/15 MV',          installed:'2019', status:'none', power:0 },
    { id:'LA10', name:'LA10', model:'Varian TrueBeam',     location:'Treatment Room 2', energy:'6/10/18 MV FFF',      installed:'2018', status:'none', power:0 },
    { id:'LA11', name:'LA11', model:'Varian TrueBeamL',    location:'Treatment Room 3', energy:'7 MV (MR-guided)',    installed:'2022', status:'none', power:0 },
    { id:'LA12', name:'LA12', model:'Varian Halcyon',      location:'Treatment Room 4', energy:'6 MV FFF',            installed:'2021', status:'none', power:0 },
    { id:'HAL6',   name:'HAL6',    model:'Varian Halcyont',    location:'Treatment Room 5', energy:'6 MV',                installed:'2020', status:'none', power:0 },
    { id:'HAL7', name:'HAL7', model:'Varian Halcyone',      location:'Treatment Room 6', energy:'6/10 MV',             installed:'2024', status:'none', power:0 },
    { id:'ETHOS3', name:'ETHOS3', model:'Varian ETHOS',      location:'Treatment Room 6', energy:'6/10 MV',             installed:'2024', status:'none', power:0 },
    { id:'Definition', name:'Definition', model:'Siemens Definition',      location:'Treatment Room 6', energy:'6/10 MV',             installed:'2024', status:'none', power:0 },
    { id:'GoOpenPro', name:'GoOpenPro', model:'Siemens GoOpenPro',      location:'Treatment Room 6', energy:'6/10 MV',             installed:'2024', status:'none', power:0 }
  ];
  machines.forEach(m => insert.run(m));
  console.log('[db] Seeded default machines');
}

// Ensure all machines have a display order (useful for existing installations upgrading)
try { db.exec('UPDATE machines SET display_order = rowid WHERE display_order = 0'); } catch (e) { /* Ignore */ }

// ── SEED DEFAULT SETTINGS ─────────────────────────────────────────────
const sCount = db.prepare('SELECT COUNT(*) as n FROM settings').get();
if (sCount.n === 0) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('clinical_start', '07:00')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('clinical_end', '20:00')").run();
}
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('fault_categories', '[\"Mechanical\",\"Electrical\",\"Software\",\"Imaging / IGRT\",\"Dosimetry\",\"Safety Interlock\",\"MLC / Collimator\",\"Couch\",\"Other\"]')");
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('fault_severities', '[\"Low\",\"Medium\",\"High\",\"Critical\"]')");
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('activity_categories', '[\"Treatment session\",\"QA check\",\"Service\",\"Calibration\",\"Inspection\",\"Status change\",\"Other\"]')");
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('default_fault_category', 'Other')");
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('default_fault_severity', 'Low')");
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('default_activity_category', 'Treatment session')");
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_pwd_enabled', '0')");
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_pwd', 'admin')");

// ── QUERY HELPERS ─────────────────────────────────────────────────────

const queries = {
  // Machines
  getAllMachines: db.prepare('SELECT * FROM machines WHERE archived = 0 ORDER BY display_order ASC, rowid ASC'),
  getAllMachinesIncludingArchived: db.prepare('SELECT * FROM machines ORDER BY display_order ASC, rowid ASC'),
  getMachine:     db.prepare('SELECT * FROM machines WHERE id = ?'),
  updateStatus:   db.prepare(`
    UPDATE machines SET status = @status, updated_at = datetime('now') WHERE id = @id
  `),
  updatePower: db.prepare(`
    UPDATE machines SET power = @power, updated_at = datetime('now') WHERE id = @id
  `),
  insertMachine: db.prepare(`
    INSERT INTO machines (id, name, model, location, energy, installed, status, power, archived, display_order)
    VALUES (@id, @name, @model, @location, @energy, @installed, 'none', 0, 0, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM machines))
  `),
  updateMachine: db.prepare(`
    UPDATE machines SET name = @name, model = @model, location = @location, energy = @energy, installed = @installed, updated_at = datetime('now') WHERE id = @id
  `),
  archiveMachine: db.prepare(`
    UPDATE machines SET archived = 1, updated_at = datetime('now') WHERE id = @id
  `),
  unarchiveMachine: db.prepare(`
    UPDATE machines SET archived = 0, updated_at = datetime('now') WHERE id = @id
  `),
  updateMachineOrder: db.prepare(`
    UPDATE machines SET display_order = @display_order WHERE id = @id
  `),
  
  deleteStatusHistory: db.prepare(`DELETE FROM status_history WHERE machine_id = ?`),
  deleteActivityLog: db.prepare(`DELETE FROM activity_log WHERE machine_id = ?`),
  deleteFaults: db.prepare(`DELETE FROM faults WHERE machine_id = ?`),
  deleteConcessions: db.prepare(`DELETE FROM concessions WHERE machine_id = ?`),
  deleteAuditTrail: db.prepare(`DELETE FROM audit_trail WHERE machine_id = ?`),
  deleteMachine: db.prepare(`DELETE FROM machines WHERE id = ?`),

  // Activity log
  getActivity: db.prepare(`
    SELECT * FROM activity_log WHERE machine_id = ? ORDER BY created_at DESC LIMIT 100
  `),
  getAllActivity: db.prepare(`
    SELECT a.*, m.name as machine_name
    FROM activity_log a JOIN machines m ON a.machine_id = m.id
    ORDER BY a.created_at DESC LIMIT 200
  `),
  insertActivity: db.prepare(`
    INSERT INTO activity_log (machine_id, user_name, user_role, activity, notes)
    VALUES (@machine_id, @user_name, @user_role, @activity, @notes)
  `),

  // Faults
  getFaults: db.prepare(`
    SELECT * FROM faults WHERE machine_id = ? ORDER BY created_at DESC
  `),
  getAllFaults: db.prepare(`
    SELECT f.*, m.name as machine_name
    FROM faults f JOIN machines m ON f.machine_id = m.id
    ORDER BY f.created_at DESC
  `),
  getFaultsByPeriod: db.prepare(`
    SELECT f.*, m.name as machine_name
    FROM faults f JOIN machines m ON f.machine_id = m.id
    WHERE f.created_at >= @since
    ORDER BY f.created_at DESC
  `),
  insertFault: db.prepare(`
    INSERT INTO faults (machine_id, user_name, user_role, category, severity, description)
    VALUES (@machine_id, @user_name, @user_role, @category, @severity, @description)
  `),
  resolveFault: db.prepare(`
    UPDATE faults SET status='resolved', resolved_by=@resolved_by,
    resolved_at=datetime('now'), downtime_hrs=@downtime_hrs WHERE id=@id
  `),
  deleteFault: db.prepare(`
    DELETE FROM faults WHERE id = ?
  `),

  // Audit trail
  insertAudit: db.prepare(`
    INSERT INTO audit_trail (machine_id, user_name, action, detail, ip_address)
    VALUES (@machine_id, @user_name, @action, @detail, @ip_address)
  `),
  getAudit: db.prepare(`
    SELECT * FROM audit_trail ORDER BY created_at DESC LIMIT 500
  `),
  getAuditByPeriod: db.prepare(`
    SELECT a.*, m.name as machine_name
    FROM audit_trail a LEFT JOIN machines m ON a.machine_id = m.id
    WHERE a.created_at >= @since ORDER BY a.created_at DESC
  `),
  deleteAudit: db.prepare(`
    DELETE FROM audit_trail WHERE id = ?
  `),

  // Status history
  insertStatusHistory: db.prepare(`
    INSERT INTO status_history (machine_id, old_status, new_status, old_power, new_power, changed_by, reason)
    VALUES (@machine_id, @old_status, @new_status, @old_power, @new_power, @changed_by, @reason)
  `),
  getStatusHistory: db.prepare(`
    SELECT * FROM status_history WHERE machine_id = ? ORDER BY created_at DESC LIMIT 50
  `),
  getStatusHistoryAll: db.prepare(`
    SELECT * FROM status_history WHERE machine_id = ? ORDER BY created_at ASC
  `),
  getLastBreakdown: db.prepare(`
    SELECT * FROM status_history WHERE machine_id = ? AND new_status = 'breakdown' ORDER BY created_at DESC LIMIT 1
  `),

  // Concessions
  getActiveConcessions: db.prepare(`SELECT * FROM concessions WHERE active = 1 ORDER BY created_at DESC`),
  insertConcession: db.prepare(`INSERT INTO concessions (machine_id, type, description, user_name, review_by) VALUES (@machine_id, @type, @description, @user_name, @review_by)`),
  resolveConcession: db.prepare(`UPDATE concessions SET active = 0 WHERE id = ?`),

  // Settings
  getSettings: db.prepare(`SELECT * FROM settings`),
  updateSetting: db.prepare(`UPDATE settings SET value = @value WHERE key = @key`),

};

module.exports = { db, queries };
