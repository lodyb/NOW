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
  [key: string]: string | number | string[] | undefined;
  __raw_complex_filter?: string; // Special property for raw complex filter strings
  __stacked_filters?: string[]; // Array of stacked filter names
  __overlay_path?: string; // Special property for overlay file path
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
  overlayAttachment?: Buffer; // Added to support message attachments for overlay
}

// Export the MediaFilter type as ParsedFilter for external use
export type ParsedFilter = MediaFilter;

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
        executeWithTimeout(
          command
            .outputOptions('-c:a libopus')
            .outputOptions('-b:a 128k')
            .save(outputPath),
          MAX_PROCESSING_TIME_MS,
          (progress) => {
            if (progress.percent !== undefined) {
              const progressValue = 0.3 + ((progress.percent || 0) / 100 * 0.6);
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
  console.error(`Failed to encode ${path.basename(inputPath)}`);
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
  let preTrimPath = '';
  
  if (duration > finalDuration) {
    preTrimPath = path.join(TEMP_DIR, `pretrim_${path.basename(inputPath)}`);
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
        if (inputForEncoding !== inputPath && fs.existsSync(preTrimPath)) {
          try {
            fs.unlinkSync(preTrimPath);
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
      async (err, rows: MediaRow[]) => {
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
                  console.error(`Error generating thumbnails for media ${row.id}:`, error);
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
  
  // Handle comma-separated list that might include random filters
  if (content.includes(',')) {
    const parts = content.split(',').map(p => p.trim().toLowerCase());
    const randomParts = parts.filter(p => p.startsWith('random'));
    const otherParts = parts.filter(p => !p.startsWith('random'));
    
    // Process random parts if found
    if (randomParts.length > 0) {
      // Get total count of random filters to apply
      const totalCount = randomParts.reduce((count, part) => {
        const split = part.split('=');
        if (split.length > 1) {
          const parsedCount = parseInt(split[1], 10);
          return count + (!isNaN(parsedCount) ? Math.min(5, Math.max(1, parsedCount)) : 1);
        }
        return count + 1;
      }, 0);
      
      // Select random filters
      const randomFilters = getRandomFilters(Math.min(5, totalCount));
      console.log(`Selected random filters: ${randomFilters.join(', ')}`);
      
      // Combine with other non-random filters
      filters.__stacked_filters = [...randomFilters, ...otherParts];
      return filters;
    }
    
    // If no random filters, process as normal stack of filters
    if (!content.includes('=')) {
      filters.__stacked_filters = parts;
      return filters;
    }
  }
  
  // Special case: Handle standalone random filter
  if (content.toLowerCase().startsWith('random')) {
    const randomOptions = content.split('=');
    let count = 1;
    
    // Check if a count parameter is specified (e.g., random=3)
    if (randomOptions.length > 1) {
      const parsedCount = parseInt(randomOptions[1], 10);
      if (!isNaN(parsedCount) && parsedCount > 0 && parsedCount <= 5) {
        count = parsedCount;
      }
    }
    
    // Set stacked filters array with randomly selected filters
    filters.__stacked_filters = getRandomFilters(count);
    console.log(`Selected random filters: ${filters.__stacked_filters.join(', ')}`);
    return filters;
  }
  
  // Check if this is a raw complex filter string (no key=value format)
  if (!content.includes('=') && !content.includes('+')) {
    // Before assuming it's a raw filter, check if it's a known custom effect
    const effectName = content.trim().toLowerCase(); // Convert to lowercase for case-insensitive comparison
    
    // Look for known audio or video effects
    const audioEffect = effectName in audioEffects;
    const videoEffect = effectName in videoEffects;
    
    if (audioEffect || videoEffect) {
      // It's a known custom effect, treat it as a stacked filter
      filters.__stacked_filters = [effectName];
      return filters;
    }
    
    // This appears to be a raw complex filter string without any key=value pairs
    filters.__raw_complex_filter = content;
    return filters;
  }
  
  // Handle stacked filters using '+' notation (e.g., {destroy8bit+chipmunk})
  if (content.includes('+') && !content.includes(',') && !content.includes('=')) {
    const stackedFilters = content.split('+');
    filters.__stacked_filters = stackedFilters.map(f => f.trim());
    return filters;
  }
  
  // Handle complex filters with nested parameters
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
      options.duration = arg.substring(arg.indexOf('=') + 1);
    } else if (arg.startsWith('start=')) {
      options.start = arg.substring(arg.indexOf('=') + 1);
    }
  });
  
  return options;
};

/**
 * Execute a command with timeout
 */
const executeWithTimeout = <T>(
  command: any, 
  timeout: number, 
  onProgress?: (progress: { percent: number | undefined }) => void
): Promise<T> => {
  let timer: NodeJS.Timeout;
  
  return new Promise<T>((resolve, reject) => {
    if (typeof command.on === 'function') {
      // Handle FFmpeg commands
      command
        .on('progress', (progress: { percent?: number }) => {
          if (onProgress && typeof progress.percent !== 'undefined') {
            onProgress({ percent: progress.percent });
          }
        })
        .on('end', () => {
          clearTimeout(timer);
          resolve({} as T);
        })
        .on('error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
      
      // Set up timeout for FFmpeg commands
      timer = setTimeout(() => {
        try {
          // Using any to access internal property
          const cmd = command as any;
          if (cmd._ffmpegProc) {
            cmd._ffmpegProc.kill('SIGTERM');
          }
        } catch (e) {
          console.error('Failed to kill FFmpeg process:', e);
        }
        reject(new Error('timeout'));
      }, timeout);
      
    } else if (command instanceof Promise) {
      // Handle regular promises
      command
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
      
      // Set up the timeout for promises
      timer = setTimeout(() => {
        reject(new Error('timeout'));
      }, timeout);
    } else {
      reject(new Error('Invalid command type passed to executeWithTimeout'));
    }
  });
};

/**
 * Execute a command with timeout and progress reporting
 */
const executeWithTimeoutAndProgress = <T>(
  command: ffmpeg.FfmpegCommand,
  timeout: number,
  onProgress: (progress: { percent: number | undefined }) => void
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    
    // Monitor the command
    command
      .on('progress', (progress) => {
        onProgress({ percent: progress.percent });
      })
      .on('end', () => {
        clearTimeout(timer);
        resolve({} as T);
      })
      .on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      })
      .run();
    
    // Set up the timeout
    timer = setTimeout(() => {
      // Using any to access internal property
      const cmd = command as any;
      if (cmd._ffmpegProc) {
        cmd._ffmpegProc.kill('SIGTERM'); // Terminate the ffmpeg process
      }
      reject(new Error('timeout'));
    }, timeout);
  });
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
                    console.error(`Error generating thumbnails for media :`, error);
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

/**
 * Get detailed media information using ffprobe
 */
export const getMediaInfo = async (filePath: string): Promise<{
  duration: number;
  width?: number;
  height?: number;
  format?: string;
  bitrate?: number;
}> => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`Error getting media info for ${filePath}:`, err);
        reject(err);
        return;
      }
      
      const result: {
        duration: number;
        width?: number;
        height?: number;
        format?: string;
        bitrate?: number;
      } = {
        duration: metadata.format.duration || 0
      };
      
      // Get video stream info if it exists
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (videoStream) {
        result.width = videoStream.width;
        result.height = videoStream.height;
      }
      
      // Format info
      result.format = metadata.format.format_name;
      result.bitrate = metadata.format.bit_rate 
        ? Number(metadata.format.bit_rate)
        : undefined;
      
      resolve(result);
    });
  });
};

