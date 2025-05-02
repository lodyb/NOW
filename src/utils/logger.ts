import fs from 'fs';
import path from 'path';

// Create logs directory if it doesn't exist
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const FFMPEG_LOG_FILE = path.join(LOG_DIR, 'ffmpeg.log');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'error.log');

/**
 * Log ffmpeg command information
 */
export const logFFmpegCommand = (message: string): void => {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  
  console.log(logEntry);
  
  try {
    fs.appendFileSync(FFMPEG_LOG_FILE, `${logEntry}\n`, { encoding: 'utf8' });
  } catch (error) {
    console.error(`Error writing to log file: ${error}`);
  }
};

/**
 * Log error information
 */
export const logFFmpegError = (message: string, error: any): void => {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const logEntry = `[${timestamp}] ERROR: ${message}: ${errorMessage}`;
  
  console.error(logEntry);
  
  try {
    fs.appendFileSync(
      ERROR_LOG_FILE,
      `${logEntry}\n`,
      { encoding: 'utf8' }
    );
  } catch (e) {
    console.error(`Error writing to error log: ${e}`);
  }
};