import fs from 'fs';
import path from 'path';

// Create logs directory if it doesn't exist
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const FFMPEG_LOG_FILE = path.join(LOG_DIR, 'ffmpeg.log');
const FFMPEG_ERROR_LOG_FILE = path.join(LOG_DIR, 'ffmpeg_errors.log');
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
  },

  ffmpegError: (details: {
    inputPath: string;
    outputPath?: string;
    command?: string;
    filters?: string;
    clipOptions?: string;
    error: any;
    stage?: string;
  }): void => {
    const timestamp = new Date().toISOString();
    const errorMessage = details.error instanceof Error ? details.error.message : String(details.error || '');
    
    const logEntry = [
      `[${timestamp}] FFMPEG PROCESSING FAILURE`,
      `Input: ${details.inputPath}`,
      details.outputPath ? `Output: ${details.outputPath}` : '',
      details.stage ? `Stage: ${details.stage}` : '',
      details.filters ? `Filters: ${details.filters}` : '',
      details.clipOptions ? `Clip Options: ${details.clipOptions}` : '',
      details.command ? `Command: ${details.command}` : '',
      `Error: ${errorMessage}`,
      '---'
    ].filter(line => line).join('\n');
    
    console.error(`FFmpeg processing failed: ${errorMessage}`);
    logToFile(FFMPEG_ERROR_LOG_FILE, logEntry);
  }
};

// Legacy compatibility exports
export const logFFmpegCommand = (message: string): void => logger.ffmpeg(message);
export const logFFmpegError = (message: string, error: any): void => logger.error(`FFMPEG: ${message}`, error);
export const logFFmpegProcessingError = (details: {
  inputPath: string;
  outputPath?: string;
  command?: string;
  filters?: string;
  clipOptions?: string;
  error: any;
  stage?: string;
}): void => logger.ffmpegError(details);