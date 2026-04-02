const { db } = require('./db');

const insert = db.prepare(`
  INSERT OR IGNORE INTO machines (id, name, model, location, energy, installed, status, power)
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
  { id:'GoOpenPro', name:'GoOpenPro', model:'Siemens GoOpenPro',      location:'Treatment Room 6', energy:'6/10 MV',             installed:'2024', status:'none', power:0 },
  { id:'linac5', name:'LINAC 5', model:'Varian Edge',      location:'Treatment Room 6', energy:'6/10 MV',             installed:'2024', status:'none', power:1 }
];

let added = 0;
machines.forEach(m => { const res = insert.run(m); added += res.changes; });

console.log(`Successfully restored ${added} missing machines to the database.`);