// Audio and video effects definitions
export const audioEffects: Record<string, string> = {
  chipmunk: 'asetrate=44100*1.5,aresample=44100,atempo=0.75',
  echo: 'aecho=0.8:0.9:1000:0.3',
  bass: 'bass=g=10:f=110:w=0.7',
  distort: 'volume=2,vibrato=f=7:d=0.5',
  telephone: 'highpass=f=500,lowpass=f=2000',
  metallic: 'aecho=0.8:0.88:6:0.4',
  reverb: 'areverse,aecho=0.8:0.9:1000:0.3,areverse',
  nightcore: 'asetrate=44100*1.25,aresample=44100,atempo=0.85',
  underwater: 'lowpass=f=800',
  aecho: 'aecho=0.6:0.6:1000:0.5',
  robotize: 'asetrate=8000,vibrato=f=5:d=0.5,aresample=8000',
  retroaudio: 'aresample=8000,aformat=sample_fmts=u8',
  stutter: 'aevalsrc=0:d=0.5:sample_rate=44100[silence];[0][silence]acrossfade=d=0.5:c1=exp:c2=exp,atempo=2',
  phaser: 'aphaser=in_gain=0.4:out_gain=0.74:delay=3:decay=0.4:speed=0.5:type=t',
  flanger: 'flanger=delay=10:depth=10',
  tremolo: 'tremolo=f=8:d=0.8',
  vibrato: 'vibrato=f=10:d=0.5',
  chorus: 'chorus=0.5:0.9:60:0.4:0.25:2',
  bassboosted: 'bass=g=15:f=110:width_type=h',
  extremebass: 'bass=g=20:f=60:width_type=h,volume=3dB',
  distortbass: 'bass=g=18:f=80:width_type=h,volume=3dB',
  earrape: 'bass=g=15:f=60:width_type=h,treble=g=5,volume=4dB',
  clippedbass: 'bass=g=18:f=80:width_type=h,volume=2.5dB',
  saturate: 'bass=g=2,treble=g=1,volume=2',
  crunch: 'acrusher=level_in=4:level_out=1.5:bits=4:mode=log:aa=0',
  lofi: 'aresample=6000:filter_type=cubic,aresample=44100:filter_type=cubic',
  hardclip: 'acrusher=bits=4:mode=log:aa=0,bass=g=7,volume=2',
  crushcrush: 'acrusher=level_in=4:level_out=1.5:bits=3:mode=log:mix=0.4',
  deepfried: 'bass=g=8:f=100:width_type=h,acrusher=level_in=4:level_out=1.5:bits=3:mode=log:mix=1',
  destroy8bit: 'aresample=8000:filter_type=cubic,acrusher=level_in=4:level_out=1.5:bits=2:mode=log:aa=0,aresample=44100',
  nuked: 'bass=g=15:f=60:width_type=h,acrusher=level_in=4:level_out=1.5:bits=3:mode=log:aa=0,volume=6dB',
  phonk: 'bass=g=10:f=70:width_type=h,atempo=0.85,asetrate=44100*0.95,aresample=44100',
  vaporwave: 'asetrate=44100*0.8,aresample=44100,bass=g=5:f=150:width_type=h',
  alien: 'vibrato=f=8:d=1,asetrate=44100*1,aresample=44100',
  demon: 'asetrate=44100*0.7,aresample=44100',
  destroy: 'acrusher=bits=2:mode=lin:mix=1,areverse',
  bitcrush: 'acrusher=bits=4:mode=log:aa=1',
  drunk: 'vibrato=f=3:d=0.3,atempo=0.9',
  autotune: 'asetrate=44100,aresample=44100',
  distortion: 'highpass=f=1000,lowpass=f=5000,volume=3',
  haunted: 'atempo=0.9,aecho=0.8:0.8:1000|1800|500:0.7|0.5|0.3,areverse,aecho=0.8:0.8:500|1000:0.5|0.3,areverse',
  corrupt: 'afftfilt=real=\'hypot(re,im)*sin((random(0)*2)*3.14)\':imag=\'hypot(re,im)*cos((random(1)*2)*3.14)\':win_size=256:overlap=0.6',
  glitch: 'acrusher=level_in=10:level_out=1:bits=8:mode=log:aa=0,atempo=1,asetrate=44100*1.05,areverse,atempo=0.95,areverse',
  static: 'highpass=f=200,afftfilt=real=\'re*0.9\':imag=\'im*0.9\',volume=1.5',
  backwards: 'areverse',
  wobble: 'vibrato=f=2.5:d=1,tremolo=f=1:d=0.8',
  hall: 'aecho=0.8:0.9:1000|1800|2500:0.7|0.5|0.3',
  mountains: 'aecho=0.8:0.9:500|1000:0.2|0.1',
  whisper: "afftfilt=real='hypot(re,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8",
  clipping: 'acrusher=.1:1:64:0:log',
  ess: 'deesser=i=1:s=e',
  crystalizer: 'crystalizer=i=5',

  // NEW PROCEDURAL/GENERATIVE EFFECTS
  granular: 'aeval=random(1)*0.3*sin(2*PI*t*random(1)*2000)',
  glitchstep: 'aeval=if(mod(floor(t*4),2),random(1)*0.5,0)*sin(2*PI*t*440)',
  datacorrupt: 'afftfilt=real=\'if(gt(random(0),0.95),0,re)\':imag=\'if(gt(random(0),0.95),0,im)\'',
  timestretch: 'aeval=sin(2*PI*t*440*(1+0.5*sin(t*0.1)))',
  
  // NEW SYNTHESIS-STYLE EFFECTS
  vocoder: 'aeval=sin(2*PI*t*440)*((sin(2*PI*t*10)+1)/2)',
  ringmod: 'aeval=sin(2*PI*t*55)*sin(2*PI*t*440)',
  formant: 'aformat=channel_layouts=mono,aeval=\'val(0)*sin(2*PI*t*800)*sin(2*PI*t*1200)\'',
  autopan: 'apulsator=hz=0.5:width=1',
  sidechain: 'agate=threshold=0.1:ratio=2:attack=1:release=5',
  
  // NEW VST-STYLE PROCESSING
  compressor: 'acompressor=threshold=0.1:ratio=4:attack=5:release=50:makeup=2',
  limiter: 'alimiter=level_in=1:level_out=0.8:limit=0.9',
  multiband: 'crossover=split=160Hz|800Hz|4kHz[low][mid1][mid2][high];[low]acompressor=ratio=3[c1];[mid1]acompressor=ratio=2[c2];[mid2]acompressor=ratio=2[c3];[high]acompressor=ratio=4[c4];[c1][c2][c3][c4]amix=4',
  
  // NEW REAL-TIME ANALYSIS EFFECTS
  specresponse: 'showspectrum=size=640x480:mode=combined:color=rainbow:scale=log',
  volumefollow: 'volumedetect,aeval=sin(2*PI*t*440*(1+metadata.lavfi.volumedetect.mean_volume/100))',
  
  // NEW DATAMOSHING AUDIO
  bitrot: 'afftfilt=real=\'if(gt(random(0),0.98),random(1)*255,re)\':imag=\'if(gt(random(0),0.98),random(1)*255,im)\'',
  memoryerror: 'aeval=if(gt(random(0),0.995),random(1)*0.8,val(0))',
  bufferoverflow: 'adelay=delays=random(1)*100|random(1)*100',
  stackcorrupt: 'afftfilt=real=\'if(gt(random(0),0.99),re*random(1)*10,re)\':imag=\'if(gt(random(0),0.99),im*random(1)*10,im)\'',
  
  // NEW EXTREME EFFECTS
  voidecho: 'aecho=0.9:0.95:2000|4000|8000:0.8|0.6|0.4,areverse,aecho=0.8:0.9:1000:0.3,areverse',
  dimension: 'aphaser=delay=20:decay=0.8:speed=0.1,aecho=0.7:0.8:3000:0.5',
  timerift: 'atempo=0.5,areverse,atempo=2,areverse,atempo=0.8',
  quantum: 'afftfilt=real=\'hypot(re,im)*cos(random(0)*6.28)\':imag=\'hypot(re,im)*sin(random(0)*6.28)\'',
  
  // NEW VINTAGE EFFECTS
  cassettetape: 'aresample=22050,aflanger=delay=5:depth=2:regen=50,aresample=44100,highpass=f=80,lowpass=f=12000',
  vinylcrackle: 'anoise=c=pink:r=0.01,amix=inputs=2:weights=1 0.05',
  radiotuning: 'highpass=f=300+200*sin(2*PI*t*0.5),lowpass=f=3000+1000*sin(2*PI*t*0.3)',
  amradio: 'amodulate=frequency=1000+500*sin(2*PI*t*0.1)',
};

