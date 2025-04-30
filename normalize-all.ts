#!/usr/bin/env node

import { initializeDatabase, AppDataSource } from './src/database/connection';
import { Media } from './src/database/entities/Media';
import { normalizeAllMedia } from './src/services/media/normalizer';
import { logger } from './src/utils/logger';
import path from 'path';
import fs from 'fs';

async function main() {
  try {
    logger.info('Starting media normalization process...');
    
    // Initialize the database connection
    await initializeDatabase();
    logger.info('Database connection established');
    
    // Create output directory if it doesn't exist
    const normalizedDir = process.env.NORMALIZED_DIR || './normalized';
    if (!fs.existsSync(normalizedDir)) {
      fs.mkdirSync(normalizedDir, { recursive: true });
    }
    
    // Create uncompressed directory if it doesn't exist
    const uncompressedDir = path.join(normalizedDir, 'uncompressed');
    if (!fs.existsSync(uncompressedDir)) {
      fs.mkdirSync(uncompressedDir, { recursive: true });
    }
    
    // Get the media repository
    const mediaRepository = AppDataSource.getRepository(Media);
    
    // Run the normalizer on all media
    logger.info('Starting batch normalization of all media files...');
    const stats = await normalizeAllMedia(mediaRepository, normalizedDir);
    
    // Log results
    logger.info(`Normalization complete. Processed ${stats.total} files.`);
    logger.info(`Successfully normalized: ${stats.success} files`);
    
    if (stats.failed.length > 0) {
      logger.warn(`Failed to normalize ${stats.failed.length} files:`);
      stats.failed.forEach(failure => logger.warn(`  - ${failure}`));
    }
    
    // Close database connection
    await AppDataSource.destroy();
    logger.info('Database connection closed');
    
  } catch (error) {
    logger.error(`Error in normalization script: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run the main function
main()
  .then(() => {
    logger.info('Normalization script completed successfully');
    process.exit(0);
  })
  .catch(error => {
    logger.error(`Unhandled error in main function: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });