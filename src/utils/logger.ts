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
export const logFFmpegCommand = (message: string, command?: any): void => {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  
  // Print to console
  console.log(logEntry);
  
  // Format command object if available
  let commandDetails = '';
  if (command) {
    try {
      if (command._getArguments && typeof command._getArguments === 'function') {
        try {
          const args = command._getArguments();
          commandDetails = `\nCommand: ffmpeg ${args.join(' ')}\n`;
        } catch (e) {
          commandDetails = `\nCould not extract arguments\n`;
        }
      } else {
        commandDetails = '\nCommand details not available\n';
      }
    } catch (error) {
      commandDetails = `\nCommand details unavailable\n`;
    }
  }
  
  // Write to log file
  try {
    fs.appendFileSync(
      FFMPEG_LOG_FILE,
      `${logEntry}${commandDetails}${'-'.repeat(80)}\n`,
      { encoding: 'utf8' }
    );
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
  const stack = error instanceof Error ? `\nStack: ${error.stack}\n` : '\n';
  
  // Print to console
  console.error(logEntry);
  
  // Write to log file
  try {
    fs.appendFileSync(
      ERROR_LOG_FILE,
      `${logEntry}${stack}${'-'.repeat(80)}\n`,
      { encoding: 'utf8' }
    );
  } catch (e) {
    console.error(`Error writing to error log: ${e}`);
  }
};