export const videoEffects: Record<string, string> = {
  invert: 'negate',
  mirror: 'hflip',
  flip: 'vflip',
  blur: 'boxblur=10:5',
  shake: 'crop=in_w:in_h:sin(n/10)*40:sin(n/15)*40',
  pixelate: 'scale=iw/20:ih/20,scale=iw*20:ih*20:flags=neighbor',
  acid: 'hue=h=sin(n/10)*360',
  crt: 'noise=c0s=13:c0f=t+u,vignette=0.2',
  hmirror: 'hflip',
  vmirror: 'vflip',
  haah: '-filter_complex',
  waaw: '-filter_complex', 
  hooh: 'split[a][b];[a]crop=iw:ih/2:0:0[top];[top]vflip[bottom];[b][bottom]overlay=0:H/2',
  woow: 'split[a][b];[a]crop=iw:ih/2:0:ih/2[bottom];[bottom]vflip[top];[b][top]overlay=0:0',
  vhs: 'noise=alls=15:allf=t,curves=r=0.2:g=0.1:b=0.2,hue=h=5,colorbalance=rs=0.1:bs=-0.1,format=yuv420p,drawgrid=w=iw/24:h=2*ih:t=1:c=white@0.2',
  oldfilm: 'curves=r=0.2:g=0.1:b=0.2,noise=alls=7:allf=t,hue=h=9,eq=brightness=0.05:saturation=0.5,vignette',
  huerotate: 'hue=h=mod(t*20\\,360)',
  kaleidoscope: 'split[a][b];[a]crop=iw/2:ih/2:0:0,hflip[a1];[b]crop=iw/2:ih/2:iw/2:0,vflip[b1];[a1][b1]hstack[top];[top][top]vstack',
  dreameffect: 'gblur=sigma=5,eq=brightness=0.1:saturation=1.5',
  ascii: 'format=gray,scale=iw*0.2:-1,eq=brightness=0.3,boxblur=1:1,scale=iw*5:-1:flags=neighbor',
  psychedelic: 'hue=h=mod(t*40\\,360):b=0.4,eq=contrast=2:saturation=8,gblur=sigma=5:sigmaV=5',
  slowmo: 'setpts=2*PTS',
  waves: 'noise=alls=20:allf=t,eq=contrast=1.5:brightness=-0.1:saturation=1.2',
  pixelize: 'scale=iw*0.05:-1:flags=neighbor,scale=iw*20:-1:flags=neighbor',
  v360_fisheye: 'v360=input=equirect:output=fisheye:w=720:h=720',
  v360_cube: 'v360=input=equirect:output=cube:w=1080:h=720',
  planet: 'v360=input=equirect:output=stereographic:w=720:h=720',
  tiny_planet: 'v360=input=equirect:output=stereographic:w=720:h=720:yaw=0:pitch=-90',
  oscilloscope: 'oscilloscope=s=1:r=1',
  signalstats: 'signalstats=stat=all:color=cyan',
  waveform: 'waveform=filter=lowpass:mode=column:mirror=1:display=stack:components=7',

  // NEW DATAMOSHING EFFECTS
  datamoshing: 'noise=alls=50:allf=t,geq=r=\'if(gt(random(1),0.98),255,r(X,Y))\':g=\'if(gt(random(1),0.98),0,g(X,Y))\':b=\'if(gt(random(1),0.98),255,b(X,Y))\'',
  scanlines: 'geq=r=\'if(mod(Y,4),r(X,Y),r(X,Y)*0.3)\':g=\'if(mod(Y,4),g(X,Y),g(X,Y)*0.3)\':b=\'if(mod(Y,4),b(X,Y),b(X,Y)*0.3)\'',
  chromashift: 'split[a][b][c];[a]lutrgb=r=0:g=0[r];[b]lutrgb=r=0:b=0[g];[c]lutrgb=g=0:b=0[b];[r][g]overlay=x=2:y=0[rg];[rg][b]overlay=x=-2:y=0',
  pixelshift: 'geq=r=\'r(X+random(1)*5-2.5,Y)\':g=\'g(X+random(1)*5-2.5,Y)\':b=\'b(X+random(1)*5-2.5,Y)\'',
  memoryglitch: 'geq=r=\'if(gt(random(1),0.99),random(1)*255,r(X,Y))\':g=\'if(gt(random(1),0.99),random(1)*255,g(X,Y))\':b=\'if(gt(random(1),0.99),random(1)*255,b(X,Y))\'',
  
  // NEW GEOMETRIC TRANSFORMATIONS
  fisheye: 'v360=input=flat:output=fisheye:w=720:h=720',
  tunnel: 'geq=r=\'r(X+50*sin(hypot(X-W/2,Y-H/2)/10),Y+50*cos(hypot(X-W/2,Y-H/2)/10))\':g=\'g(X+50*sin(hypot(X-W/2,Y-H/2)/10),Y+50*cos(hypot(X-W/2,Y-H/2)/10))\':b=\'b(X+50*sin(hypot(X-W/2,Y-H/2)/10),Y+50*cos(hypot(X-W/2,Y-H/2)/10))\'',
  spin: 'rotate=t*PI/4:c=black:ow=in_w:oh=in_h',
  zoom: 'zoompan=z=\'zoom+0.002\':d=125:x=iw/2-(iw/zoom/2):y=ih/2-(ih/zoom/2)',
  
  // NEW ADVANCED COMBINATIONS
  vintage: 'curves=r=0.2:g=0.1:b=0.2,noise=alls=7:allf=t,hue=h=9,vignette=0.3',
  cyberpunk: 'geq=r=\'if(gt(r(X,Y),128),255,0)\':g=\'if(gt(g(X,Y),128),255,g(X,Y)*2)\':b=\'255\',hue=h=180',
  hologram: 'split[a][b];[a]negate,hue=h=180[neg];[b][neg]overlay=x=2:y=2:eval=frame,noise=alls=30:allf=t',
  
  // NEW AUDIO-TO-VIDEO TRANSFORMATIONS
  audiowave: 'showwaves=s=1280x720:mode=line:colors=blue',
  audiospectrum: 'showspectrum=s=1280x720:mode=combined:color=rainbow:scale=log',
  audiofreq: 'showfreqs=s=1280x720:mode=line:colors=red',
  audiovector: 'avectorscope=s=1280x720:mode=lissajous:zoom=2',
  
  // NEW RETRO EFFECTS
  commodore64: 'scale=320:200:flags=neighbor,lutrgb=r=\'if(lt(val,64),0,if(lt(val,128),85,if(lt(val,192),170,255)))\':g=\'if(lt(val,64),0,if(lt(val,128),85,if(lt(val,192),170,255)))\':b=\'if(lt(val,64),0,if(lt(val,128),85,if(lt(val,192),170,255)))\',scale=1280:720:flags=neighbor',
  gameboy: 'format=gray,scale=160:144:flags=neighbor,lutrgb=\'if(lt(val,64),15,if(lt(val,128),56,if(lt(val,192),139,199)))\',scale=1280:720:flags=neighbor',
  nes: 'scale=256:240:flags=neighbor,lutrgb=r=\'floor(val/32)*32\':g=\'floor(val/32)*32\':b=\'floor(val/32)*32\',scale=1280:720:flags=neighbor'
};

