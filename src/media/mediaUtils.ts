import { FFmpegCommand } from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Execute an ffmpeg command with a timeout
 * @returns Promise that resolves when command completes or rejects if timeout occurs
 */
export const executeWithTimeout = <T>(
  command: FFmpegCommand, 
  timeoutMs: number,
  progressCallback?: (progress: any) => void
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let hasCompleted = false;
    
    // Keep track of the ffmpeg process ID for cleanup on timeout
    let ffmpegProcess: any = null;
    
    command.on('start', (cmdline) => {
      // Access the process more safely
      const anyCommand = command as any;
      if (anyCommand._currentOutput?.streams?.[0]?.proc) {
        ffmpegProcess = anyCommand._currentOutput.streams[0].proc;
      }
      console.log(`Started FFmpeg process with command: ${cmdline}`);
    });
    
    if (progressCallback) {
      command.on('progress', progressCallback);
    }
    
    // Set timeout to kill the process if it takes too long
    timeoutId = setTimeout(() => {
      if (!hasCompleted && ffmpegProcess) {
        // Attempt to kill the ffmpeg process
        try {
          console.error(`FFmpeg process exceeded timeout of ${timeoutMs}ms, killing process`);
          
          if (ffmpegProcess.kill) {
            // Kill the direct process if available
            ffmpegProcess.kill('SIGKILL');
          } else {
            // Fallback to command's kill method
            command.kill('SIGKILL');
          }
        } catch (err) {
          console.error('Error killing ffmpeg process:', err);
        }
        
        hasCompleted = true;
        reject(new Error(`Processing timeout: operation took longer than ${timeoutMs/1000} seconds`));
      }
    }, timeoutMs);
    
    // Setup event handlers
    command
      .on('end', () => {
        clearTimeout(timeoutId);
        if (!hasCompleted) {
          hasCompleted = true;
          resolve(null as unknown as T);
        }
      })
      .on('error', (err) => {
        clearTimeout(timeoutId);
        if (!hasCompleted) {
          hasCompleted = true;
          reject(err);
        }
      });
  });
};

/**
 * Safely delete a file if it exists
 */
export const safeDeleteFile = async (filePath: string): Promise<void> => {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isFile()) {
      await fs.unlink(filePath);
    }
  } catch (error) {
    // Ignore errors if the file doesn't exist
    if (error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Error deleting file ${filePath}:`, error);
    }
  }
};

/**
 * Create a temporary filename in the specified directory
 */
export const createTempFilename = (originalFilename: string, prefix: string, dir: string): string => {
  const timestamp = Date.now();
  const randomString = Math.floor(Math.random() * 1000000000).toString();
  const extension = path.extname(originalFilename);
  const baseName = path.basename(originalFilename, extension);
  
  return path.join(dir, `${prefix}_${baseName}_${timestamp}_${randomString}${extension}`);
};