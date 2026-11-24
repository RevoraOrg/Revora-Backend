const fs = require('fs');
const path = require('path');
const { resolveMigrations } = require('./src/db/migrate');

const migrationsDir = path.join(__dirname, 'src/db/migrations');
const allFiles = fs.readdirSync(migrationsDir);

console.log('Testing resolveMigrations with real migration files...');
console.log('Total files:', allFiles.length);

try {
  const resolved = resolveMigrations(allFiles);
  console.log('SUCCESS: Resolved', resolved.length, 'migrations');
  console.log('First 5:', resolved.slice(0, 5));
  console.log('Last 5:', resolved.slice(-5));
} catch (error) {
  console.log('ERROR:', error.message);
  process.exit(1);
}
