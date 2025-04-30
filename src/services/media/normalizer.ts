import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

// Set ffmpeg path if available
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
} else {
  logger.warn('ffmpeg-static path not found, relying on system ffmpeg installation');
}

// Default max file size for Discord is 9MB
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE || '9');
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

// Maximum duration for files if they need to be trimmed (4 minutes by default)
const MAX_DURATION_SEC = parseInt(process.env.MAX_DURATION || '240');

// Target peak volume level in dB
const TARGET_PEAK_DB = process.env.TARGET_PEAK_DB || '-3dB';

/**
 * Check if NVIDIA GPU is available for hardware acceleration
 */
export async function hasNvidiaGpu(): Promise<boolean> {
  return new Promise((resolve) => {
    const command = ffmpeg();
    
    command.getAvailableEncoders((err, encoders) => {
      if (err) {
        logger.warn(`Error checking for NVIDIA encoders: ${err.message}`);
        resolve(false);
        return;
      }
      
      // Check if h264_nvenc encoder is available
      const hasNvenc = encoders && encoders['h264_nvenc'] !== undefined;
      
      if (hasNvenc) {
        logger.info('NVIDIA hardware encoding (h264_nvenc) is available');
      } else {
        logger.info('NVIDIA hardware encoding not available, will use software encoding');
      }
      
      resolve(hasNvenc);
    });
  });
}

/**
 * Analyze the audio level of a media file
 * @param filePath Path to the media file
 * @returns The peak volume level and mean volume level
 */
