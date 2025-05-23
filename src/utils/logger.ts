import fs from 'fs';
import path from 'path';

// Create logs directory if it doesn't exist
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const FFMPEG_LOG_FILE = path.join(LOG_DIR, 'ffmpeg.log');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'error.log');
const GENERAL_LOG_FILE = path.join(LOG_DIR, 'app.log');

const logToFile = (file: string, message: string): void => {
  try {
    fs.appendFileSync(file, `${message}\n`, { encoding: 'utf8' });
  } catch (error) {
    console.error(`Error writing to log file: ${error}`);
  }
};

export const logger = {
  info: (message: string): void => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] INFO: ${message}`;
    console.log(logEntry);
    logToFile(GENERAL_LOG_FILE, logEntry);
  },

  error: (message: string, error?: any): void => {
    const timestamp = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error || '');
    const logEntry = `[${timestamp}] ERROR: ${message}${errorMessage ? `: ${errorMessage}` : ''}`;
    
    console.error(logEntry);
    logToFile(ERROR_LOG_FILE, logEntry);
  },

  debug: (message: string): void => {
    if (process.env.NODE_ENV === 'development') {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] DEBUG: ${message}`;
      console.log(logEntry);
      logToFile(GENERAL_LOG_FILE, logEntry);
    }
  },

  ffmpeg: (message: string): void => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] FFMPEG: ${message}`;
    console.log(logEntry);
    logToFile(FFMPEG_LOG_FILE, logEntry);
  }
};

// Legacy compatibility exports
export const logFFmpegCommand = (message: string): void => logger.ffmpeg(message);
export const logFFmpegError = (message: string, error: any): void => logger.error(`FFMPEG: ${message}`, error);