/**
 * Calculate optimal bitrates based on content length and target file size
 */
const calculateBitrates = (
  durationSeconds: number,
  isVideo: boolean,
  audioQualityPriority: number = 128
): { audioBitrateKbps: number; videoBitrateKbps: number | undefined; trimDurationSeconds: number | null } => {
  // Target file size in kilobytes (slightly under Discord limit)
  const targetKB = MAX_FILE_SIZE_MB * 1024 * 0.95;
  
  // Get maximum duration
  // For long files, we may need to trim
  let trimDuration: number | null = null;
  let duration = durationSeconds;
  
  // If the audio or video is longer than 8 minutes, trim it to optimize quality
  if (duration > 480) {
    trimDuration = 480;
    duration = 480;
    console.log(`Content too long, will trim to ${trimDuration}s`);
  }
  
  if (isVideo) {
    // For video, allocate bitrate between audio and video
    // We'll assign 70-80% to video and the rest to audio
    // But ensure audio always gets at least the priority value
    
    // Calculate total bitrate in kbps (8 bits per byte)
    const totalBitrateKbps = Math.floor((targetKB * 8) / duration);
    
    // Calculate audio bitrate (10-20% of total, minimum audioQualityPriority kbps)
    let audioBitrateKbps = Math.max(
      audioQualityPriority,
      Math.floor(totalBitrateKbps * 0.15)
    );
    
    // Cap audio at 196 kbps (diminishing returns beyond this for most content)
    audioBitrateKbps = Math.min(audioBitrateKbps, 196);
    
    // Remaining bitrate for video
    let videoBitrateKbps = Math.max(300, totalBitrateKbps - audioBitrateKbps);
    
    // Cap video bitrate based on duration
    // Longer videos get lower bitrates
    if (duration > 240) {  // > 4 min
      videoBitrateKbps = Math.min(videoBitrateKbps, 1500);
    } else if (duration > 120) {  // > 2 min
      videoBitrateKbps = Math.min(videoBitrateKbps, 2500);
    } else {  // < 2 min
      videoBitrateKbps = Math.min(videoBitrateKbps, 4000);
    }
    
    console.log(`Calculated bitrates for ${duration}s video: audio=${audioBitrateKbps}kbps, video=${videoBitrateKbps}kbps`);
    
    return {
      audioBitrateKbps,
      videoBitrateKbps,
      trimDurationSeconds: trimDuration
    };
  } else {
    // For audio-only, use a higher bitrate
    let audioBitrateKbps = Math.floor((targetKB * 8) / duration);
    
    // Cap audio based on duration
    if (duration > 240) {  // > 4 min
      audioBitrateKbps = Math.min(audioBitrateKbps, 128);
    } else if (duration > 120) {  // > 2 min
      audioBitrateKbps = Math.min(audioBitrateKbps, 160);
    } else {  // < 2 min
      audioBitrateKbps = Math.min(audioBitrateKbps, 192);
    }
    
    // Ensure minimum quality
    audioBitrateKbps = Math.max(audioBitrateKbps, 96);
    
    console.log(`Calculated bitrate for ${duration}s audio: ${audioBitrateKbps}kbps`);
    
    return {
      audioBitrateKbps,
      videoBitrateKbps: undefined,
      trimDurationSeconds: trimDuration
    };
  }
};

