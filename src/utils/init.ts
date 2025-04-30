import { initializeDatabase } from '../database/connection';
import { logger } from './logger';
import fs from 'fs';
import path from 'path';

/**
 * Initialize the database with necessary tables and initial data
 */
export async function initDB(): Promise<void> {
  try {
    // Initialize the database connection
    await initializeDatabase();
    logger.info('Database initialization completed successfully');
  } catch (error) {
    logger.error(`Database initialization error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Ensure required directories exist
 */
export function initDirectories(): void {
  const directories = [
    'uploads',
    'normalized',
    'normalized/clips'
  ];

  directories.forEach(dir => {
    const fullPath = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(fullPath)) {
      logger.info(`Creating directory: ${fullPath}`);
      fs.mkdirSync(fullPath, { recursive: true });
    }
  });
}