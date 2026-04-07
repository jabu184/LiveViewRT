const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'data', 'rtdashboard.db');
const dbJsPath = path.join(__dirname, 'db.js');

if (!fs.existsSync(dbPath)) {
    console.error('Database not found. Make sure the app has generated the database first.');
    process.exit(1);
}

const db = new Database(dbPath);

// Extract active machines
const machines = db.prepare('SELECT * FROM machines WHERE archived = 0 ORDER BY display_order ASC, rowid ASC').all();
let machineSeedStr = `  const machines = [\n`;
machines.forEach((m, i) => {
    const esc = (str) => (str || '').replace(/`/g, "\\`").replace(/\$/g, "\\$");
    machineSeedStr += `    { id: \`${esc(m.id)}\`, name: \`${esc(m.name)}\`, model: \`${esc(m.model)}\`, location: \`${esc(m.location)}\`, energy: \`${esc(m.energy)}\`, installed: \`${esc(m.installed)}\`, status: 'none', power: 0 }${i === machines.length - 1 ? '' : ','}\n`;
});
machineSeedStr += `  ];`;

// Extract current settings
const settings = db.prepare('SELECT * FROM settings').all();
let settingsSeedStr = `const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');\n`;
settings.forEach(s => {
    const esc = (str) => (str || '').replace(/`/g, "\\`").replace(/\$/g, "\\$");
    settingsSeedStr += `insertSetting.run(\`${esc(s.key)}\`, \`${esc(s.value)}\`);\n`;
});

let dbJs = fs.readFileSync(dbJsPath, 'utf8');

const startMarker = '// ── SEED DEFAULT MACHINES if table empty ─────────────────────────────';
const endMarker = '// ── QUERY HELPERS ─────────────────────────────────────────────────────';

const startIndex = dbJs.indexOf(startMarker);
const endIndex = dbJs.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error('Could not find the seed markers in db.js!');
    process.exit(1);
}

const newMiddle = `${startMarker}\n\nconst count = db.prepare('SELECT COUNT(*) as n FROM machines').get();\nif (count.n === 0) {\n  const insert = db.prepare(\`\n    INSERT INTO machines (id, name, model, location, energy, installed, status, power)\n    VALUES (@id, @name, @model, @location, @energy, @installed, @status, @power)\n  \`);\n${machineSeedStr}\n  machines.forEach(m => insert.run(m));\n  console.log('[db] Seeded default machines from snapshot');\n}\n\ntry { db.exec('UPDATE machines SET display_order = rowid WHERE display_order = 0'); } catch (e) { /* Ignore */ }\n\n// ── SEED DEFAULT SETTINGS ─────────────────────────────────────────────\n${settingsSeedStr}\n\n`;

const newDbJs = dbJs.substring(0, startIndex) + newMiddle + dbJs.substring(endIndex);

fs.writeFileSync(dbJsPath, newDbJs, 'utf8');
console.log('✅ Successfully updated db.js with your current live configuration!');