/**
 * Apply audio/video filters to an ffmpeg command
 */
const applyFilters = (
  command: ffmpeg.FfmpegCommand,
  filters: MediaFilter,
  isVideo: boolean
): void => {
  // Handle macroblock effect (needs special handling before other filters)
  let hasMacroblock = false;
  let macroBlockStrength = 0;
  
  if ('macroblock' in filters) {
    hasMacroblock = true;
    macroBlockStrength = Number(filters.macroblock) || 1;
    
    if (isVideo) {
      console.log(`Applying macroblock effect (strength: ${macroBlockStrength})`);
      // Apply noise filter first
      command.videoFilters('noise=alls=12:allf=t');
      
      // Use the right codec and settings for macroblock effect
      command.outputOptions('-c:v mpeg2video');
      command.outputOptions(`-q:v ${Math.min(300000, Math.max(2, Math.floor(2 + (macroBlockStrength * 3))))}`);
      
      // If high strength, add bitstream noise filter
      if (macroBlockStrength > 5) {
        command.outputOptions(`-bsf:v noise=${Math.max(100, 1000000/macroBlockStrength)}`);
      }
      
      console.log(`Applied macroblock effect with q:v=${Math.min(300000, Math.max(2, Math.floor(2 + (macroBlockStrength * 3))))}`);
    }
    
    // Don't delete the macroblock filter here, it will be removed after all processing
  }

  // Handle stacked filters
  if (filters.__stacked_filters && filters.__stacked_filters.length > 0) {
    const stackedFilters = filters.__stacked_filters;
    console.log(`Processing stacked filters: ${stackedFilters.join(', ')}`);
    
    // Check if macroblock is among the stacked filters (special case)
    let hasMacroblock = false;
    let macroBlockStrength = 0;
    const nonMacroblockFilters = stackedFilters.filter(filter => {
      const isMacroblock = filter.startsWith('macroblock');
      if (isMacroblock) {
        hasMacroblock = true;
        const strengthMatch = filter.match(/macroblock=(\d+)/);
        if (strengthMatch && strengthMatch[1]) {
          macroBlockStrength = Number(strengthMatch[1]) || 1;
        } else {
          macroBlockStrength = 1;
        }
      }
      return !isMacroblock;
    });
    
    // Group filters by type (audio/video) for proper chaining
    const audioFilterNames: string[] = [];
    const videoFilterNames: string[] = [];

    // Organize filters by type
    nonMacroblockFilters.forEach(filterName => {
      const filterNameLower = filterName.toLowerCase().trim();
      
      if (filterNameLower in audioEffects) {
        audioFilterNames.push(filterNameLower);
      }
      
      if (isVideo && filterNameLower in videoEffects) {
        videoFilterNames.push(filterNameLower);
      }
    });
    
    console.log(`Found ${audioFilterNames.length} audio filters: ${audioFilterNames.join(', ')}`);
    
    // Apply video noise and codec settings for macroblock if needed
    if (hasMacroblock && isVideo) {
      console.log(`Applying macroblock effect (strength: ${macroBlockStrength})`);
      // Apply noise filter first
      command.videoFilters('noise=alls=12:allf=t');
      
      // Use the right codec and settings for macroblock effect
      command.outputOptions('-c:v mpeg2video');
      command.outputOptions(`-q:v ${Math.min(300000, Math.max(2, Math.floor(2 + (macroBlockStrength * 3))))}`);
      
      // If high strength, add bitstream noise filter
      if (macroBlockStrength > 5) {
        command.outputOptions(`-bsf:v noise=${Math.max(100, 1000000/macroBlockStrength)}`);
      }
      console.log(`Applied macroblock effect with q:v=${Math.min(300000, Math.max(2, Math.floor(2 + (macroBlockStrength * 3))))}`);
    }
    
    // Handle audio filters - this runs even when macroblock is present
    if (audioFilterNames.length > 0) {
      console.log(`Processing ${audioFilterNames.length} audio filters sequentially`);
      
      // Apply each filter individually in sequence
      audioFilterNames.forEach((filterName, index) => {
        console.log(`Applying audio filter ${index + 1}/${audioFilterNames.length}: ${filterName}`);
        command.audioFilters(audioEffects[filterName]);
      });
    }
    
    // Apply special complex video filters separately
    if (isVideo) {
      for (const filterName of videoFilterNames) {
        if (['haah', 'waaw', 'kaleidoscope', 'v360_cube', 'planet', 'tiny_planet', 'oscilloscope', 'audiowave', 'audiospectrum', 'audiofreq', 'audiovector'].includes(filterName)) {
          console.log(`Applying complex video effect: ${filterName}`);
          applyComplexVideoFilter(command, filterName);
        }
      }
      
      // Apply regular video filters as a combined chain
      const regularVideoFilters = videoFilterNames.filter(name => 
        !['haah', 'waaw', 'kaleidoscope', 'v360_cube', 'planet', 'tiny_planet', 'oscilloscope', 'audiowave', 'audiospectrum', 'audiofreq', 'audiovector'].includes(name));
      
      if (regularVideoFilters.length > 0) {
        const videoFilterStrings = regularVideoFilters.map(name => videoEffects[name]);
        const combinedVideoFilters = videoFilterStrings.join(',');
        console.log(`Applying chained video filters: ${combinedVideoFilters}`);
        command.videoFilters(combinedVideoFilters);
      }
    }
    
    return;
  }
  
  // Handle raw complex filter
  if (filters.__raw_complex_filter) {
    const rawFilter = filters.__raw_complex_filter.trim();
    if (rawFilter) {
      // Apply as video or audio filter based on content
      if (isAudioFilterString(rawFilter)) {
        console.log(`Applying raw audio filter: ${rawFilter}`);
        command.audioFilters(rawFilter);
      } else {
        console.log(`Applying raw video filter: ${rawFilter}`);
        command.videoFilters(rawFilter);
      }
    }
    return;
  }

  // Skip special properties
  const skipProps = ['__raw_complex_filter', '__stacked_filters', '__overlay_path', 'macroblock'];
  
  // Apply regular filters
  const filterKeys = Object.keys(filters).filter(key => !skipProps.includes(key) && filters[key] !== undefined);
  
  if (filterKeys.length > 0) {
    console.log(`Processing filters: ${filterKeys.join(', ')}`);
  }
  
  // Apply regular filters
  for (const [key, value] of Object.entries(filters)) {
    if (skipProps.includes(key) || value === undefined) continue;
    
    // Apply standard audio filters
    if (isAudioFilter(key)) {
      console.log(`Applying audio filter: ${key}=${value}`);
      switch (key) {
        case 'reverse':
          command.audioFilters('areverse');
          break;
        case 'speed':
        case 'tempo':
          const speed = Number(value);
          if (!isNaN(speed) && speed > 0.5 && speed < 2.0) {
            command.audioFilters(`atempo=${speed}`);
          }
          break;
        case 'pitch':
          const pitch = Number(value);
          if (!isNaN(pitch) && pitch > 0.5 && pitch < 2.0) {
            command.audioFilters(`asetrate=44100*${pitch},aresample=44100`);
          }
          break;
        case 'volume':
        case 'vol':
        case 'amplify':
          const vol = Number(value);
          if (!isNaN(vol) && vol > 0 && vol <= 5) {
            command.audioFilters(`volume=${vol}`);
          }
          break;
        case 'bass':
          const bassGain = Number(value);
          if (!isNaN(bassGain) && bassGain >= -20 && bassGain <= 20) {
            command.audioFilters(`bass=g=${bassGain}`);
          }
          break;
        case 'treble':
          const trebleGain = Number(value);
          if (!isNaN(trebleGain) && trebleGain >= -20 && trebleGain <= 20) {
            command.audioFilters(`treble=g=${trebleGain}`);
          }
          break;
        case 'fade':
          const fade = Number(value);
          if (!isNaN(fade) && fade > 0) {
            command.audioFilters(`afade=t=in:st=0:d=${fade},afade=t=out:st=${Math.max(0, 30-fade)}:d=${fade}`);
          }
          break;
        case 'echo':
          command.audioFilters('aecho=0.8:0.9:1000:0.3');
          break;
        default:
          // For any other audio filter, pass it directly if it's a string
          if (typeof value === 'string') {
            command.audioFilters(`${key}=${value}`);
          }
      }
    }
    // Apply standard video filters (only if this is a video)
    else if (isVideo && isVideoFilter(key)) {
      console.log(`Applying video filter: ${key}=${value}`);
      switch (key) {
        case 'rotate':
          const rotation = Number(value);
          if (!isNaN(rotation)) {
            const normalizedRotation = ((rotation % 360) + 360) % 360; // Normalize to 0-359
            command.videoFilters(`rotate=${normalizedRotation}*PI/180`);
          }
          break;
        case 'flip':
          // Handle various input formats for boolean values
          const shouldFlip = typeof value === 'boolean' ? value :
                          value === 1 || value === '1' || 
                          String(value).toLowerCase() === 'true' ||
                          String(value).toLowerCase() === 'yes';
          if (shouldFlip) {
            command.videoFilters('vflip');
          }
          break;
        case 'mirror':
          // Handle various input formats for boolean values
          const shouldMirror = typeof value === 'boolean' ? value :
                            value === 1 || value === '1' || 
                            String(value).toLowerCase() === 'true' ||
                            String(value).toLowerCase() === 'yes';
          if (shouldMirror) {
            command.videoFilters('hflip');
          }
          break;
        case 'contrast':
          const contrast = Number(value);
          if (!isNaN(contrast) && contrast >= -2 && contrast <= 2) {
            command.videoFilters(`eq=contrast=${contrast}`);
          }
          break;
        case 'brightness':
          const brightness = Number(value);
          if (!isNaN(brightness) && brightness >= -1 && brightness <= 1) {
            command.videoFilters(`eq=brightness=${brightness}`);
          }
          break;
        case 'saturation':
          const saturation = Number(value);
          if (!isNaN(saturation) && saturation >= 0 && saturation <= 3) {
            command.videoFilters(`eq=saturation=${saturation}`);
          }
          break;
        case 'blur':
          const blurAmount = Number(value);
          if (!isNaN(blurAmount) && blurAmount > 0 && blurAmount <= 10) {
            command.videoFilters(`boxblur=${blurAmount}:${Math.max(1, Math.floor(blurAmount/2))}`);
          }
          break;
        case 'speed':
          const videoSpeed = Number(value);
          if (!isNaN(videoSpeed) && videoSpeed > 0.5 && videoSpeed < 2.0) {
            command.videoFilters(`setpts=${1/videoSpeed}*PTS`);
            // We also need to adjust audio to match
            command.audioFilters(`atempo=${videoSpeed}`);
          }
          break;
        default:
          // For any other video filter, pass it directly if it's a string
          if (typeof value === 'string') {
            command.videoFilters(`${key}=${value}`);
          }
      }
    }
    // Handle special filters
    else if (key === 'complexFilter' && typeof value === 'string') {
      console.log(`Applying complex filter: ${value}`);
      command.complexFilter(value);
    }
  }
};

