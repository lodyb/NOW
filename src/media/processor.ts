import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { db } from '../database/db';
import { logFFmpegCommand, logFFmpegError } from '../utils/logger';

// Define storage paths
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const PROCESSED_DIR = path.join(process.cwd(), 'processed');
const NORMALIZED_DIR = path.join(process.cwd(), 'normalized');
const THUMBNAILS_DIR = path.join(process.cwd(), 'thumbnails');
const TEMP_DIR = path.join(process.cwd(), 'temp');

// Max file size for Discord (in MB)
export const MAX_FILE_SIZE_MB = 9;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Max processing time in milliseconds (80 seconds)
export const MAX_PROCESSING_TIME_MS = 80000;

// Create directories if they don't exist
[UPLOADS_DIR, PROCESSED_DIR, NORMALIZED_DIR, THUMBNAILS_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export interface MediaFilter {
  [key: string]: string | number | undefined;
  __raw_complex_filter?: string; // Special property for raw complex filter strings
}

export interface ClipOptions {
  duration?: string;
  start?: string;
}

export interface ProcessOptions {
  filters?: MediaFilter;
  clip?: ClipOptions;
  enforceDiscordLimit?: boolean; // Add this parameter to indicate if we need to enforce Discord's file size limit
  progressCallback?: (stage: string, progress: number) => Promise<void>; // Add callback for progress updates
}

// Define interface for media row from database
interface MediaRow {
  id: number;
  normalizedPath: string | null;
}

/**
 * Check if NVIDIA GPU encoding is available
 * @returns True if NVIDIA GPU encoding is available
 */
export const hasNvidiaGpu = async (): Promise<boolean> => {
  try {
    const output = execSync('ffmpeg -encoders | grep nvenc').toString();
    return output.includes('nvenc');
  } catch (error) {
    console.log('NVIDIA hardware encoding not available, will use software encoding');
    return false;
  }
};

/**
 * Check if file is valid (exists and is not empty)
 */
export const validFile = (filePath: string): boolean => {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch (error) {
    return false;
  }
};

/**
 * Get video dimensions using ffprobe
 */
export const getVideoDimensions = async (filePath: string): Promise<{ width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`Error getting dimensions for ${filePath}:`, err);
        resolve({ width: 0, height: 0 });
        return;
      }
      
      const stream = metadata.streams.find(s => s.codec_type === 'video');
      if (stream && stream.width && stream.height) {
        resolve({ width: stream.width, height: stream.height });
      } else {
        resolve({ width: 0, height: 0 });
      }
    });
  });
};

/**
 * Get media duration using ffprobe
 */
export const getMediaDuration = (filePath: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`Error getting duration for ${filePath}:`, err);
        resolve(0);
        return;
      }
      
      const duration = metadata.format.duration;
      resolve(duration ?? 0);
    });
  });
};

/**
 * Check if file is video or audio
 */
export const isVideoFile = async (filePath: string): Promise<boolean> => {
  // First check file extension for common audio formats
  const extension = path.extname(filePath).toLowerCase();
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus'];
  
  if (audioExtensions.includes(extension)) {
    return false;
  }
  
  // If extension check is inconclusive, use ffprobe
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`Error probing file ${filePath}:`, err);
        resolve(false); // Assume audio if we can't determine
        return;
      }
      
      const hasVideoStream = metadata.streams.some(s => s.codec_type === 'video');
      resolve(hasVideoStream);
    });
  });
};

