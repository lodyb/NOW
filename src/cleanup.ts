#!/usr/bin/env node

import { cleanupDuplicateMedia } from './utils/cleanupDuplicates';
import { logger } from './utils/logger';

// Run the cleanup function
cleanupDuplicateMedia().then(() => {
  logger.info('Duplicate cleanup process completed');
  process.exit(0);
}).catch(error => {
  logger.error(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});