/**
 * Check if a filter name is for audio
 */
const isAudioFilter = (filterName: string): boolean => {
  const audioFilters = [
    'reverse', 'speed', 'tempo', 'pitch', 'volume', 'vol', 'amplify',
    'bass', 'treble', 'fade', 'echo', 'loudnorm', 'highpass', 'lowpass',
    'atempo', 'aecho', 'areverse', 'vibrato', 'chorus', 'asetrate',
    'aresample', 'pan'
  ];
  return audioFilters.includes(filterName.toLowerCase()) || filterName.startsWith('a');
};

/**
 * Check if a filter name is for video
 */
const isVideoFilter = (filterName: string): boolean => {
  const videoFilters = [
    'rotate', 'flip', 'mirror', 'contrast', 'brightness', 'saturation',
    'blur', 'speed', 'crop', 'scale', 'overlay', 'fade', 'setpts',
    'hue', 'eq', 'boxblur', 'unsharp', 'drawtext', 'pad', 'transpose',
    'vflip', 'hflip', 'negate'
  ];
  return videoFilters.includes(filterName.toLowerCase()) || filterName.startsWith('v');
};

/**
 * Check if a filter string is for audio
 */
const isAudioFilterString = (filterString: string): boolean => {
  const audioFilterPrefixes = ['a', 'volume', 'bass', 'treble', 'loudnorm'];
  return audioFilterPrefixes.some(prefix => filterString.startsWith(prefix));
};