export const processMedia = async (
  inputPath: string,
  outputFilename: string,
  options: ProcessOptions = {}
): Promise<string> => {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const outputPath = path.join(PROCESSED_DIR, outputFilename);
  
  // Check if media is video or audio
  const isVideo = await isVideoFile(inputPath);

  // Send initial status
  if (options.progressCallback) {
    await options.progressCallback("Analyzing media", 0.1);
  }

  // When Discord limit enforcement is needed, we use a different flow
  if (options.enforceDiscordLimit) {
    logFFmpegCommand(`Processing media with Discord limit enforcement: ${outputFilename}`);
    // Create a temporary file for filtered output
    const tempFiltered = path.join(TEMP_DIR, `filtered_${outputFilename}`);
    const tempCommand = ffmpeg(inputPath);
    
    // Apply any filters
    if (options.filters && Object.keys(options.filters).length > 0) {
      try {
        await options.progressCallback?.("Applying filters", 0.2);
        applyFilters(tempCommand, options.filters, isVideo);
      } catch (error) {
        throw new Error(`Error applying filters: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Apply clip options
    if (options.clip) {
      if (options.clip.start) {
        tempCommand.setStartTime(options.clip.start);
      }
      
      if (options.clip.duration) {
        tempCommand.setDuration(options.clip.duration);
      }
    }
    
    // First, create the filtered version with timeout
    await options.progressCallback?.("Creating filtered version", 0.3);
    try {
      await executeWithTimeout<void>(
        tempCommand.outputOptions('-c:a libopus').outputOptions('-b:a 128k').save(tempFiltered), 
        MAX_PROCESSING_TIME_MS,
        (progress) => {
          if (progress.percent) {
            const progressValue = 0.3 + (progress.percent / 100 * 0.3);
            options.progressCallback?.("Creating filtered version", progressValue);
          }
        }
      );
    } catch (error: unknown) {
      // Clean up any temporary files
      if (fs.existsSync(tempFiltered)) {
        try {
          fs.unlinkSync(tempFiltered);
        } catch (cleanupErr) {
          console.error(`Error cleaning up temporary filtered file: ${cleanupErr}`);
        }
      }
      
      if (error instanceof Error && error.message.includes('timeout')) {
        throw new Error(`Processing timeout: operation took too long (>80s). Try simpler filters.`);
      } else {
        throw error;
      }
    }
    
    // Now normalize the filtered version to ensure it's under Discord's limit
    try {
      await options.progressCallback?.("Optimizing for Discord", 0.6);
      const normalizedPath = await encodeMediaWithBitrates(tempFiltered, outputPath, isVideo, options.progressCallback);
      
      // Clean up the temporary filtered file
      await options.progressCallback?.("Finalizing", 0.95);
      if (fs.existsSync(tempFiltered)) {
        try {
          fs.unlinkSync(tempFiltered);
        } catch (cleanupErr) {
          console.error(`Error cleaning up temporary filtered file: ${cleanupErr}`);
        }
      }
      
      if (!normalizedPath) {
        throw new Error('Failed to normalize filtered media to fit Discord limits');
      }
      
      await options.progressCallback?.("Complete", 1.0);
      return normalizedPath;
    } catch (error: unknown) {
      // Clean up any temporary files
      if (fs.existsSync(tempFiltered)) {
        try {
          fs.unlinkSync(tempFiltered);
        } catch (cleanupErr) {
          console.error(`Error cleaning up temporary filtered file: ${cleanupErr}`);
        }
      }
      
      if (error instanceof Error && error.message.includes('timeout')) {
        throw new Error(`Processing timeout: operation took too long (>80s). Try simpler filters.`);
      } else {
        throw new Error(`Error normalizing filtered media: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    // Original behavior when Discord limit is not enforced
    const command = ffmpeg(inputPath);
  
    // Apply any filters
    if (options.filters && Object.keys(options.filters).length > 0) {
      try {
        await options.progressCallback?.("Applying filters", 0.2);
        applyFilters(command, options.filters, isVideo);
      } catch (error) {
        throw new Error(`Error applying filters: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Apply clip options
    if (options.clip) {
      if (options.clip.start) {
        command.setStartTime(options.clip.start);
      }
      
      if (options.clip.duration) {
        command.setDuration(options.clip.duration);
      }
    }
    
    // Run the command with timeout protection
    try {
      await options.progressCallback?.("Processing media", 0.3);
      
      return await new Promise((resolve, reject) => {
        let progressTracker = { percent: 0 };
        
        executeWithTimeout(
          command
            .outputOptions('-c:a libopus')
            .outputOptions('-b:a 128k')
            .save(outputPath),
          MAX_PROCESSING_TIME_MS,
          (progress) => {
            progressTracker = progress;
            if (progress.percent) {
              const progressValue = 0.3 + (progress.percent / 100 * 0.6);
              options.progressCallback?.("Processing", progressValue);
            }
          }
        )
          .then(async () => {
            await options.progressCallback?.("Complete", 1.0);
            resolve(outputPath);
          })
          .catch((err) => reject(err));
      });
    } catch (error: unknown) {
      // Clean up any output file if it exists but is incomplete
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
        } catch (cleanupErr) {
          console.error(`Error cleaning up incomplete output file: ${cleanupErr}`);
        }
      }
      
      if (error instanceof Error && error.message.includes('timeout')) {
        throw new Error(`Processing timeout: operation took too long (>80s). Try simpler filters.`);
      } else {
        throw error;
      }
    }
  }
};

/**
 * Encode media file with progressive attempts to get under file size
 */
export const encodeMediaWithAttempts = async (
  inputPath: string, 
  outputPath: string,
  isVideo: boolean
): Promise<string | null> => {
  if (!validFile(inputPath)) {
    throw new Error(`File does not exist or is empty: ${inputPath}`);
  }
  
  // Check for NVIDIA GPU
  const hasNvenc = await hasNvidiaGpu();
  
  // Get file info
  const duration = await getMediaDuration(inputPath);
  const originalSize = fs.statSync(inputPath).size;
  const originalSizeMB = (originalSize / (1024 * 1024)).toFixed(2);
  
  console.log(`Processing ${path.basename(inputPath)} (${originalSizeMB}MB, ${Math.round(duration)}s)`);
  
  // Pre-trim long media to 10 minutes to save processing time
  let inputForEncoding = inputPath;
  const preTrimPath = path.join(TEMP_DIR, `pretrim_${path.basename(inputPath)}`);
  
  if (duration > 600) {
    console.log(`Pre-trimming ${path.basename(inputPath)} to 10 minutes to optimize processing.`);
    try {
      // Use fluent-ffmpeg for pre-trimming
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .setDuration(500)
          .outputOptions('-c copy')
          .save(preTrimPath)
          .on('end', () => {
            if (validFile(preTrimPath)) {
              inputForEncoding = preTrimPath;
              console.log(`Successfully pre-trimmed to 10 minutes for faster processing`);
            }
            resolve();
          })
          .on('error', (err) => {
            console.error(`Error pre-trimming: ${err}`);
            resolve(); // Continue with original file if pre-trimming fails
          });
      });
    } catch (error) {
      console.error(`Error during pre-trim: ${error}`);
    }
  }

  let dimensions = { width: 1280, height: 720 };
  if (isVideo) {
    dimensions = await getVideoDimensions(inputForEncoding);
  }
  
  // Define encoding attempts with progressive quality reduction
  const attempts = [
    // First attempt: 720p high quality
    { 
      height: 720, 
      videoQuality: hasNvenc ? 23 : 23,    // CQ/CRF value (lower = higher quality)
      audioBitrate: isVideo ? '192k' : '192k',
      preset: hasNvenc ? 'p6' : 'medium', 
      trimDuration: null 
    },
    // Second attempt: 720p medium quality
    { 
      height: 720, 
      videoQuality: hasNvenc ? 28 : 28,    
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p6' : 'medium', 
      trimDuration: null 
    },
    // Third attempt: 360p low quality
    { 
      height: 360, 
      videoQuality: hasNvenc ? 35 : 35,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p6' : 'medium', 
      trimDuration: null 
    },
    // Fourth attempt: 360p very low quality
    { 
      height: 360, 
      videoQuality: hasNvenc ? 42 : 42,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p6' : 'medium', 
      trimDuration: null 
    },
    // Fifth attempt: 360p extremely low quality
    { 
      height: 240, 
      videoQuality: hasNvenc ? 50 : 50,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p6' : 'medium', 
      trimDuration: null 
    },
    // Sixth attempt: 240p extremely low quality + trim to 4 minutes
    { 
      height: 240, 
      videoQuality: hasNvenc ? 50 : 50,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p6' : 'medium', 
      trimDuration: 240 
    },
    // Seventh attempt: 240p extremely low quality + trim to 2 minutes
    { 
      height: 240, 
      videoQuality: hasNvenc ? 50 : 50,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p6' : 'medium', 
      trimDuration: 120 
    },
    // Eighth attempt: 240p extremely low quality + trim to 1 minute
    { 
      height: 240, 
      videoQuality: hasNvenc ? 50 : 50,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p6' : 'medium', 
      trimDuration: 60 
    }
  ];
  
  // Try each encoding attempt until one succeeds
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    
    // Skip trim attempt if file is already shorter than trim duration
    if (attempt.trimDuration && duration <= attempt.trimDuration) {
      continue;
    }
    
    console.log(`Encoding attempt ${i+1}/${attempts.length}${attempt.trimDuration ? ` with ${attempt.trimDuration}s trim` : ''}`);
    
    const tempOutputPath = path.join(TEMP_DIR, `temp_${i}_${path.basename(outputPath)}`);
    
    try {
      const command = ffmpeg(inputForEncoding);
      
      // Apply trim if specified
      if (attempt.trimDuration) {
        command.setDuration(attempt.trimDuration);
      }
      
      // Set audio settings (both for video and audio files)
      command.outputOptions('-ac 2'); // Always use stereo audio
      command.outputOptions(`-c:a libopus`);
      command.outputOptions(`-b:a ${attempt.audioBitrate}`);
      command.outputOptions('-vbr on'); // Variable bitrate for audio
      command.outputOptions('-application audio'); // Optimize for music
      
      if (isVideo) {
        // Scale video if original is larger than target resolution
        if (dimensions.width > 1280 || dimensions.height > attempt.height) {
          command.outputOptions(`-vf scale=w='min(1280,iw)':h='min(${attempt.height},ih)':force_original_aspect_ratio=decrease,format=yuv420p`);
        } else {
          command.outputOptions('-vf format=yuv420p');
        }
        
        // Use NVIDIA hardware encoding if available
        if (hasNvenc) {
          command.outputOptions('-c:v h264_nvenc');
          command.outputOptions(`-preset ${attempt.preset}`);
          command.outputOptions('-rc:v vbr'); // Variable bitrate mode
          command.outputOptions('-b:v 0'); // Pure VBR mode
          command.outputOptions(`-cq:v ${attempt.videoQuality}`); // Quality level
          command.outputOptions('-spatial-aq 1'); // Spatial adaptive quantization
          command.outputOptions('-temporal-aq 1'); // Temporal adaptive quantization
        } else {
          // Software encoding with x264
          command.outputOptions('-c:v libx264');
          command.outputOptions(`-preset ${attempt.preset}`);
          command.outputOptions(`-crf ${attempt.videoQuality}`); // Quality level for CRF mode
        }
        
        // Common video settings
        command.outputOptions('-pix_fmt yuv420p');
        command.outputOptions('-movflags +faststart');
        
        // Set output format based on extension
        command.format('mp4');
      } else {
        // Audio-only settings
        command.outputOptions('-vn'); // Remove video streams
        command.format('ogg');
      }

      // Run the encoding
      await new Promise<void>((resolve, reject) => {
        command
          .save(tempOutputPath)
          .on('end', () => resolve())
          .on('error', (err) => reject(err));
      });
      
      // Check if output file exists and is under size limit
      if (validFile(tempOutputPath)) {
        const stats = fs.statSync(tempOutputPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        if (stats.size <= MAX_FILE_SIZE_BYTES) {
          // Success - move the file to the final location
          fs.renameSync(tempOutputPath, outputPath);
          console.log(`Successfully encoded to ${fileSizeMB}MB (attempt ${i+1})`);
          
          // Clean up pre-trimmed file if it exists
          if (inputForEncoding !== inputPath && fs.existsSync(preTrimPath)) {
            try {
              fs.unlinkSync(preTrimPath);
            } catch (error) {
              console.error(`Error cleaning up pre-trimmed file: ${error}`);
            }
          }
          
          return outputPath;
        } else {
          console.log(`File still too large (${fileSizeMB}MB > ${MAX_FILE_SIZE_MB}MB), trying next settings`);
        }
      }
    } catch (error) {
      console.error(`Error in encoding attempt ${i+1}: ${error}`);
    }
  }
  
  // All attempts failed
  console.error(`Failed to encode ${path.basename(inputPath)} under ${MAX_FILE_SIZE_MB}MB after all attempts`);
  return null;
};

/**
 * Encode media file using optimized bitrate calculation
 */
export const encodeMediaWithBitrates = async (
  inputPath: string, 
  outputPath: string,
  isVideo: boolean,
  progressCallback?: (stage: string, progress: number) => Promise<void>
): Promise<string | null> => {
  if (!validFile(inputPath)) {
    throw new Error(`File does not exist or is empty: ${inputPath}`);
  }
  
  // Check for NVIDIA GPU
  const hasNvenc = await hasNvidiaGpu();
  
  // Get file info
  const duration = await getMediaDuration(inputPath);
  const originalSize = fs.statSync(inputPath).size;
  const originalSizeMB = (originalSize / (1024 * 1024)).toFixed(2);
  
  console.log(`Processing ${path.basename(inputPath)} (${originalSizeMB}MB, ${Math.round(duration)}s)`);
  
  // Calculate optimal bitrates based on content length
  const { audioBitrateKbps, videoBitrateKbps, trimDurationSeconds } = calculateBitrates(
    duration,
    isVideo,
    isVideo ? 128 : 160 // Higher audio priority for audio-only files
  );
  
  // Apply trim if needed
  const finalDuration = trimDurationSeconds ? Math.min(duration, trimDurationSeconds) : duration;
  
  // Pre-trim long media to save processing time
  let inputForEncoding = inputPath;
  if (duration > finalDuration) {
    const preTrimPath = path.join(TEMP_DIR, `pretrim_${path.basename(inputPath)}`);
    console.log(`Trimming media to ${finalDuration}s to optimize file size`);
    
    try {
      // Use timeout for the trimming operation too
      await executeWithTimeout<void>(
        ffmpeg(inputPath)
          .setDuration(finalDuration)
          .outputOptions('-c copy')
          .save(preTrimPath),
        MAX_PROCESSING_TIME_MS,
        (progress) => {
          if (progress.percent) {
            progressCallback?.("Trimming media", 0.2 + (progress.percent / 100 * 0.1));
          }
        }
      );
      
      if (validFile(preTrimPath)) {
        inputForEncoding = preTrimPath;
        console.log(`Successfully trimmed to ${finalDuration}s`);
      }
    } catch (error) {
      console.error(`Error during trim: ${error}`);
      // If timeout occurred during trimming, propagate the error
      if (error instanceof Error && error.message.includes('timeout')) {
        throw new Error(`Processing timeout: operation took too long (>80s). Try simpler filters or shorter media.`);
      }
      // Otherwise continue with the original file
    }
  }

  let dimensions = { width: 1280, height: 720 };
  if (isVideo) {
    dimensions = await getVideoDimensions(inputForEncoding);
  }
  
  console.log(`Using calculated bitrates: audio=${audioBitrateKbps}kbps, video=${videoBitrateKbps || 'n/a'}kbps`);
  
  const tempOutputPath = path.join(TEMP_DIR, `temp_${path.basename(outputPath)}`);
  
  try {
    const command = ffmpeg(inputForEncoding);
    
    // Set audio settings with loudnorm filter for consistent volume
    command.outputOptions('-ac 2'); // Always use stereo audio
    command.outputOptions(`-c:a libopus`);
    command.outputOptions(`-b:a ${audioBitrateKbps}k`);
    command.outputOptions('-vbr on'); // Variable bitrate for audio
    command.outputOptions('-application audio'); // Optimize for music
    
    // Apply loudnorm filter for audio normalization
    command.audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11');
    
    if (isVideo && videoBitrateKbps) {
      // Scale video if original is larger than target resolution
      const targetHeight = videoBitrateKbps < 400 ? 360 : 720;
      
      if (dimensions.width > 1280 || dimensions.height > targetHeight) {
        command.outputOptions(`-vf scale=w='min(1280,iw)':h='min(${targetHeight},ih)':force_original_aspect_ratio=decrease,format=yuv420p`);
      } else {
        command.outputOptions('-vf format=yuv420p');
      }
      
      // Use NVIDIA hardware encoding if available
      if (hasNvenc) {
        command.outputOptions('-c:v h264_nvenc');
        command.outputOptions(`-preset p5`); // Medium preset
        command.outputOptions('-rc:v vbr'); // Variable bitrate mode
        command.outputOptions(`-b:v ${videoBitrateKbps}k`);
        command.outputOptions('-maxrate:v 5M');
        command.outputOptions('-spatial-aq 1'); // Spatial adaptive quantization
        command.outputOptions('-temporal-aq 1'); // Temporal adaptive quantization
      } else {
        // Software encoding with x264
        command.outputOptions('-c:v libx264');
        command.outputOptions(`-preset medium`);
        command.outputOptions(`-b:v ${videoBitrateKbps}k`);
        command.outputOptions(`-maxrate ${videoBitrateKbps * 1.5}k`);
        command.outputOptions(`-bufsize ${videoBitrateKbps * 2}k`);
      }
      
      // Common video settings
      command.outputOptions('-pix_fmt yuv420p');
      command.outputOptions('-movflags +faststart');
      
      // Set output format
      command.format('mp4');
    } else {
      // Audio-only settings
      command.outputOptions('-vn'); // Remove video streams
      command.format('ogg');
    }

    // Run the encoding with timeout protection
    await executeWithTimeout<void>(
      command.save(tempOutputPath),
      MAX_PROCESSING_TIME_MS,
      (progress) => {
        if (progress.percent) {
          const progressValue = 0.6 + (progress.percent / 100 * 0.3);
          progressCallback?.("Encoding", progressValue);
        }
      }
    );
    
    // Check if output file exists and is under size limit
    if (validFile(tempOutputPath)) {
      const stats = fs.statSync(tempOutputPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      
      if (stats.size <= MAX_FILE_SIZE_BYTES) {
        // Success - move the file to the final location
        fs.renameSync(tempOutputPath, outputPath);
        console.log(`Successfully encoded to ${fileSizeMB}MB`);
        
        // Clean up pre-trimmed file if it exists
        if (inputForEncoding !== inputPath && fs.existsSync(inputForEncoding)) {
          try {
            fs.unlinkSync(inputForEncoding);
          } catch (error) {
            console.error(`Error cleaning up pre-trimmed file: ${error}`);
          }
        }
        
        return outputPath;
      } else {
        console.log(`File too large (${fileSizeMB}MB > ${MAX_FILE_SIZE_MB}MB), falling back to multi-attempt method`);
        // If bitrate calculation fails, fallback to the multi-attempt method
        return encodeMediaWithAttempts(inputPath, outputPath, isVideo);
      }
    }
  } catch (error) {
    // Clean up any temporary files
    if (fs.existsSync(tempOutputPath)) {
      try {
        fs.unlinkSync(tempOutputPath);
      } catch (cleanupErr) {
        console.error(`Error cleaning up temporary output file: ${cleanupErr}`);
      }
    }
    
    if (inputForEncoding !== inputPath && fs.existsSync(inputForEncoding)) {
      try {
        fs.unlinkSync(inputForEncoding);
      } catch (cleanupErr) {
        console.error(`Error cleaning up pre-trimmed file: ${cleanupErr}`);
      }
    }
    
    // Propagate timeout errors
    if (error instanceof Error && error.message.includes('timeout')) {
      throw new Error(`Processing timeout: operation took too long (>80s). Try simpler filters.`);
    }
    
    console.error(`Error in smart encoding: ${error}`);
    // Fallback to the traditional approach if smart encoding fails
    return encodeMediaWithAttempts(inputPath, outputPath, isVideo);
  }
  
  // If we reach here, the smart encoding failed - fall back to the traditional approach
  return encodeMediaWithAttempts(inputPath, outputPath, isVideo);
};

export const normalizeMedia = async (
  inputPath: string,
  callback?: (outputPath: string) => void
): Promise<string> => {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  // Determine if it's video or audio
  const isVideo = await isVideoFile(inputPath);
  
  // Generate normalized filename and path
  const filename = path.basename(inputPath);
  const normalizedFilename = `norm_${filename}`;
  let outputPath = path.join(NORMALIZED_DIR, normalizedFilename);
  
  // Ensure correct file extension based on media type
  if (!isVideo) {
    outputPath = outputPath.replace(/\.(wav|mp3|ogg|flac|m4a|aac)$/i, '.ogg');
  } else {
    outputPath = outputPath.replace(/\.(mp4|wmv|avi|mov|mkv|webm|flv)$/i, '.mp4');
  }
  
  console.log(`Normalizing ${path.basename(inputPath)} to ${path.basename(outputPath)}`);
  
  // Use the optimized encoding function with bitrate calculation
  const result = await encodeMediaWithBitrates(inputPath, outputPath, isVideo);
  
  if (result) {
    try {
      if (isVideo) {
        // Generate thumbnails for video files
        await generateThumbnails(result);
      } else {
        // Generate waveform for audio files
        await generateAudioWaveform(result);
      }
    } catch (error) {
      console.error(`Error generating thumbnails/waveform: ${error}`);
    }
    
    // If we have a callback function, execute it
    if (callback && typeof callback === 'function') {
      try {
        callback(result);
      } catch (error) {
        console.error(`Error in normalizeMedia callback: ${error}`);
      }
    }
    return result;
  }
  
  throw new Error(`Failed to normalize ${path.basename(inputPath)}`);
};

export const generateThumbnails = async (videoPath: string): Promise<string[]> => {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  
  // Get video duration
  const duration = await getMediaDuration(videoPath);
  if (!duration) return [];
  
  const baseFilename = path.basename(videoPath, path.extname(videoPath));
  const thumbnailPaths: string[] = [];
  
  // Generate up to 3 thumbnails, one every 30 seconds
  const count = Math.min(3, Math.ceil(duration / 30));
  
  for (let i = 0; i < count; i++) {
    // Get timestamp for screenshot (evenly distributed)
    const timestamp = i === 0 ? 2 : Math.floor((duration * i) / count);
    const thumbnailPath = path.join(THUMBNAILS_DIR, `${baseFilename}_thumb${i}.jpg`);
    
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: [timestamp],
          filename: `${baseFilename}_thumb${i}.jpg`,
          folder: THUMBNAILS_DIR,
          size: '480x?'
        })
        .on('end', () => {
          thumbnailPaths.push(`/media/thumbnails/${baseFilename}_thumb${i}.jpg`);
          resolve();
        })
        .on('error', (err) => reject(err));
    });
  }
  
  // Save thumbnail paths to database
  if (thumbnailPaths.length > 0) {
    const normalizedFilename = path.basename(videoPath);
    updateMediaThumbnails(normalizedFilename, thumbnailPaths);
  }
  
  return thumbnailPaths;
};

// Update thumbnails in database
const updateMediaThumbnails = (normalizedFilename: string, thumbnailPaths: string[]) => {
  const thumbnailsJson = JSON.stringify(thumbnailPaths);
  db.run(
    `UPDATE media SET thumbnails = ? WHERE normalizedPath LIKE ?`,
    [thumbnailsJson, `%${normalizedFilename}`],
    (err) => {
      if (err) {
        console.error(`Error updating thumbnails for ${normalizedFilename}:`, err);
      }
    }
  );
};

// Generate thumbnails for existing media without thumbnails
export const generateThumbnailsForExistingMedia = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, normalizedPath FROM media 
       WHERE normalizedPath IS NOT NULL 
       AND normalizedPath LIKE '%.mp4' 
       AND (thumbnails IS NULL OR thumbnails = '')`,
      (err, rows: MediaRow[]) => {
        if (err) {
          console.error('Error fetching media for thumbnail generation:', err);
          reject(err);
          return;
        }
        
        // Process each video to generate thumbnails
        const promises: Promise<string[]>[] = [];
        rows.forEach(row => {
          if (row.normalizedPath) {
            const fullPath = path.join(NORMALIZED_DIR, path.basename(row.normalizedPath));
            if (fs.existsSync(fullPath)) {
              const promise = generateThumbnails(fullPath)
                .then(thumbnails => {
                  console.log(`Generated ${thumbnails.length} thumbnails for media ${row.id}`);
                  return thumbnails;
                })
                .catch(error => {
                  console.error(`Failed to generate thumbnails for media ${row.id}:`, error);
                  return [];
                });
              promises.push(promise);
            }
          }
        });
        
        Promise.all(promises)
          .then(() => resolve())
          .catch(error => reject(error));
      }
    );
  });
};

export const parseFilterString = (filterString: string): MediaFilter => {
  if (!filterString.startsWith('{') || !filterString.endsWith('}')) {
    throw new Error('Invalid filter format. Expected format: {filter1=value1,filter2=value2}');
  }
  
  const content = filterString.substring(1, filterString.length - 1);
  const filters: MediaFilter = {};
  
  // Check if this is a raw complex filter string (no key=value format)
  if (!content.includes('=') || content.includes(';')) {
    // This appears to be a raw complex filter string
    filters.__raw_complex_filter = content;
    return filters;
  }
  
  // Handle complex filters with nested parameters more intelligently
  let segmentStart = 0;
  let currentKey = '';
  let inQuote = false;
  let depth = 0;
  
  for (let i = 0; i <= content.length; i++) {
    const char = i < content.length ? content[i] : ',';
    
    // Handle quotes
    if (char === "'" || char === '"') {
      inQuote = !inQuote;
      continue;
    }
    
    // Skip processing if inside quotes
    if (inQuote) continue;
    
    // Track nested structure depth
    if (char === '(') depth++;
    if (char === ')') depth--;
    
    // Process key-value pairs
    if (char === '=' && !currentKey) {
      currentKey = content.substring(segmentStart, i).trim();
      segmentStart = i + 1;
    } else if ((char === ',' && depth === 0) || i === content.length) {
      // End of segment
      if (currentKey) {
        // We have a key-value pair
        const value = content.substring(segmentStart, i).trim();
        
        // Convert to number if possible, otherwise keep as string
        const numValue = Number(value);
        filters[currentKey] = isNaN(numValue) ? value : numValue;
        
        currentKey = '';
      }
      segmentStart = i + 1;
    }
  }
  
  return filters;
};

export const parseClipOptions = (args: string[]): ClipOptions => {
  const options: ClipOptions = {};
  
  args.forEach(arg => {
    if (arg.startsWith('clip=')) {
      options.duration = arg.substring(5);
    } else if (arg.startsWith('start=')) {
      options.start = arg.substring(6);
    }
  });
  
  return options;
};

/**
 * Generate waveform thumbnail for audio files
 */
export const generateAudioWaveform = async (audioPath: string): Promise<string> => {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }
  
  try {
    const baseFilename = path.basename(audioPath, path.extname(audioPath));
    const waveformPath = path.join(THUMBNAILS_DIR, `${baseFilename}_waveform.png`);
    const spectrogramPath = path.join(THUMBNAILS_DIR, `${baseFilename}_spectrogram.png`);
    
    // Save paths to database
    const normalizedFilename = path.basename(audioPath);
    const waveformUrl = `/media/thumbnails/${baseFilename}_waveform.png`;
    const spectrogramUrl = `/media/thumbnails/${baseFilename}_spectrogram.png`;
    
    try {
      // Generate waveform with improved colors and contrast
      await new Promise<void>((resolve) => {
        ffmpeg(audioPath)
          .outputOptions([
            '-filter_complex', 'compand,showwavespic=s=640x480',
          ])
          .output(waveformPath)
          .on('end', () => {
            console.log(`Waveform generation complete for ${baseFilename}`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`Waveform generation error for ${baseFilename}:`, err);
            resolve(); // Continue despite error
          })
          .run();
      });
      
      // Generate spectrogram with improved colors and contrast
      await new Promise<void>((resolve) => {
        ffmpeg(audioPath)
          .outputOptions([
            '-lavfi', 'showspectrumpic=s=640x480',
          ])
          .output(spectrogramPath)
          .on('end', () => {
            console.log(`Spectrogram generation complete for ${baseFilename}`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`Spectrogram generation error for ${baseFilename}:`, err);
            resolve(); // Continue despite error
          })
          .run();
      });
      
      console.log(`Generated waveform and spectrogram for ${baseFilename}`);
    } catch (err) {
      console.error(`Error generating audio visualizations for ${audioPath}:`, err);
      // Continue execution despite visualization error
    }
    
    // Always update the database record whether visualizations succeeded or not
    updateMediaWaveform(normalizedFilename, [waveformUrl, spectrogramUrl]);
    
    return waveformUrl;
  } catch (err) {
    console.error(`Error in generateAudioWaveform for ${audioPath}:`, err);
    // Return empty string but don't throw error to prevent stopping the media processing
    return '';
  }
};

// Update waveform in database
const updateMediaWaveform = (normalizedFilename: string, waveformPaths: string[]) => {
  const waveformJson = JSON.stringify(waveformPaths);
  db.run(
    `UPDATE media SET thumbnails = ? WHERE normalizedPath LIKE ? AND (thumbnails IS NULL OR thumbnails = '')`,
    [waveformJson, `%${normalizedFilename}`],
    (err) => {
      if (err) {
        console.error(`Error updating waveform for ${normalizedFilename}:`, err);
      } else {
        console.log(`Updated thumbnails for ${normalizedFilename} with waveform and spectrogram`);
      }
    }
  );
};

/**
 * Scan and process all media that exists in the database but is missing normalization or thumbnails
 */
export const scanAndProcessUnprocessedMedia = async (): Promise<void> => {
  return new Promise((resolve, reject) => {
    console.log('Scanning for unprocessed media...');
    
    db.all(
      `SELECT id, title, filePath, normalizedPath, thumbnails FROM media 
       WHERE filePath IS NOT NULL 
       ORDER BY id ASC`,
      async (err, rows: any[]) => {
        if (err) {
          console.error('Error fetching media:', err);
          reject(err);
          return;
        }
        
        // Filter rows that need processing
        const toProcess = rows.filter(media => {
          // Media has no normalized path in database
          if (!media.normalizedPath) return true;
          
          // Media has normalized path in DB but file doesn't exist
          const normalizedPath = path.join(NORMALIZED_DIR, path.basename(media.normalizedPath));
          if (!fs.existsSync(normalizedPath)) return true;
          
          // Media has no thumbnails
          if (!media.thumbnails || media.thumbnails === '') return true;
          
          return false;
        });
        
        console.log(`Found ${toProcess.length} out of ${rows.length} media items that need processing.`);
        
        // Process in batches to avoid overloading the system
        const batchSize = 3;
        
        for (let i = 0; i < toProcess.length; i += batchSize) {
          const batch = toProcess.slice(i, i + batchSize);
          console.log(`Processing batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(toProcess.length/batchSize)}...`);
          
          const promises = batch.map(async (media) => {
            try {
              // Check if normalized file exists on disk
              const needsNormalization = !media.normalizedPath || 
                !fs.existsSync(path.join(NORMALIZED_DIR, path.basename(media.normalizedPath)));
              
              // Normalize media if needed
              if (needsNormalization) {
                console.log(`Normalizing media ${media.id}: ${media.title}`);
                const inputPath = path.join(UPLOADS_DIR, path.basename(media.filePath));
                
                if (fs.existsSync(inputPath)) {
                  try {
                    const normalizedPath = await normalizeMedia(inputPath, (outputPath) => {
                      // Update normalized path in database
                      updateNormalizedPathInDatabase(media.id, outputPath);
                    });
                    return { id: media.id, success: true, message: 'Media normalized' };
                  } catch (error) {
                    console.error(`Error normalizing media ${media.id}:`, error);
                    return { id: media.id, success: false, message: String(error) };
                  }
                } else {
                  console.error(`Original file not found for media ${media.id}: ${inputPath}`);
                  return { id: media.id, success: false, message: 'Original file not found' };
                }
              } 
              // Generate thumbnails for normalized media if needed
              else if (!media.thumbnails || media.thumbnails === '') {
                console.log(`Generating thumbnails for media ${media.id}: ${media.title}`);
                const normalizedPath = path.join(NORMALIZED_DIR, path.basename(media.normalizedPath));
                
                if (fs.existsSync(normalizedPath)) {
                  try {
                    // Determine if it's a video or audio and generate appropriate thumbnails
                    if (normalizedPath.endsWith('.mp4')) {
                      await generateThumbnails(normalizedPath);
                    } else if (normalizedPath.endsWith('.ogg')) {
                      await generateAudioWaveform(normalizedPath);
                    }
                    return { id: media.id, success: true, message: 'Thumbnails generated' };
                  } catch (error) {
                    console.error(`Error generating thumbnails for media ${media.id}:`, error);
                    return { id: media.id, success: false, message: String(error) };
                  }
                } else {
                  console.error(`Normalized file not found for media ${media.id}: ${normalizedPath}`);
                  return { id: media.id, success: false, message: 'Normalized file not found' };
                }
              }
            } catch (error) {
              console.error(`Error processing media ${media.id}:`, error);
              return { id: media.id, success: false, message: String(error) };
            }
          });
          
          // Wait for this batch to complete before starting the next
          await Promise.all(promises);
        }
        
        console.log('Media processing scan completed.');
        resolve();
      }
    );
  });
};

/**
 * Update normalized path in database
 */
const updateNormalizedPathInDatabase = (mediaId: number, normalizedPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Extract only the filename for storage
    const normalizedFilename = path.basename(normalizedPath);
    
    db.run(
      `UPDATE media SET normalizedPath = ? WHERE id = ?`,
      [normalizedFilename, mediaId],
      function(err) {
        if (err) {
          console.error(`Error updating normalizedPath for media ${mediaId}:`, err);
          reject(err);
        } else {
          console.log(`Updated normalizedPath for media ${mediaId}: ${normalizedFilename}`);
          resolve();
        }
      }
    );
  });
};

interface BitrateCalculation {
  audioBitrateKbps: number;
  videoBitrateKbps: number | null;
  trimDurationSeconds: number | null;
}

/**
 * Calculate optimal bitrates to fit under MAX_FILE_SIZE_BYTES
 */
const calculateBitrates = (
  durationSeconds: number,
  isVideo: boolean,
  preferredAudioKbps = 160,
  minAcceptableVideoKbps = 150
): BitrateCalculation => {
  const totalBits = MAX_FILE_SIZE_BYTES * 8 * 0.97; // 3% buffer for container overhead
  let audioBitrateKbps = preferredAudioKbps;
  let videoBitrateKbps: number | null = null;
  let trimDurationSeconds: number | null = null;

  // Calculate total available bitrate
  const totalBitrateKbps = totalBits / durationSeconds / 1000;
  
  if (!isVideo) {
    // For audio files, we can use all bitrate for audio
    audioBitrateKbps = Math.min(192, totalBitrateKbps);
    
    // If even audio-only is too big, we need to trim
    if (audioBitrateKbps < 64) {
      // Minimum acceptable audio quality
      audioBitrateKbps = 64;
      trimDurationSeconds = Math.floor(totalBits / (audioBitrateKbps * 1000));
    }
    
    return { audioBitrateKbps, videoBitrateKbps: null, trimDurationSeconds };
  }
  
  // For video files, only reduce audio if needed
  if (totalBitrateKbps < audioBitrateKbps + minAcceptableVideoKbps) {
    audioBitrateKbps = Math.max(64, totalBitrateKbps - minAcceptableVideoKbps);
  }

  videoBitrateKbps = totalBitrateKbps - audioBitrateKbps;

  // If video bitrate still too low, calculate how much to trim
  if (videoBitrateKbps < minAcceptableVideoKbps) {
    const requiredBitrate = audioBitrateKbps + minAcceptableVideoKbps;
    const newMaxDuration = totalBits / (requiredBitrate * 1000);
    trimDurationSeconds = Math.floor(newMaxDuration);
    videoBitrateKbps = minAcceptableVideoKbps;
  }

  return { audioBitrateKbps, videoBitrateKbps, trimDurationSeconds };
};

/**
 * Apply ffmpeg filters to a command
 */
const applyFilters = (command: ffmpeg.FfmpegCommand, filters: MediaFilter, isVideo: boolean): void => {
  try {
    // Log filter application attempt
    logFFmpegCommand(`Applying filters to ${isVideo ? 'video' : 'audio'} file: ${JSON.stringify(filters)}`);
    
    // Handle filter aliases (map user-friendly names to actual filter names)
    Object.keys(filters).forEach(key => {
      if (key in filterAliases) {
        const actualFilterName = filterAliases[key];
        filters[actualFilterName] = filters[key];
        delete filters[key];
        logFFmpegCommand(`Mapped filter alias '${key}' to '${actualFilterName}'`);
      }
    });
    
    // Handle raw complex filter string if it exists
    if (filters.__raw_complex_filter) {
      const rawFilter = filters.__raw_complex_filter;
      
      // Check if this is just a single effect that should be handled by our custom effects
      if (!rawFilter.includes(',')) {
        const effectName = rawFilter.trim();
        
        // Try to apply as a custom effect
        if (applyCustomEffect(command, effectName, 1, isVideo)) {
          // Custom effect was successfully applied
          logFFmpegCommand(`Applied custom effect as filter: ${effectName}`);
          return; // Skip other filter processing
        } else if (effectName in filterAliases) {
          // It's an alias to a standard filter
          const actualFilter = filterAliases[effectName];
          
          if (isVideo) {
            if (filterTypes.video.has(actualFilter)) {
              command.videoFilters(actualFilter);
            } else if (filterTypes.audio.has(actualFilter)) {
              command.audioFilters(actualFilter);
            } else {
              // Try as a complex filter
              command.complexFilter(actualFilter);
            }
          } else {
            // Audio only
            if (filterTypes.audio.has(actualFilter)) {
              command.audioFilters(actualFilter);
            } else {
              throw new Error(`The filter "${effectName}" can't be applied to audio-only files.`);
            }
          }
          
          logFFmpegCommand(`Applied aliased filter: ${actualFilter} (from ${effectName})`);
          return; // Skip other filter processing
        }
      }
      
      // Handle multiple effects
      const effectNames = rawFilter.split(',').map(part => part.trim());
      const appliedCustom = effectNames.some(name => {
        return applyCustomEffect(command, name, 1, isVideo);
      });
      
      if (appliedCustom) {
        // At least one custom effect was applied, skip normal processing
        logFFmpegCommand(`Applied custom effects from filter string: ${rawFilter}`);
        return;
      }
      
      // Otherwise, fall back to processing as a normal raw filter string 
      // Process any aliases in the raw filter string
      const processedFilter = rawFilter.split(',').map(part => {
        const trimmed = part.trim();
        if (trimmed in filterAliases) {
          return filterAliases[trimmed];
        }
        return trimmed;
      }).join(',');
      
      logFFmpegCommand(`Applying raw complex filter: ${processedFilter} (was: ${rawFilter})`);
      
      if (isVideo) {
        // For video files, we can use complex filtergraph
        command.complexFilter(processedFilter);
        return; // Skip other filter processing
      } else {
        // For audio-only files, we need to check if this is an audio-only filter
        // If it contains semicolons or otherwise appears to be a complex filter graph,
        // we need to warn the user appropriately
        if (processedFilter.includes(';') || /\[[0-9]+:[v]\]/.test(processedFilter)) {
          throw new Error(`The complex filter "${processedFilter}" appears to require video streams, but this is an audio-only file.`);
        }
        
        // Apply as audio filter if it seems audio-compatible
        command.audioFilters(processedFilter);
        return; // Skip other filter processing
      }
    }

    // Handle macroblock effect
    if ('macroblock' in filters) {
      const strength = Number(filters.macroblock) || 1;
      const qValue = Math.min(300000, Math.max(2, Math.floor(2 + (strength * 3))));
      
      if (isVideo) {
        // Apply noise filter first
        command.videoFilters('noise=alls=12:allf=t');
        
        // Use the right codec and settings for macroblock effect
        command.outputOptions('-c:v mpeg2video');
        command.outputOptions(`-q:v ${qValue}`);
        
        // If high strength, add bitstream noise filter
        if (strength > 5) {
          command.outputOptions(`-bsf:v noise=${Math.max(100, 1000000/strength)}`);
        }
      }
      
      logFFmpegCommand(`Applied macroblock effect with q:v=${qValue}`);
      delete filters.macroblock;
      // Don't return - allow filter combinations
    }

    // Handle datamosh/glitch effects with more reliable method
    if ('datamosh' in filters || 'glitch' in filters) {
      const glitchLevel = Number(filters.datamosh || filters.glitch) || 1;
      
      if (isVideo) {
        // Use simple video filter for glitch/datamosh on video - more reliable than bitstream filter
        const amount = Math.max(1, Math.min(40, Math.floor(glitchLevel * 5)));
        command.videoFilters(`noise=c0s=${amount}:c1s=${amount}:c2s=${amount}:all_seed=${Math.floor(Math.random() * 10000)}`);
      } else {
        // For audio-only files, use a more reliable audio distortion
        command.audioFilters(`afftdn=nf=-${Math.min(30, glitchLevel * 5)}`);
      }
      
      logFFmpegCommand(`Applied datamosh/glitch effect with level ${glitchLevel}`);
      delete filters.datamosh;
      delete filters.glitch;
      // Don't return - allow filter combinations
    }
    
    // Handle noise generation
    if ('noise' in filters) {
      const type = String(filters.noise).toLowerCase();
      
      if (isVideo) {
        if (type === 'mono' || type === 'bw') {
          // Black and white noise using standard filter
          command.videoFilters(`noise=c0s=20:c1s=0:c2s=0:all_seed=${Math.floor(Math.random() * 10000)}`);
        } else {
          // Colored noise using standard filter
          command.videoFilters(`noise=c0s=20:c1s=20:c2s=20:all_seed=${Math.floor(Math.random() * 10000)}`);
        }
        
        // Add audio white noise
        command.audioFilters(`aeval=0.05*random(0)`);
      } else {
        // Audio only noise
        command.audioFilters(`aeval=0.05*random(0)`);
      }
      
      logFFmpegCommand(`Applied ${type === 'mono' || type === 'bw' ? 'monochrome' : 'color'} noise filter`);
      delete filters.noise;
      // Don't return - allow filter combinations
    }
    
    // Handle pixelshift effect (forcing different pixel format)
    if ('pixelshift' in filters) {
      if (!isVideo) {
        logFFmpegCommand('Pixelshift only works with video files, skipping');
        delete filters.pixelshift;
      } else {
        const mode = String(filters.pixelshift).toLowerCase();
        // Different pixel formats to create interesting corruption effects
        const pixelFormats: Record<string, string> = {
          'rgb': 'rgb24',
          'yuv': 'yuv422p16le',
          'gray': 'gray16le',
          'bgr': 'bgr444le',
          'gbr': 'gbrp10le',
          'yuv10': 'yuv420p10le',
          'yuv16': 'yuv420p16le'
        };
        
        // Default to yuv16 if not specified
        const pixFormat = pixelFormats[mode] || 'yuv420p16le';
        
        // Use a filter to interpret the video in a different colorspace
        command.videoFilters(`format=${pixFormat},format=yuv420p`);
        
        logFFmpegCommand(`Applied pixelshift using ${pixFormat} colorspace`);
        delete filters.pixelshift;
      }
    }
    
    // Detect if we're trying to apply video filters to audio
    if (!isVideo) {
      const videoFiltersRequested = Object.keys(filters).filter(key => 
        filterTypes.video.has(key) && !filterTypes.audio.has(key)
      );
      
      if (videoFiltersRequested.length > 0) {
        const err = new Error(
          `Cannot apply video filters to audio file: ${videoFiltersRequested.join(', ')}. ` +
          `This file is audio-only and doesn't support video filters.`
        );
        logFFmpegError('Filter type mismatch', err);
        throw err;
      }
    }
    
    // Check for any filters that need special handling
    const specialFilters = [...filterTypes.complex].filter(key => key in filters);
    
    // Handle special filters first
    if (specialFilters.includes('reverse')) {
      if (isVideo) {
        // For video, reverse both audio and video streams
        command.complexFilter('[0:v]reverse[v];[0:a]areverse[a]', ['v', 'a']);
        logFFmpegCommand('Applied complex filter: reverse for video+audio');
      } else {
        // For audio, just reverse the audio stream
        command.audioFilters('areverse');
        logFFmpegCommand('Applied audio filter: areverse');
      }
      // Remove the special filter so it's not processed again
      delete filters.reverse;
    }

    // Handle speed filter (affects both audio and video timing)
    if ('speed' in filters) {
      const speedValue = Number(filters.speed);
      if (isNaN(speedValue) || speedValue <= 0) {
        throw new Error('Speed filter must be a positive number (e.g., 0.5 for half speed, 2 for double speed)');
      }

      // For video: setpts=1/speed*PTS (e.g., setpts=2*PTS for half speed)
      if (isVideo) {
        // Apply video speed filter
        command.videoFilters(`setpts=${1/speedValue}*PTS`);
        logFFmpegCommand(`Applied video speed filter: setpts=${1/speedValue}*PTS`);

        // Apply audio speed filter
        applyAudioSpeedFilter(command, speedValue);
      } else {
        // Audio-only file
        applyAudioSpeedFilter(command, speedValue);
      }

      // Remove the speed filter so it's not processed again
      delete filters.speed;
    }
    
    // Check that filters are appropriate for media type
    if (!isVideo) {
      // For audio files, only apply known audio filters
      Object.keys(filters).forEach(key => {
        if (filterTypes.video.has(key) && !filterTypes.audio.has(key)) {
          throw new Error(`Cannot apply video filter '${key}' to audio-only file.`);
        }
      });
    } 

    // Filter keys by type
    const audioFilters: string[] = [];
    const videoFilters: string[] = [];
    
    // Process remaining filters
    Object.entries(filters).forEach(([key, value]) => {
      const filterValue = typeof value === 'number' ? value.toString() : value;
      const filterStr = `${key}=${filterValue}`;
      
      // Skip filters that don't exist in our defined sets to avoid errors
      if (filterTypes.audio.has(key)) {
        audioFilters.push(filterStr);
      } else if (isVideo && filterTypes.video.has(key)) {
        videoFilters.push(filterStr);
      } else if (!filterTypes.audio.has(key) && !filterTypes.video.has(key)) {
        console.log(`Warning: ignoring unknown filter "${key}"`);
      }
    });
    
    // Apply standard filters
    if (audioFilters.length > 0) {
      const audioFilterStr = audioFilters.join(',');
      command.audioFilters(audioFilterStr);
      logFFmpegCommand(`Applied audio filters: ${audioFilterStr}`);
    }
    
    if (videoFilters.length > 0 && isVideo) {
      const videoFilterStr = videoFilters.join(',');
      command.videoFilters(videoFilterStr);
      logFFmpegCommand(`Applied video filters: ${videoFilterStr}`);
    }

    // Add custom effects to the filter system
    const customEffectKeys = Object.keys(filters).filter(key => 
      audioEffects[key.toLowerCase() as keyof typeof audioEffects] || 
      (isVideo && videoEffects[key.toLowerCase() as keyof typeof videoEffects])
    );

    if (customEffectKeys.some(key => {
      return applyCustomEffect(command, key, filters[key] || 0, isVideo);
    })) {
      // If any custom effects were applied, remove them from filters object
      customEffectKeys.forEach(key => {
        delete filters[key];
      });
    }
  } catch (error) {
    console.error(`Error in applyFilters: ${error}`);
    throw new Error(`Error applying filters: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Apply audio speed filter, handling the atempo limitations
 * atempo only works in the range of 0.5 to 2.0, so we need to chain
 * multiple atempo filters for more extreme speed changes
 */
const applyAudioSpeedFilter = (command: ffmpeg.FfmpegCommand, speedValue: number): void => {
  // Audio speed with atempo (has 0.5-2.0 limitation, so chain for extreme values)
  if (speedValue >= 0.5 && speedValue <= 2.0) {
    // Simple case - within atempo range
    command.audioFilters(`atempo=${speedValue}`);
    logFFmpegCommand(`Applied audio speed filter: atempo=${speedValue}`);
  } else if (speedValue < 0.5) {
    // Slower than 0.5x - chain multiple atempo filters
    // Example: 0.25x speed = atempo=0.5,atempo=0.5
    const filterValues = [];
    let remainingSpeed = speedValue;
    
    while (remainingSpeed < 0.5) {
      filterValues.push('atempo=0.5');
      remainingSpeed /= 0.5;
    }
    
    if (remainingSpeed < 1.0) {
      filterValues.push(`atempo=${remainingSpeed}`);
    }
    
    const filterStr = filterValues.join(',');
    command.audioFilters(filterStr);
    logFFmpegCommand(`Applied chained audio speed filter: ${filterStr}`);
  } else {
    // Faster than 2.0x - chain multiple atempo filters
    // Example: 4x speed = atempo=2.0,atempo=2.0
    const filterValues = [];
    let remainingSpeed = speedValue;
    
    while (remainingSpeed > 2.0) {
      filterValues.push('atempo=2.0');
      remainingSpeed /= 2.0;
    }
    
    if (remainingSpeed > 1.0) {
      filterValues.push(`atempo=${remainingSpeed}`);
    }
    
    const filterStr = filterValues.join(',');
    command.audioFilters(filterStr);
    logFFmpegCommand(`Applied chained audio speed filter: ${filterStr}`);
  }
};

// Filter categorization based on FFmpeg documentation
const filterTypes = {
  audio: new Set([
    'abench', 'acompressor', 'acontrast', 'acopy', 'acue', 'acrossfade', 'acrossover', 'acrusher', 
    'adeclick', 'adeclip', 'adelay', 'adenorm', 'aderivative', 'aecho', 'aemphasis', 'aeval', 
    'aexciter', 'afade', 'afftdn', 'afftfilt', 'afir', 'aformat', 'afreqshift', 'agate', 'aiir', 
    'aintegral', 'ainterleave', 'alimiter', 'allpass', 'aloop', 'amerge', 'ametadata', 'amix', 
    'amultiply', 'anequalizer', 'anlmdn', 'anlms', 'anull', 'apad', 'aperms', 'aphaser', 
    'aphaseshift', 'apulsator', 'arealtime', 'aresample', 'areverse', 'arnndn', 'aselect', 
    'asendcmd', 'asetnsamples', 'asetpts', 'asetrate', 'asettb', 'ashowinfo', 'asidedata', 
    'asoftclip', 'asplit', 'asr', 'astats', 'astreamselect', 'asubboost', 'asubcut', 'asupercut', 
    'asuperpass', 'asuperstop', 'atempo', 'atrim', 'axcorrelate', 'azmq', 'bandpass', 'bandreject', 
    'bass', 'biquad', 'bs2b', 'channelmap', 'channelsplit', 'chorus', 'compand', 'compensationdelay', 
    'crossfeed', 'crystalizer', 'dcshift', 'deesser', 'drmeter', 'dynaudnorm', 'earwax', 'ebur128', 
    'equalizer', 'extrastereo', 'firequalizer', 'flanger', 'haas', 'hdcd', 'headphone', 'highpass', 
    'highshelf', 'join', 'ladspa', 'loudnorm', 'lowpass', 'lowshelf', 'lv2', 'mcompand', 'pan', 
    'replaygain', 'rubberband', 'sidechaincompress', 'sidechaingate', 'silencedetect', 'silenceremove', 
    'sofalizer', 'speechnorm', 'stereotools', 'stereowiden', 'superequalizer', 'surround', 'treble', 
    'tremolo', 'vibrato', 'volume', 'volumedetect', 'amplify', 'pitch'
  ]),
  
  video: new Set([
    'addroi', 'alphaextract', 'alphamerge', 'amplify', 'ass', 'atadenoise', 'avgblur', 'avgblur_opencl', 
    'bbox', 'bench', 'bilateral', 'bitplanenoise', 'blackdetect', 'blackframe', 'blend', 'bm3d', 
    'boxblur', 'boxblur_opencl', 'bwdif', 'cas', 'chromahold', 'chromakey', 'chromanr', 'chromashift', 
    'ciescope', 'codecview', 'colorbalance', 'colorchannelmixer', 'colorcontrast', 'colorcorrect', 
    'colorize', 'colorkey', 'colorkey_opencl', 'colorhold', 'colorlevels', 'colormatrix', 'colorspace', 
    'colortemperature', 'convolution', 'convolution_opencl', 'convolve', 'copy', 'cover_rect', 'crop', 
    'cropdetect', 'cue', 'curves', 'datascope', 'dblur', 'dctdnoiz', 'deband', 'deblock', 'decimate', 
    'deconvolve', 'dedot', 'deflate', 'deflicker', 'deinterlace_qsv', 'deinterlace_vaapi', 'dejudder', 
    'delogo', 'denoise_vaapi', 'derain', 'deshake', 'deshake_opencl', 'despill', 'detelecine', 
    'dilation', 'dilation_opencl', 'displace', 'dnn_processing', 'doubleweave', 'drawbox', 'drawgraph', 
    'drawgrid', 'drawtext', 'edgedetect', 'elbg', 'entropy', 'epx', 'eq', 'erosion', 'erosion_opencl', 
    'estdif', 'exposure', 'extractplanes', 'fade', 'fftdnoiz', 'fftfilt', 'field', 'fieldhint', 
    'fieldmatch', 'fieldorder', 'fillborders', 'find_rect', 'floodfill', 'format', 'fps', 'framepack', 
    'framerate', 'framestep', 'freezedetect', 'freezeframes', 'frei0r', 'fspp', 'gblur', 'geq', 
    'gradfun', 'graphmonitor', 'greyedge', 'haldclut', 'hflip', 'histeq', 'histogram', 'hqdn3d', 'hqx', 
    'hstack', 'hue', 'hwdownload', 'hwmap', 'hwupload', 'hwupload_cuda', 'hysteresis', 'identity', 
    'idet', 'il', 'inflate', 'interlace', 'interleave', 'kerndeint', 'kirsch', 'lagfun', 'lenscorrection', 
    'limiter', 'loop', 'lumakey', 'lut', 'lut1d', 'lut2', 'lut3d', 'lutrgb', 'lutyuv', 'maskedclamp', 
    'maskedmax', 'maskedmerge', 'maskedmin', 'maskedthreshold', 'maskfun', 'mcdeint', 'median', 
    'mergeplanes', 'mestimate', 'metadata', 'midequalizer', 'minterpolate', 'mix', 'monochrome', 
    'mpdecimate', 'msad', 'negate', 'nlmeans', 'nlmeans_opencl', 'nnedi', 'noformat', 'noise', 
    'normalize', 'null', 'oscilloscope', 'overlay', 'overlay_opencl', 'overlay_qsv', 'overlay_cuda', 
    'owdenoise', 'pad', 'pad_opencl', 'palettegen', 'paletteuse', 'perms', 'perspective', 'phase', 
    'photosensitivity', 'pixdesctest', 'pixscope', 'pp', 'pp7', 'premultiply', 'prewitt', 'prewitt_opencl', 
    'procamp_vaapi', 'program_opencl', 'pseudocolor', 'psnr', 'pullup', 'qp', 'random', 'readeia608', 
    'readvitc', 'realtime', 'remap', 'removegrain', 'removelogo', 'repeatfields', 'reverse', 'rgbashift', 
    'roberts', 'roberts_opencl', 'rotate', 'sab', 'scale', 'scale_cuda', 'scale_qsv', 'scale_vaapi', 
    'scale2ref', 'scdet', 'scroll', 'select', 'selectivecolor', 'sendcmd', 'separatefields', 'setdar', 
    'setfield', 'setparams', 'setpts', 'setrange', 'setsar', 'settb', 'sharpness_vaapi', 'shear', 
    'showinfo', 'showpalette', 'shuffleframes', 'shufflepixels', 'shuffleplanes', 'sidedata', 
    'signalstats', 'signature', 'smartblur', 'sobel', 'sobel_opencl', 'split', 'spp', 'sr', 'ssim', 
    'stereo3d', 'streamselect', 'subtitles', 'super2xsai', 'swaprect', 'swapuv', 'tblend', 'telecine', 
    'thistogram', 'threshold', 'thumbnail', 'thumbnail_cuda', 'tile', 'tinterlace', 'tlut2', 'tmedian', 
    'tmidequalizer', 'tmix', 'tonemap', 'tonemap_opencl', 'tonemap_vaapi', 'tpad', 'transpose', 
    'transpose_opencl', 'transpose_vaapi', 'trim', 'unpremultiply', 'unsharp', 'unsharp_opencl', 
    'untile', 'uspp', 'v360', 'vaguedenoiser', 'vectorscope', 'vflip', 'vfrdet', 'vibrance', 
    'vidstabdetect', 'vidstabtransform', 'vif', 'vignette', 'vmafmotion', 'vpp_qsv', 'vstack', 
    'w3fdif', 'waveform', 'weave', 'xbr', 'xfade', 'xfade_opencl', 'xmedian', 'xstack', 'yadif', 
    'yadif_cuda', 'yaepblur', 'zmq', 'zoompan', 'zscale'
  ]),
  
  // Filters requiring special handling (complex filter syntax)
  complex: new Set(['reverse', 'speed'])
};

// Filter aliases for user-friendly alternative names
const filterAliases: Record<string, string> = {
  'fast': 'speed',
  'slow': 'speed',
  'echo': 'aecho',
  'robot': 'robotize',
  'phone': 'telephone',
  'tv': 'vhs',
  'retro': 'vhs',
  'old': 'oldfilm',
  'mirror': 'hmirror',
  'flip': 'vmirror',
  'rainbow': 'huerotate',
  'pixelate': 'pixelize',
  'dream': 'dreameffect',
  'acid': 'psychedelic',
  'wave': 'waves',
  '8bit': 'retroaudio'
};

/**
 * Execute an ffmpeg command with a timeout
 * @returns Promise that resolves when command completes or rejects if timeout/error occurs
 */
const executeWithTimeout = <T>(
  command: ffmpeg.FfmpegCommand, 
  timeoutMs: number = MAX_PROCESSING_TIME_MS,
  progressCallback?: (progress: any) => void
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let hasCompleted = false;
    
    // Keep track of the ffmpeg process ID for cleanup on timeout
    let ffmpegProcess: any = null;
    
    command.on('start', (cmdline) => {
      // Access the process more safely using type assertion
      // This is accessing a private internal property, but it's necessary for killing hung processes
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
 * Check if filters contain any video-only filters
 * @returns true if filters contain any video-only filters
 */
export const containsVideoFilters = (filters: MediaFilter): boolean => {
  // Check for special raw complex filter case
  if (filters.__raw_complex_filter) {
    // Most complex filters require video, so assume true
    return true;
  }
  
  return Object.keys(filters).some(key => 
    filterTypes.video.has(key) && !filterTypes.audio.has(key)
  );
};

// Define additional filters for audio and video effects
interface AudioEffectFunction {
  (level?: number): string;
}

interface VideoEffectFunction {
  (level?: number): string;
}

type AudioEffects = Record<string, AudioEffectFunction>;
type VideoEffects = Record<string, VideoEffectFunction>;

const audioEffects: AudioEffects = {
  'aecho': (level = 0.6) => 
    `aecho=0.8:0.8:${90 + level * 100}:0.6`, // Customizable echo effect
  
  'robotize': () => 
    'asetrate=8000,vibrato=f=5:d=0.5,aresample=8000', // Robot voice effect
  
  'telephone': () => 
    'highpass=600,lowpass=3000,equalizer=f=1200:t=q:g=10', // Telephone effect
  
  'retroaudio': () => 
    'aresample=8000,aformat=sample_fmts=u8', // 8-bit retro game audio
  
  'stutter': (rate = 0.5) => 
    `aevalsrc=0:d=${rate}:sample_rate=44100[silence];[0][silence]acrossfade=d=${rate}:c1=exp:c2=exp,atempo=1/${1-rate}`, // Stutter effect
    
  'phaser': (rate = 1) => 
    `aphaser=type=t:speed=${Math.max(0.1, rate * 0.7)}:decay=0.5`, // Phaser effect
    
  'flanger': (depth = 0.5) => 
    `flanger=delay=${Math.max(1, depth * 10)}:depth=${Math.max(1, depth * 10)}`, // Flanger effect
    
  'tremolo': (rate = 4) => 
    `tremolo=f=${Math.max(0.5, rate * 2)}:d=0.8`, // Tremolo effect
    
  'vibrato': (rate = 5) => 
    `vibrato=f=${Math.max(1, rate * 2)}:d=0.5`, // Vibrato effect
    
  'chorus': (strength = 0.5) => 
    `chorus=0.5:0.9:${50+strength*20}:0.4:0.25:2`, // Chorus effect

  'bass': (gain = 10) => 
    `bass=g=${Math.min(30, gain)}`, // Bass boost effect with gain limit
};

const videoEffects: VideoEffects = {
  'hmirror': () => 'hflip', // Simple horizontal mirror
  
  'vmirror': () => 'vflip', // Simple vertical mirror
  
  // Mirror effects
  'haah': () => 'split[a][b];[a]crop=iw/2:ih:0:0,hflip[a1];[b]crop=iw/2:ih:iw/2:0,vflip[b1];[a1][b1]hstack[top];[top][top]vstack', // Mirror left side to right
  
  'waaw': () => 'split[a][b];[a]crop=iw/2:ih:iw/2:0,hflip[left];[b][left]overlay=0:0', // Mirror right side to left
  
  'hooh': () => 'split[a][b];[a]crop=iw:ih/2:0:0[top];[top]vflip[bottom];[b][bottom]overlay=0:H/2', // Mirror top to bottom

  'woow': () => 'split[a][b];[a]crop=iw:ih/2:0:ih/2[bottom];[bottom]vflip[top];[b][top]overlay=0:0', // Mirror bottom to top
  
  'vhs': () => 
    'noise=alls=15:allf=t,curves=r=0.2:g=0.1:b=0.2,hue=h=5,colorbalance=rs=0.1:bs=-0.1,format=yuv420p,drawgrid=w=iw/24:h=2*ih:t=1:c=white@0.2', // VHS look
  
  'oldfilm': () => 
    'curves=r=0.2:g=0.1:b=0.2,noise=alls=7:allf=t,hue=h=9,eq=brightness=0.05:saturation=0.5,vignette', // Old film look
    
  'huerotate': (speed = 1) => 
    `hue=h=mod(t*${Math.max(10, speed*20)}\,360)`, // Rotating hue over time
    
  'kaleidoscope': () => 
    'split[a][b];[a]crop=iw/2:ih/2:0:0,hflip[a1];[b]crop=iw/2:ih/2:iw/2:0,vflip[b1];[a1][b1]hstack[top];[top][top]vstack', // Basic kaleidoscope
    
  'dreameffect': () => 
    'gblur=sigma=5,eq=brightness=0.1:saturation=1.5', // Dreamy blur effect
    
  'ascii': () => 
    'format=gray,scale=iw*0.2:-1,eq=brightness=0.3,boxblur=1:1,scale=iw*5:-1:flags=neighbor', // ASCII-like effect
    
  'crt': () => 
    'scale=iw:ih,pad=iw+6:ih+6:3:3:black,curves=r=0.2:g=0.1:b=0.28,drawgrid=w=iw/100:h=ih:t=1:c=black@0.4,drawgrid=w=iw:h=1:t=1:c=blue@0.2', // CRT monitor effect
    
  'psychedelic': () => 
    'hue=h=mod(t*40\,360):b=0.4,eq=contrast=2:saturation=8,gblur=sigma=5:sigmaV=5', // Psychedelic effect
    
  'slowmo': (factor = 0.5) => 
    `setpts=${Math.max(1, 1/factor)}*PTS`, // Simple slow motion effect
    
  'waves': () => 
    'noise=alls=20:allf=t,eq=contrast=1.5:brightness=-0.1:saturation=1.2', // Simpler wave effect
    
  'pixelize': (pixelSize = 0.05) => 
    `scale=iw*${Math.max(0.01, pixelSize)}:-1:flags=neighbor,scale=iw*${1/Math.max(0.01, pixelSize)}:-1:flags=neighbor`, // Pixelation effect

  // 360-degree video transformation filters
  'v360_fisheye': () => 
    'v360=equirect:fisheye:w=720:h=720',
  'v360_cube': () => 
    'v360=equirect:cube:w=1080:h=720',
  'planet': () => 
    'v360=equirect:stereographic:w=720:h=720:in_stereo=0:out_stereo=0',
  'tiny_planet': () => 
    'v360=equirect:stereographic:w=720:h=720:in_stereo=0:out_stereo=0:yaw=0:pitch=-90',
  
  // Analysis/debug filters
  'signalstats': () => 
    'signalstats=stat=all:color=cyan',
  'waveform': () => 
    'waveform=filter=lowpass:mode=column:mirror=1:display=stack:components=7',

  // Ported filters from previous implementation
  'drunk': (frames = 8) => `tmix=frames=${Math.min(48, frames)}`,
  'oscilloscope': () => 'oscilloscope=size=1:rate=1',
  'vectorscope': () => 'vectorscope=mode=color:m=color3:intensity=0.89:i=0.54',
  'mountains': () => 'aecho=0.8:0.9:500|1000:0.2|0.1',
  'whisper': () => "afftfilt=real='hypot(re,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8",
  'clipping': () => 'acrusher=.1:1:64:0:log',
  'interlace': () => 'telecine',
  'ess': () => 'deesser=i=1:s=e',
  'bass': (gain = 10) => `bass=g=${Math.min(30, gain)}`,
  'crystalizer': (intensity = 5) => `crystalizer=i=${Math.min(9.9, intensity)}`,
  '360': () => 'v360=equirect:flat',
};

// Audio-only custom effects
const audioOnlyEffects = new Set([
  'bass', 'crystalizer', 'ess', 'clipping', 'whisper', 'mountains', 
  'robotize', 'telephone', 'retroaudio', 'stutter', 'phaser', 
  'flanger', 'tremolo', 'vibrato', 'chorus'
]);

// Video-only custom effects
const videoOnlyEffects = new Set([
  'drunk', 'oscilloscope', 'vectorscope', 'interlace', '360',
  'hmirror', 'vmirror', 'vhs', 'oldfilm', 'huerotate', 'kaleidoscope',
  'dreameffect', 'ascii', 'crt', 'psychedelic', 'slowmo', 'waves',
  'pixelize', 'v360', 'v360_tiny', 'v360_fisheye', 'v360_cube',
  'planet', 'tiny_planet', 'signalstats', 'waveform'
]);

// Apply special custom effects to media
const applyCustomEffect = (command: ffmpeg.FfmpegCommand, effectName: string, value: string | number, isVideo: boolean): boolean => {
  effectName = effectName.toLowerCase();
  const numValue = typeof value === 'string' ? parseFloat(value) : value;
  
  // Handle trampoline effect (play forward then reverse)
  if (effectName === 'trampoline') {
    if (isVideo) {
      // For video, we need to duplicate the input, reverse the second copy, and concat them
      command.complexFilter(
        '[0:v]split[v1][v2];[v1]setpts=PTS[vfwd];[v2]reverse,setpts=PTS[vrev];[vfwd][vrev]concat=n=2:v=1:a=0[vout];' +
        '[0:a]asplit[a1][a2];[a1]asetpts=PTS[afwd];[a2]areverse,asetpts=PTS[arev];[afwd][arev]concat=n=2:v=0:a=1[aout]',
        ['vout', 'aout']
      );
      logFFmpegCommand('Applied trampoline effect to video (forward + reverse)');
      return true;
    } else {
      // For audio, we duplicate the input, reverse the second copy, and concat them
      command.complexFilter(
        '[0:a]asplit[a1][a2];[a1]asetpts=PTS[afwd];[a2]areverse,asetpts=PTS[arev];[afwd][arev]concat=n=2:v=0:a=1[aout]',
        ['aout']
      );
      logFFmpegCommand('Applied trampoline effect to audio (forward + reverse)');
      return true;
    }
  }
  
  // Handle special audio effects - only apply to audio stream
  if (audioOnlyEffects.has(effectName) || audioEffects[effectName as keyof typeof audioEffects]) {
    if (audioEffects[effectName as keyof typeof audioEffects]) {
      command.audioFilters(audioEffects[effectName as keyof typeof audioEffects](numValue));
      logFFmpegCommand(`Applied custom audio effect: ${effectName}`);
      return true;
    }
    return false;
  }
  
  // Handle special video effects - only apply to video stream and only for video files
  if (isVideo && (videoOnlyEffects.has(effectName) || videoEffects[effectName as keyof typeof videoEffects])) {
    // Some effects need to use complexFilter instead of videoFilters
    if (['mirror_x', 'mirror_y', 'kaleidoscope'].includes(effectName)) {
      command.complexFilter(videoEffects[effectName as keyof typeof videoEffects]());
    } else if (videoEffects[effectName as keyof typeof videoEffects]) {
      command.videoFilters(videoEffects[effectName as keyof typeof videoEffects](numValue));
    }
    logFFmpegCommand(`Applied custom video effect: ${effectName}`);
    return true;
  }
  
  return false; // Effect not found or not applicable
};