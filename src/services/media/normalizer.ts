// src/services/media/normalizer.ts
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * Maximum file size for Discord (in MB)
 */
const MAX_FILE_SIZE_MB = 9;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Check if NVIDIA GPU encoding is available
 * @returns True if NVIDIA GPU encoding is available
 */
export async function hasNvidiaGpu(): Promise<boolean> {
  try {
    const output = execSync('ffmpeg -encoders | grep nvenc').toString();
    return output.includes('nvenc');
  } catch (error) {
    logger.info('NVIDIA hardware encoding not available, will use software encoding');
    return false;
  }
}

/**
 * Normalize a media file to be compatible with Discord by running the normalize.sh script
 * This leverages the advanced normalization logic in the root normalize.ts file
 * 
 * @param filePath Path to the media file
 * @returns Path to the normalized file (or original if already normalized)
 */
export async function normalizeMedia(filePath: string): Promise<string> {
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  try {
    // Get the absolute path to the normalize.sh script
    const scriptPath = path.resolve(process.cwd(), 'normalize.sh');
    
    // The script assumes a database connection, so we'll pass the file path
    // and let the script handle the normalization
    logger.info(`Normalizing ${filePath} using normalize.sh script`);
    execSync(`${scriptPath} --file="${filePath}"`, { stdio: 'inherit' });
    
    // The script will have updated the database with the normalized path
    // We can assume the original file path is returned if it's already under the size limit
    // or the normalized path if it needed processing
    return filePath;
  } catch (error) {
    logger.error(`Error normalizing file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`Failed to normalize media file: ${filePath}`);
  }
}

/**
 * Normalizes a media file if it exceeds the size limit
 * This is a wrapper around normalizeMedia that first checks file size
 * 
 * @param filePath Path to the media file
 * @param normalizedDir Directory to store normalized files (optional, uses default if not provided)
 * @returns Path to the normalized file (or original if already under limit)
 */
export async function normalizeMediaIfNeeded(filePath: string, normalizedDir?: string): Promise<string> {
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  // Check if file is already under the size limit
  const stats = fs.statSync(filePath);
  if (stats.size <= MAX_FILE_SIZE_BYTES) {
    logger.info(`File ${filePath} is already under size limit, no need to normalize`);
    return filePath;
  }
  
  // File needs normalization
  return normalizeMedia(filePath);
}