/**
 * Generate audio waveform image
 */
export const generateAudioWaveform = async (audioPath: string): Promise<string[]> => {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }
  
  const baseFilename = path.basename(audioPath, path.extname(audioPath));
  const waveformPath = path.join(THUMBNAILS_DIR, `${baseFilename}_waveform.png`);
  const spectrogramPath = path.join(THUMBNAILS_DIR, `${baseFilename}_spectrogram.png`);
  const results: string[] = [];
  
  try {
    // Generate waveform
    await new Promise<void>((resolve, reject) => {
      ffmpeg(audioPath)
        .complexFilter([
          'showwaves=s=640x240:mode=line:colors=blue'
        ])
        .outputOptions('-frames:v 1')
        .save(waveformPath)
        .on('end', () => {
          results.push(`/media/thumbnails/${baseFilename}_waveform.png`);
          resolve();
        })
        .on('error', (err) => reject(err));
    });
    
    // Generate spectrogram
    await new Promise<void>((resolve, reject) => {
      ffmpeg(audioPath)
        .complexFilter([
          'showspectrum=s=640x240:mode=combined:color=rainbow'
        ])
        .outputOptions('-frames:v 1')
        .save(spectrogramPath)
        .on('end', () => {
          results.push(`/media/thumbnails/${baseFilename}_spectrogram.png`);
          resolve();
        })
        .on('error', (err) => reject(err));
    });
    
    // Save waveform/spectrogram paths to database
    if (results.length > 0) {
      const normalizedFilename = path.basename(audioPath);
      updateMediaThumbnails(normalizedFilename, results);
    }
    
    return results;
  } catch (error) {
    console.error(`Error generating audio visualizations: ${error}`);
    throw error;
  }
};

