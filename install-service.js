const path = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name: 'LiveViewRT',
  description: 'Radiotherapy Machine Management Dashboard',
  script: path.join(__dirname, 'server.js'),
  env: [{ name: 'PORT', value: '3000' }]
});

svc.on('install', () => {
  console.log('LiveViewRT service installed successfully!');
  svc.start();
});

svc.on('alreadyinstalled', () => console.log('This service is already installed.'));
svc.on('error', err => console.error('Service error:', err));

svc.install();