export async function analyzeAudioLevel(filePath: string): Promise<{ peak: number, mean: number }> {
  return new Promise((resolve, reject) => {
    // Create a temporary output file for the audio analysis
    const tempDir = process.env.TEMP_DIR || './temp';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Use a temporary file instead of /dev/null for better cross-platform compatibility
    const tempOutputFile = path.join(tempDir, `audio_analysis_${Date.now()}.null`);
    
    // Run ffmpeg with volumedetect filter to analyze audio
    const command = ffmpeg(filePath)
      .audioFilters('volumedetect')
      .output(tempOutputFile) // Use temp file instead of /dev/null
      .outputOptions(['-f', 'null']) // Format as null but with a real file
      .on('error', (err) => {
        // Clean up temp file if it exists
        try {
          if (fs.existsSync(tempOutputFile)) {
            fs.unlinkSync(tempOutputFile);
          }
        } catch (cleanupError) {
          logger.warn(`Failed to clean up temp file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
        
        reject(new Error(`Error analyzing audio: ${err.message}`));
      })
      .on('end', (stdout, stderr) => {
        try {
          if (stderr === null) {
            reject(new Error('FFmpeg did not produce any stderr output for volume analysis'));
            return;
          }
          
          // Parse mean_volume from stderr
          const meanMatch = stderr.match(/mean_volume: ([-\d.]+) dB/);
          const mean = meanMatch ? parseFloat(meanMatch[1]) : -25;
          
          // Parse max_volume from stderr
          const maxMatch = stderr.match(/max_volume: ([-\d.]+) dB/);
          const peak = maxMatch ? parseFloat(maxMatch[1]) : -10;
          
          logger.info(`Audio analysis for ${filePath}: peak=${peak}dB, mean=${mean}dB`);
          resolve({ peak, mean });
          
          // Clean up temp file if it exists
          try {
            if (fs.existsSync(tempOutputFile)) {
              fs.unlinkSync(tempOutputFile);
            }
          } catch (cleanupError) {
            logger.warn(`Failed to clean up temp file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        } catch (parseError) {
          reject(new Error(`Error parsing audio analysis: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
        }
      });
    
    // Run the command
    command.run();
  });
}

/**
 * Normalizes a media file's audio level to the target peak
 * Creates both uncompressed and compressed versions for different use cases
 * @param filePath Path to the original media file
 * @param outputDir Directory to save normalized files
 * @returns Object with paths to the normalized uncompressed and compressed files
 */
export async function normalizeMedia(
  filePath: string,
  outputDir: string = process.env.NORMALIZED_DIR || './normalized'
): Promise<{ uncompressed: string, compressed: string }> {
  // Validate input
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  // Create output directories if they don't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const uncompressedDir = path.join(outputDir, 'uncompressed');
  if (!fs.existsSync(uncompressedDir)) {
    fs.mkdirSync(uncompressedDir, { recursive: true });
  }
  
  // Generate output filenames
  const fileName = path.basename(filePath);
  const uncompressedPath = path.join(uncompressedDir, `uncompressed_${fileName}`);
  const compressedPath = path.join(outputDir, `final_${fileName}`);
  
  // Skip if both files already exist
  if (fs.existsSync(uncompressedPath) && fs.existsSync(compressedPath)) {
    logger.info(`Files already exist, skipping normalization: 
      - ${uncompressedPath}
      - ${compressedPath}`);
    return { uncompressed: uncompressedPath, compressed: compressedPath };
  }
  
  try {
    // Get media metadata
    const metadata = await getMediaMetadata(filePath);
    
    // Analyze audio levels
    const { peak } = await analyzeAudioLevel(filePath);
    
    // Calculate volume adjustment needed
    // TARGET_PEAK_DB is negative, peak is negative, so we add the difference
    // Example: If peak is -10dB and target is -3dB, we need to add +7dB
    let volumeAdjustment = parseFloat(TARGET_PEAK_DB.replace('dB', '')) - peak;
    
    // Limit the volume adjustment to a safe range to prevent clipping/distortion
    // FFmpeg may fail if we try to increase volume too much
    const MAX_VOLUME_ADJUSTMENT = 20; // Maximum 20dB increase
    if (volumeAdjustment > MAX_VOLUME_ADJUSTMENT) {
      logger.warn(`Limiting volume adjustment from ${volumeAdjustment.toFixed(2)}dB to ${MAX_VOLUME_ADJUSTMENT}dB to avoid distortion`);
      volumeAdjustment = MAX_VOLUME_ADJUSTMENT;
    }
    
    logger.info(`Volume adjustment needed: ${volumeAdjustment.toFixed(2)}dB`);
    
    // First, create the uncompressed normalized version with only audio normalization
    await createUncompressedNormalizedVersion(
      filePath, 
      uncompressedPath, 
      volumeAdjustment
    );
    
    // Next, create the compressed version for Discord
    await createCompressedNormalizedVersion(
      uncompressedPath,  // Use the normalized audio as the source
      compressedPath,
      metadata,
      MAX_FILE_SIZE
    );
    
    return { uncompressed: uncompressedPath, compressed: compressedPath };
  } catch (error) {
    logger.error(`Error in normalizeMedia: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Creates an uncompressed version of the media with normalized audio levels
 * @param filePath Path to the original media file
 * @param outputPath Path to save the uncompressed normalized file
 * @param volumeAdjustment Volume adjustment in dB
 */
async function createUncompressedNormalizedVersion(
  filePath: string,
  outputPath: string,
  volumeAdjustment: number
): Promise<void> {
  logger.info(`Creating uncompressed normalized version: ${outputPath}`);
  
  // Get media type
  const metadata = await getMediaMetadata(filePath);
  const isVideo = metadata.streams.some((stream: any) => stream.codec_type === 'video');
  
  // Get the file extension
  const inputExt = path.extname(filePath).toLowerCase();
  const outputExt = path.extname(outputPath).toLowerCase();
  
  // Determine output format based on file type
  let finalOutputPath = outputPath;
  if (!isVideo && (outputExt === '.wav' || outputExt === '.ogg')) {
    // For audio-only WAV or OGG files, convert to mp3
    finalOutputPath = outputPath.replace(/\.(wav|ogg)$/i, '.mp3');
    logger.info(`Converting audio file from ${inputExt} to .mp3 for better compatibility`);
  }
  
  // Apply volume normalization
  const volumeFilter = `volume=${volumeAdjustment.toFixed(2)}dB`;
  
  let command = ffmpeg(filePath);
  
  if (isVideo) {
    // For video, copy video stream and normalize audio
    command
      .videoCodec('copy')                  // copy video unchanged
      .audioFilters(volumeFilter)          // normalize audio
      .outputOptions([
        '-c:a aac',                        // AAC audio codec for mp4 compatibility
        '-b:a 256k',                       // high bitrate for audio
        '-strict experimental',            // needed for some AAC encoders
        '-movflags +faststart'             // optimize for streaming
      ]);
  } else {
    // For audio-only files
    command = ffmpeg(filePath);
    command.audioFilters(volumeFilter);
    
    // Different settings based on output format
    if (finalOutputPath.endsWith('.mp3')) {
      command
        .audioCodec('libmp3lame')          // Use MP3 codec for MP3 output
        .audioBitrate('256k')              // High quality MP3
        .outputOptions([
          '-q:a 0',                        // Highest quality setting
          '-map_metadata 0'                // Preserve metadata
        ]);
    } else if (finalOutputPath.endsWith('.m4a')) {
      command
        .audioCodec('aac')                 // AAC codec for M4A files
        .audioBitrate('256k')              // High quality AAC
        .outputOptions([
          '-strict experimental',          // Needed for some AAC encoders
          '-map_metadata 0'                // Preserve metadata
        ]);
    } else {
      // For other audio formats, use format-specific settings
      command
        .audioCodec('libmp3lame')          // Default to MP3 when in doubt
        .audioBitrate('256k')
        .outputOptions([
          '-q:a 0',                        // Highest quality
          '-map_metadata 0'                // Preserve metadata
        ]);
    }
  }
  
  // Run command
  try {
    command.output(finalOutputPath);
    await runFFmpegCommand(command);
    logger.info(`Successfully created uncompressed normalized version: ${finalOutputPath}`);
    
    // If the output path changed, update the return to the new path
    if (finalOutputPath !== outputPath) {
      logger.info(`Using ${finalOutputPath} instead of ${outputPath} for better compatibility`);
    }
  } catch (error) {
    logger.error(`Error creating uncompressed version: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Creates a compressed version of the media for Discord compatibility
 * @param filePath Path to the source media file (already audio normalized)
 * @param outputPath Path to save the compressed file
 * @param metadata Media metadata from ffprobe
 * @param maxSize Maximum file size in bytes
 */
async function createCompressedNormalizedVersion(
  filePath: string,
  outputPath: string,
  metadata: any,
  maxSize: number
): Promise<void> {
  logger.info(`Creating compressed version: ${outputPath}`);
  
  // Determine if this is a video or audio file
  const isVideo = metadata.streams.some((stream: any) => stream.codec_type === 'video');
  
  // Calculate duration in seconds
  const duration = parseFloat(metadata.format.duration || '0');
  
  // Check if NVIDIA GPU is available for encoding
  const hasNvenc = await hasNvidiaGpu();
  
  // Handle path adjustments for different audio formats
  const inputExt = path.extname(filePath).toLowerCase();
  const outputExt = path.extname(outputPath).toLowerCase();
  
  // For audio-only files, ensure we output as MP3 for maximum compatibility
  let finalOutputPath = outputPath;
  if (!isVideo && (outputExt === '.wav' || outputExt === '.ogg' || outputExt === '.m4a')) {
    finalOutputPath = outputPath.replace(/\.(wav|ogg|m4a)$/i, '.mp3');
    logger.info(`Converting audio output to MP3 for maximum Discord compatibility: ${finalOutputPath}`);
  }
  
  // For video files, we start with standard parameters and progressively
  // apply more aggressive compression if needed
  let attempts = 0;
  const maxAttempts = 3;
  
  while (attempts < maxAttempts) {
    let command = ffmpeg(filePath);
    const attemptOutputPath = attempts === 0 ? finalOutputPath : 
      finalOutputPath.replace(/\.(mp4|mp3)$/i, `_attempt${attempts}.$1`);
    attempts++;
    
    try {
      if (isVideo) {
        // Get video dimensions
        const videoStream = metadata.streams.find((stream: any) => stream.codec_type === 'video');
        const width = videoStream?.width || 1280;
        const height = videoStream?.height || 720;
        
        // Calculate target max resolution based on attempt number
        let maxHeight = 720;
        if (attempts === 2) maxHeight = 480;
        if (attempts === 3) maxHeight = 360;
        
        // Calculate scale filter to maintain aspect ratio
        const scaleFilter = height > maxHeight ? `scale=-1:${maxHeight}` : 'scale=-1:-1';
        
        // Calculate target bitrate based on file duration, desired size, and attempt
        const targetTotalKbps = Math.floor((maxSize * 8) / (duration * 1024));
        
        // Allocate bitrate between video and audio
        // Give more bitrate to video on earlier attempts, be more aggressive later
        const audioBitrate = attempts === 1 ? 128 : (attempts === 2 ? 96 : 64);
        const videoBitrate = Math.max(500, targetTotalKbps - audioBitrate);
        
        // For very short clips, cap video bitrate to avoid excessive sizes
        const maxVideoBitrate = 4000;
        const adjustedVideoBitrate = Math.min(videoBitrate, maxVideoBitrate);
        
        logger.info(`Compression attempt ${attempts}: target video bitrate ${adjustedVideoBitrate}kbps, audio ${audioBitrate}kbps`);
        
        if (hasNvenc) {
          // Use NVIDIA hardware acceleration
          command
            .outputOptions([
              '-c:v h264_nvenc',              // nvidia h264 encoder
              `-b:v ${adjustedVideoBitrate}k`, // target video bitrate
              '-preset p2',                   // p1-7, higher = faster
              '-rc vbr',                      // variable bitrate for better quality
              `-maxrate:v ${adjustedVideoBitrate * 1.5}k`, // 1.5x target for peaks
              `-bufsize ${adjustedVideoBitrate * 2}k`,    // 2x target for buffer
              '-c:a aac',                     // AAC audio codec for mp4 compatibility
              `-b:a ${audioBitrate}k`,        // target audio bitrate
              '-strict experimental',         // needed for some AAC encoders
              `-vf ${scaleFilter}`,           // scale video if needed
              '-pix_fmt yuv420p',             // widely compatible pixel format
              '-movflags +faststart'          // enable streaming
            ]);
        } else {
          // Fallback to software encoding
          command
            .outputOptions([
              '-c:v libx264',                 // software h264 encoder
              `-b:v ${adjustedVideoBitrate}k`, // target video bitrate
              `-maxrate:v ${adjustedVideoBitrate * 1.5}k`, // 1.5x target for peaks
              `-bufsize ${adjustedVideoBitrate * 2}k`,    // 2x target for buffer
              '-preset medium',               // faster on later attempts
              '-c:a aac',                     // AAC audio codec for mp4 compatibility
              `-b:a ${audioBitrate}k`,        // target audio bitrate
              '-strict experimental',         // needed for some AAC encoders
              `-vf ${scaleFilter}`,           // scale video if needed
              '-pix_fmt yuv420p',             // widely compatible pixel format
              '-movflags +faststart'          // enable streaming
            ]);
        }
      } else {
        // For audio-only files, use MP3 format
        const targetBitrate = attempts === 1 ? 192 : (attempts === 2 ? 160 : 128);
        
        logger.info(`Processing audio-only file to MP3 with bitrate ${targetBitrate}k`);
        command
          .audioCodec('libmp3lame')          // MP3 codec
          .audioBitrate(`${targetBitrate}k`) // Target bitrate
          .outputOptions([
            '-q:a 2',                        // Quality preset (0=best, 9=worst)
            '-map_metadata 0',               // Copy metadata
            '-id3v2_version 3'               // Use ID3v2.3 tags for better compatibility
          ]);
      }
      
      // If duration exceeds max, trim the file
      if (duration > MAX_DURATION_SEC) {
        logger.info(`File exceeds max duration (${duration}s > ${MAX_DURATION_SEC}s), trimming`);
        command.outputOptions([`-t ${MAX_DURATION_SEC}`]);
      }
      
      // Set output path and run the command
      command.output(attemptOutputPath);
      await runFFmpegCommand(command);
      
      // Check if the file is within size limits
      const finalSize = fs.statSync(attemptOutputPath).size;
      logger.info(`Attempt ${attempts} encoding of ${path.basename(filePath)} resulted in ${finalSize} bytes`);
      
      if (finalSize <= maxSize || attempts === maxAttempts) {
        // If this is not the final output path, rename it
        if (attemptOutputPath !== finalOutputPath) {
          fs.renameSync(attemptOutputPath, finalOutputPath);
        }
        
        if (finalSize > maxSize) {
          logger.warn(`Could not compress ${path.basename(filePath)} below size limit after ${attempts} attempts. Final size: ${finalSize} bytes`);
        } else {
          logger.info(`Successfully compressed ${path.basename(filePath)} to ${finalSize} bytes (${Math.round(finalSize/1024/1024*100)/100}MB)`);
        }
        
        // If we changed the output extension (e.g., from .wav to .m4a), 
        // update the returned path to reflect this
        if (finalOutputPath !== outputPath) {
          logger.info(`Using ${finalOutputPath} instead of ${outputPath} for better compatibility`);
        }
        
        return;
      }
      
      logger.info(`First encoding of ${path.basename(filePath)} resulted in ${finalSize} bytes, exceeding the limit of ${maxSize}. Retrying with higher compression.`);
      
    } catch (error) {
      logger.error(`Error in compression attempt ${attempts}: ${error instanceof Error ? error.message : String(error)}`);
      
      // If this is our last attempt or not a video, throw the error
      if (attempts >= maxAttempts || !isVideo) {
        throw error;
      }
      
      // Otherwise continue to next attempt with more aggressive settings
      logger.info(`Trying more aggressive compression settings (attempt ${attempts+1}/${maxAttempts})`);
    }
  }
}

/**
 * Helper function to get media metadata
 */
async function getMediaMetadata(filePath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: Error | null, metadata: any) => {
      if (err) {
        reject(new Error(`Error probing media file: ${err.message}`));
        return;
      }
      resolve(metadata);
    });
  });
}

/**
 * Helper function to run an FFmpeg command
 */
async function runFFmpegCommand(command: ffmpeg.FfmpegCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    command
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

/**
 * Runs normalization on all media files in the database
 * @param mediaRepository The media repository to query files from
 * @param outputDir Directory to save normalized files
 * @returns Object with statistics about the normalization process
 */
export async function normalizeAllMedia(
  mediaRepository: any,
  outputDir: string = process.env.NORMALIZED_DIR || './normalized'
): Promise<{ total: number, success: number, failed: string[] }> {
  const stats = {
    total: 0,
    success: 0,
    failed: [] as string[]
  };
  
  try {
    // Get all media files from the database
    const mediaFiles = await mediaRepository.find();
    stats.total = mediaFiles.length;
    
    for (const media of mediaFiles) {
      try {
        const filePath = media.filePath;
        
        // Skip files that don't exist
        if (!fs.existsSync(filePath)) {
          logger.warn(`File does not exist: ${filePath}, skipping normalization`);
          stats.failed.push(`${media.id}: ${filePath} (file not found)`);
          continue;
        }
        
        logger.info(`Normalizing media ${media.id}: ${media.title}`);
        
        // Normalize the media file
        const { uncompressed, compressed } = await normalizeMedia(filePath, outputDir);
        
        // Update the database with normalized paths
        media.normalizedPath = path.relative(process.cwd(), compressed);
        media.uncompressedPath = path.relative(process.cwd(), uncompressed);
        await mediaRepository.save(media);
        
        stats.success++;
        logger.info(`Successfully normalized media ${media.id}: ${media.title}`);
      } catch (error) {
        logger.error(`Failed to normalize media ${media.id}: ${error instanceof Error ? error.message : String(error)}`);
        stats.failed.push(`${media.id}: ${media.title} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    
    return stats;
  } catch (error) {
    logger.error(`Error in normalizeAllMedia: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}