/**
 * Handle complex video filters that require special treatment
 * These filters can't be applied using regular videoFilters and need complexFilter with specific configs
 */
function applyComplexVideoFilter(
  command: ffmpeg.FfmpegCommand,
  filterName: string
): boolean {
  switch (filterName.toLowerCase()) {
    case 'haah':
      command.complexFilter([
        'split[a][b]',
        '[a]crop=iw/2:ih:0:0[left]',
        '[b]crop=iw/2:ih:iw/2:0,hflip[right]',
        '[left][right]hstack'
      ]);
      return true;
      
    case 'waaw':
      command.complexFilter([
        'split[a][b]',
        '[a]crop=iw/2:ih:0:0,hflip[left]',
        '[b]crop=iw/2:ih:iw/2:0[right]',
        '[left][right]hstack'
      ]);
      return true;
      
    case 'kaleidoscope':
      command.complexFilter([
        'split[a][b][c][d]',
        '[a]crop=iw/2:ih/2:0:0[tl]',
        '[b]crop=iw/2:ih/2:iw/2:0,hflip[tr]',
        '[c]crop=iw/2:ih/2:0:ih/2,vflip[bl]',
        '[d]crop=iw/2:ih/2:iw/2:ih/2,hflip,vflip[br]',
        '[tl][tr]hstack[top]',
        '[bl][br]hstack[bottom]',
        '[top][bottom]vstack'
      ]);
      return true;
      
    case 'v360_cube':
      command.videoFilters('v360=input=equirect:output=cube:w=1080:h=720');
      return true;
      
    case 'planet':
      command.videoFilters('v360=input=equirect:output=stereographic:w=720:h=720');
      return true;
      
    case 'tiny_planet':
      command.videoFilters('v360=input=equirect:output=stereographic:w=720:h=720:yaw=0:pitch=-90');
      return true;
      
    case 'oscilloscope':
      command.complexFilter(['oscilloscope=s=640x480:x=1:y=2:s=1:t=1']);
      return true;

    case 'audiowave':
      command.complexFilter(['showwaves=s=1280x720:mode=line:colors=blue']);
      return true;

    case 'audiospectrum':
      command.complexFilter(['showspectrum=s=1280x720:mode=combined:color=rainbow:scale=log']);
      return true;

    case 'audiofreq':
      command.complexFilter(['showfreqs=s=1280x720:mode=line:colors=red']);
      return true;

    case 'audiovector':
      command.complexFilter(['avectorscope=s=1280x720:mode=lissajous:zoom=2']);
      return true;
      
    default:
      return false;
  }
}

/**
 * Get random filters for testing or special effects
 * @param count Number of random filters to select (between 1-5)
 * @returns Array of filter names to apply
 */
export const getRandomFilters = (count: number = 1): string[] => {
  // Limit count to reasonable range
  count = Math.min(5, Math.max(1, count));
  
  // Collect all available filter names
  const audioFilterNames = Object.keys(audioEffects);
  const videoFilterNames = Object.keys(videoEffects);
  
  // Create combined list of all filters
  const allFilters = [...audioFilterNames, ...videoFilterNames];
  
  // Select random unique filters
  const selectedFilters = new Set<string>();
  while (selectedFilters.size < count && selectedFilters.size < allFilters.length) {
    const randomIndex = Math.floor(Math.random() * allFilters.length);
    selectedFilters.add(allFilters[randomIndex]);
  }
  
  return Array.from(selectedFilters);
};