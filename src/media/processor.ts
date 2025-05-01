import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { db } from '../database/db';

// Define storage paths
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const PROCESSED_DIR = path.join(process.cwd(), 'processed');
const NORMALIZED_DIR = path.join(process.cwd(), 'normalized');
const THUMBNAILS_DIR = path.join(process.cwd(), 'thumbnails');
const TEMP_DIR = path.join(process.cwd(), 'temp');

// Max file size for Discord (in MB)
export const MAX_FILE_SIZE_MB = 9;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Create directories if they don't exist
[UPLOADS_DIR, PROCESSED_DIR, NORMALIZED_DIR, THUMBNAILS_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export interface MediaFilter {
  [key: string]: string | number;
}

export interface ClipOptions {
  duration?: string;
  start?: string;
}

interface ProcessOptions {
  filters?: MediaFilter;
  clip?: ClipOptions;
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
  const command = ffmpeg(inputPath);
  
  // Apply any filters
  if (options.filters && Object.keys(options.filters).length > 0) {
    const filterString = Object.entries(options.filters)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    
    command.audioFilters(filterString);
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
  
  return new Promise((resolve, reject) => {
    command
      .outputOptions('-c:a libopus')
      .outputOptions('-b:a 128k')
      .save(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err));
  });
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
      preset: hasNvenc ? 'p1' : 'medium', 
      trimDuration: null 
    },
    // Second attempt: 720p medium quality
    { 
      height: 720, 
      videoQuality: hasNvenc ? 28 : 28,    
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p2' : 'faster', 
      trimDuration: null 
    },
    // Third attempt: 360p low quality
    { 
      height: 360, 
      videoQuality: hasNvenc ? 35 : 35,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p3' : 'veryfast', 
      trimDuration: null 
    },
    // Fourth attempt: 360p very low quality
    { 
      height: 360, 
      videoQuality: hasNvenc ? 42 : 42,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p4' : 'superfast', 
      trimDuration: null 
    },
    // Fifth attempt: 360p extremely low quality
    { 
      height: 240, 
      videoQuality: hasNvenc ? 50 : 50,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p4' : 'superfast', 
      trimDuration: null 
    },
    // Sixth attempt: 240p extremely low quality + trim to 4 minutes
    { 
      height: 240, 
      videoQuality: hasNvenc ? 50 : 50,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p4' : 'superfast', 
      trimDuration: 240 
    },
    // Seventh attempt: 240p extremely low quality + trim to 2 minutes
    { 
      height: 240, 
      videoQuality: hasNvenc ? 50 : 50,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p4' : 'superfast', 
      trimDuration: 120 
    },
    // Eighth attempt: 240p extremely low quality + trim to 1 minute
    { 
      height: 240, 
      videoQuality: hasNvenc ? 50 : 50,
      audioBitrate: isVideo ? '128k' : '128k',
      preset: hasNvenc ? 'p4' : 'superfast', 
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
  
  // Calculate optimal bitrates
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
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .setDuration(finalDuration)
          .outputOptions('-c copy')
          .save(preTrimPath)
          .on('end', () => {
            if (validFile(preTrimPath)) {
              inputForEncoding = preTrimPath;
              console.log(`Successfully trimmed to ${finalDuration}s`);
            }
            resolve();
          })
          .on('error', (err) => {
            console.error(`Error trimming: ${err}`);
            resolve(); // Continue with original file if trimming fails
          });
      });
    } catch (error) {
      console.error(`Error during trim: ${error}`);
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
    
    // Set audio settings
    command.outputOptions('-ac 2'); // Always use stereo audio
    command.outputOptions(`-c:a libopus`);
    command.outputOptions(`-b:a ${audioBitrateKbps}k`);
    command.outputOptions('-vbr on'); // Variable bitrate for audio
    command.outputOptions('-application audio'); // Optimize for music
    
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
        command.outputOptions(`-preset p2`); // Medium preset
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
  
  content.split(',').forEach(pair => {
    const [key, value] = pair.split('=');
    if (key && value) {
      filters[key.trim()] = isNaN(Number(value.trim())) ? value.trim() : Number(value.trim());
    }
  });
  
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
  audioPriorityKbps = 128
): BitrateCalculation => {
  const totalBits = MAX_FILE_SIZE_BYTES * 8 * 0.95; // 5% buffer for container overhead
  let audioBitrateKbps = audioPriorityKbps;
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
  
  // For video files, balance between audio and video
  if (totalBitrateKbps <= audioBitrateKbps + 200) {
    // Lower audio quality if video bitrate becomes too low
    audioBitrateKbps = Math.max(64, totalBitrateKbps - 200);
  }

  videoBitrateKbps = totalBitrateKbps - audioBitrateKbps;

  // If video bitrate still too low (<150kbps), calculate how much to trim
  if (videoBitrateKbps < 150) {
    const minTotalBitrate = audioBitrateKbps + 150;
    const maxDuration = totalBits / (minTotalBitrate * 1000);
    trimDurationSeconds = Math.floor(maxDuration);
    videoBitrateKbps = 150; // set to minimal acceptable bitrate
  }

  return { audioBitrateKbps, videoBitrateKbps, trimDurationSeconds };
};