import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const FFMPEG_LOG_FILE = path.join(LOG_DIR, 'ffmpeg.log');

// Create log directory if it doesn't exist
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Log ffmpeg command information to both console and log file
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
      // Extract command details if it's a fluent-ffmpeg command
      if (command._getArguments && typeof command._getArguments === 'function') {
        try {
          const args = command._getArguments();
          commandDetails = `\nCommand: ffmpeg ${args.join(' ')}\n`;
        } catch (e) {
          commandDetails = `\nCould not extract arguments: ${e}\n`;
        }
      } else {
        commandDetails = '\nCommand object available but not extractable\n';
      }
    } catch (error) {
      commandDetails = `\nCommand details unavailable: ${error}\n`;
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
 * Log error information related to ffmpeg operations
 */
export const logFFmpegError = (message: string, error: any): void => {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const logEntry = `[${timestamp}] ERROR: ${message}: ${errorMessage}`;
  const stack = error instanceof Error ? `\nStack: ${error.stack}\n` : '\n';
  
  // Print to console with error highlight
  console.error(logEntry);
  
  // Write to log file
  try {
    fs.appendFileSync(
      FFMPEG_LOG_FILE,
      `${logEntry}${stack}${'-'.repeat(80)}\n`,
      { encoding: 'utf8' }
    );
  } catch (e) {
    console.error(`Error writing to error log: ${e}`);
  }
};