// filepath: /home/lody/now/src/scripts/run-migration.ts
import { initDatabase } from '../database/db';
import { migrateNormalizedPaths } from '../database/migrations';

async function main() {
  console.log('Initializing database...');
  await initDatabase();
  
  console.log('Running normalized path migration...');
  await migrateNormalizedPaths();
  
  console.log('Migration complete!');
  process.exit(0);
}

main().catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
});