const { db } = require('./db');

const newMachine = { 
  id: 'linac5', 
  name: 'LINAC 5', 
  model: 'Varian Edge', 
  location: 'Treatment Room 6', 
  energy: '6/10 MV', 
  installed: '2024', 
  status: 'none', 
  power: 1 
};

db.prepare(`
  INSERT INTO machines (id, name, model, location, energy, installed, status, power)
  VALUES (@id, @name, @model, @location, @energy, @installed, @status, @power)
`).run(newMachine);

console.log(`Machine ${newMachine.name} added to the database successfully!`);