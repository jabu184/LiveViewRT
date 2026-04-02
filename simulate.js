// simulate.js - A script to generate realistic-looking usage data.
'use strict';

const { db, queries } = require('./db');

// --- CONFIGURATION ---
const SIMULATION_DAYS = 365; // Number of past days to simulate
const TICK_INTERVAL_MINUTES = 15; // Evaluate every 15 minutes
const USERS = ['A. Turing', 'G. Hopper', 'J. Bartik', 'C. Babbage', 'A. Lovelace', 'D. Knuth'];
const ROLES = ['Radiographer', 'Physicist', 'Engineer'];
const FAULT_CATEGORIES = ['Mechanical', 'Electrical', 'Software', 'Imaging / IGRT', 'Dosimetry', 'Safety Interlock', 'MLC / Collimator', 'Couch', 'Other'];
const FAULT_DESCRIPTIONS = [
    'Error code 503 displayed on console.',
    'Unusual noise coming from gantry during rotation.',
    'Couch movement is jerky and unresponsive.',
    'MV imaging panel is not acquiring images.',
    'Beam output is outside of tolerance levels.',
    'Safety interlock for door is not engaging.',
    'MLC leaf #42 is stuck in position.',
    'Software crashed during plan loading.',
    'KV source is failing to warm up correctly.'
];

// --- CUSTOM QUERIES FOR TIME TRAVEL ---
const simQueries = {
    insertStatusHistory: db.prepare(`INSERT INTO status_history (machine_id, old_status, new_status, old_power, new_power, changed_by, reason, created_at) VALUES (@machine_id, @old_status, @new_status, @old_power, @new_power, @changed_by, @reason, @created_at)`),
    updatePower: db.prepare(`UPDATE machines SET power = @power, updated_at = @updated_at WHERE id = @id`),
    updateStatus: db.prepare(`UPDATE machines SET status = @status, updated_at = @updated_at WHERE id = @id`),
    insertAudit: db.prepare(`INSERT INTO audit_trail (machine_id, user_name, action, detail, ip_address, created_at) VALUES (@machine_id, @user_name, @action, @detail, @ip_address, @created_at)`),
    insertActivity: db.prepare(`INSERT INTO activity_log (machine_id, user_name, user_role, activity, notes, created_at) VALUES (@machine_id, @user_name, @user_role, @activity, @notes, @created_at)`),
    insertFault: db.prepare(`INSERT INTO faults (machine_id, user_name, user_role, category, severity, description, created_at) VALUES (@machine_id, @user_name, @user_role, @category, @severity, @description, @created_at)`),
    resolveFault: db.prepare(`UPDATE faults SET status='resolved', resolved_by=@resolved_by, resolved_at=@resolved_at, downtime_hrs=@downtime_hrs WHERE id=@id`)
};

// Helper to pick a random item from an array
const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Helper to calculate working hours (7am-8pm, Mon-Fri) between two dates
function getWorkingHours(start, end) {
  let current = new Date(start);
  const endDt = new Date(end);
  let totalHours = 0;
  while (current < endDt) {
    let day = current.getDay();
    let hour = current.getHours();
    if (day === 0 || day === 6) { current.setHours(24, 0, 0, 0); continue; }
    if (hour < 7) { current.setHours(7, 0, 0, 0); continue; }
    if (hour >= 20) { current.setHours(24, 0, 0, 0); continue; }
    let nextBoundary = new Date(current);
    nextBoundary.setHours(20, 0, 0, 0);
    if (endDt < nextBoundary) nextBoundary = endDt;
    totalHours += (nextBoundary - current) / 3600000;
    current = nextBoundary;
  }
  return totalHours;
}

// Main simulation function
function runSimulationTick(simTime) {
    const day = simTime.getDay();
    const hour = simTime.getHours();

    // Only run during clinical hours (Mon-Fri, 7am-8pm)
    if (day === 0 || day === 6 || hour < 7 || hour >= 20) {
        return;
    }

    const machines = queries.getAllMachines.all();
    if (machines.length === 0) return;
    const sqlTime = simTime.toISOString().replace('T', ' ').substring(0, 19);

    for (const machine of machines) {
        const user = randomItem(USERS);
        const role = randomItem(ROLES);
        const diceRoll = Math.random();

        // --- Resolve Breakdowns ---
        if (machine.status === 'breakdown') { 
            if (diceRoll < 0.1) resolveBreakdown(machine, user, simTime, sqlTime);
            continue; // Skip other actions if currently broken down
        }
        
        // --- Resolve Faults ---
        const openFaults = db.prepare('SELECT * FROM faults WHERE machine_id = ? AND status = ?').all(machine.id, 'open');
        if (openFaults.length > 0 && diceRoll < 0.15) { 
            resolveFault(randomItem(openFaults), user, sqlTime);
            continue; 
        }

        // --- Generate New Events ---
        if (diceRoll < 0.0005) { // ~9 breakdowns a year per machine
            reportBreakdown(machine, user, role, sqlTime);
        } else if (diceRoll < 0.002) { // ~37 faults a year per machine
            reportFault(machine, user, role, sqlTime);
        } else if (diceRoll < 0.01) { // ~1 power toggle a day per machine
            togglePower(machine, user, sqlTime);
        } else if (diceRoll < 0.1) { // ~5 status changes a day per machine
            changeStatus(machine, user, sqlTime);
        }
    }
}

