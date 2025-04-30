#!/usr/bin/env node

import { cleanupDuplicateMedia } from './utils/cleanupDuplicates';
import { logger } from './utils/logger';

// Run the cleanup process
async function main() {
  logger.info('Starting the duplicate media cleanup utility');
  
  try {
    await cleanupDuplicateMedia();
    logger.info('Cleanup process completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Execute the main function
main();