// --- ACTION FUNCTIONS ---

function togglePower(machine, user, sqlTime) {
    const newPower = machine.power ? 0 : 1;
    let newStatus = machine.status;
    if (newPower) {
        if (!['breakdown', 'service', 'maintenance'].includes(machine.status)) newStatus = 'on';
    } else {
        if (!['breakdown', 'service', 'maintenance', 'offline'].includes(machine.status)) newStatus = 'none';
    }


    simQueries.insertStatusHistory.run({ machine_id: machine.id, old_status: machine.status, new_status: newStatus, old_power: machine.power, new_power: newPower, changed_by: user, reason: 'Simulated power change', created_at: sqlTime });
    simQueries.updatePower.run({ id: machine.id, power: newPower, updated_at: sqlTime });
    if (newStatus !== machine.status) simQueries.updateStatus.run({ id: machine.id, status: newStatus, updated_at: sqlTime });
    simQueries.insertAudit.run({ machine_id: machine.id, user_name: user, action: 'POWER_CHANGE', detail: `Simulated: Machine turned ${newPower ? 'ON' : 'OFF'}`, ip_address: '127.0.0.1', created_at: sqlTime });
    simQueries.insertActivity.run({ machine_id: machine.id, user_name: user, user_role: 'System', activity: 'Power change', notes: `Power turned ${newPower ? 'ON' : 'OFF'} (simulated)`, created_at: sqlTime });
}

function changeStatus(machine, user, sqlTime) {
    if (!machine.power || machine.status === 'breakdown') return;
    
    let newStatus = machine.status;
    const diceRoll = Math.random();

    // Implement the sequential chain: service > qa > on > available (clinical) <-> treatment > offline
    if (machine.status === 'service') {
        if (diceRoll < 0.4) newStatus = 'qa';
    } else if (machine.status === 'qa') {
        if (diceRoll < 0.4) newStatus = 'on';
    } else if (machine.status === 'on') {
        if (diceRoll < 0.4) newStatus = 'available';
    } else if (machine.status === 'available') {
        if (diceRoll < 0.3) newStatus = 'treatment';
        else if (diceRoll < 0.05) newStatus = 'offline';
    } else if (machine.status === 'treatment') {
        if (diceRoll < 0.4) newStatus = 'available';
    } else if (machine.status === 'offline') {
        if (diceRoll < 0.2) newStatus = 'available';
    } else {
        const possibleStatuses = ['available', 'treatment', 'qa'];
        newStatus = randomItem(possibleStatuses);
    }

    if (newStatus === machine.status) return;

    simQueries.insertStatusHistory.run({ machine_id: machine.id, old_status: machine.status, new_status: newStatus, old_power: machine.power, new_power: machine.power, changed_by: user, reason: 'Simulated status progression', created_at: sqlTime });
    simQueries.updateStatus.run({ id: machine.id, status: newStatus, updated_at: sqlTime });
    simQueries.insertAudit.run({ machine_id: machine.id, user_name: user, action: 'STATUS_CHANGE', detail: `Simulated: ${machine.status} → ${newStatus} (progression)`, ip_address: '127.0.0.1', created_at: sqlTime });
    simQueries.insertActivity.run({ machine_id: machine.id, user_name: user, user_role: 'System', activity: 'Status change', notes: `${machine.status} → ${newStatus} (simulated progression)`, created_at: sqlTime });
}

function reportFault(machine, user, role, sqlTime) {
    const severity = randomItem(['Low', 'Medium']);

    simQueries.insertFault.run({ machine_id: machine.id, user_name: user, user_role: role, category: randomItem(FAULT_CATEGORIES), severity: severity, description: randomItem(FAULT_DESCRIPTIONS), created_at: sqlTime });
    simQueries.insertAudit.run({ machine_id: machine.id, user_name: user, action: 'FAULT_REPORTED', detail: `Simulated: [${severity}] fault`, ip_address: '127.0.0.1', created_at: sqlTime });
    simQueries.insertActivity.run({ machine_id: machine.id, user_name: user, user_role: role, activity: 'Fault reported', notes: `[${severity}] fault (simulated)`, created_at: sqlTime });
}

function reportBreakdown(machine, user, role, sqlTime) {
    if (machine.status === 'breakdown') return;

    const newStatus = 'breakdown';
    simQueries.insertFault.run({ machine_id: machine.id, user_name: user, user_role: role, category: randomItem(FAULT_CATEGORIES), severity: 'High', description: randomItem(FAULT_DESCRIPTIONS), created_at: sqlTime });
    simQueries.insertStatusHistory.run({ machine_id: machine.id, old_status: machine.status, new_status: newStatus, old_power: machine.power, new_power: machine.power, changed_by: user, reason: 'Simulated breakdown reported', created_at: sqlTime });
    simQueries.updateStatus.run({ id: machine.id, status: newStatus, updated_at: sqlTime });
    simQueries.insertAudit.run({ machine_id: machine.id, user_name: user, action: 'FAULT_REPORTED', detail: `Simulated: [High] Breakdown`, ip_address: '127.0.0.1', created_at: sqlTime });
    simQueries.insertActivity.run({ machine_id: machine.id, user_name: user, user_role: role, activity: 'Fault reported', notes: `[High] Breakdown (simulated)`, created_at: sqlTime });
}

function resolveFault(fault, user, sqlTime) {
    const downtime = (Math.random() * 4).toFixed(2);
    simQueries.resolveFault.run({ id: fault.id, resolved_by: user, downtime_hrs: downtime, resolved_at: sqlTime });
    simQueries.insertAudit.run({ machine_id: fault.machine_id, user_name: user, action: 'FAULT_RESOLVED', detail: `Simulated: Fault #${fault.id} resolved. Downtime: ${downtime}h`, ip_address: '127.0.0.1', created_at: sqlTime });
    simQueries.insertActivity.run({ machine_id: fault.machine_id, user_name: user, user_role: 'System', activity: 'Fault resolved', notes: `Fault #${fault.id} resolved (simulated)`, created_at: sqlTime });
}

function resolveBreakdown(machine, user, simTime, sqlTime) {
    const bdRecord = queries.getLastBreakdown.get(machine.id);
    let downtimeHrs = 0;
    if (bdRecord) {
        const start = new Date(bdRecord.created_at.replace(' ', 'T') + 'Z');
        downtimeHrs = getWorkingHours(start, simTime);
    }

    const newStatus = machine.power ? 'service' : 'none'; // Begin the chain at service
    simQueries.insertStatusHistory.run({ machine_id: machine.id, old_status: machine.status, new_status: newStatus, old_power: machine.power, new_power: machine.power, changed_by: user, reason: 'Simulated breakdown resolved (entering service)', created_at: sqlTime });
    simQueries.updateStatus.run({ id: machine.id, status: newStatus, updated_at: sqlTime });
    
    const detailStr = `Simulated breakdown resolved. Downtime: ${downtimeHrs.toFixed(2)}h. Machine entered ${newStatus}.`;
    simQueries.insertAudit.run({ machine_id: machine.id, user_name: user, action: 'BREAKDOWN_RESOLVED', detail: detailStr, ip_address: '127.0.0.1', created_at: sqlTime });
    simQueries.insertActivity.run({ machine_id: machine.id, user_name: user, user_role: 'System', activity: 'Breakdown resolved', notes: detailStr, created_at: sqlTime });
}

// --- START SIMULATION ---
async function runBatch() {
    console.log(`[sim] Wiping old logs to generate a clean slate...`);
    db.exec('DELETE FROM status_history');
    db.exec('DELETE FROM audit_trail');
    db.exec('DELETE FROM activity_log');
    db.exec('DELETE FROM faults');
    db.exec("UPDATE machines SET power = 1, status = 'none'");

    console.log(`[sim] Starting rapid batch simulation for the last ${SIMULATION_DAYS} days...`);
    let simTime = new Date();
    simTime.setDate(simTime.getDate() - SIMULATION_DAYS);
    simTime.setHours(7, 0, 0, 0);

    const endTime = new Date();
    let ticks = 0;

    db.exec('BEGIN TRANSACTION');
    try {
        while (simTime < endTime) {
            runSimulationTick(simTime);
            simTime = new Date(simTime.getTime() + (TICK_INTERVAL_MINUTES * 60000));
            ticks++;
        }
        db.exec('COMMIT');
        console.log(`[sim] Done! Evaluated ${ticks} simulated time steps for all machines.`);
        console.log(`[sim] You can now start your server to view exactly 1 full year of data.`);
    } catch (e) {
        db.exec('ROLLBACK');
        console.error('[sim] Error during simulation:', e);
    }
}

runBatch();
