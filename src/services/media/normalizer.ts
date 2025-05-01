// src/services/media/normalizer.ts
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';
import { Media } from '../../database/types';
import { saveMedia, findMediaById } from '../../database/repositories/mediaRepository';

/**
 * Maximum file size for Discord (in MB)
 */
export const MAX_FILE_SIZE_MB = 9;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Directories for normalized and temporary files
 */
export const NORMALIZED_DIR = process.env.NORMALIZED_DIR || path.join(process.cwd(), 'normalized');
export const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'temp');

/**
 * Check if NVIDIA GPU encoding is available
 * @returns True if NVIDIA GPU encoding is available
 */
export async function hasNvidiaGpu(): Promise<boolean> {
  try {
    const output = execSync('ffmpeg -encoders | grep nvenc').toString();
    return output.includes('nvenc');
  } catch (error) {
    logger.info('NVIDIA hardware encoding not available, will use software encoding');
    return false;
  }
}

/**
 * Ensure necessary directories exist
 */
export function ensureDirectoriesExist(): void {
  if (!fs.existsSync(NORMALIZED_DIR)) {
    fs.mkdirSync(NORMALIZED_DIR, { recursive: true });
  }
  
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/**
 * Check if file exists and is not empty
 */
export function validFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Get video dimensions using ffprobe
 */
export function getVideoDimensions(filePath: string): { width: number; height: number } {
  try {
    // Get width
    const widthOutput = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=noprint_wrappers=1:nokey=1 "${filePath}"`).toString().trim();
    const width = parseInt(widthOutput, 10);
    
    // Get height
    const heightOutput = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "${filePath}"`).toString().trim();
    const height = parseInt(heightOutput, 10);
    
    return { width, height };
  } catch (error) {
    logger.error(`Error getting dimensions for ${filePath}: ${error}`);
    return { width: 0, height: 0 };
  }
}

/**
 * Get media duration using ffprobe
 */
export function getMediaDuration(filePath: string): number {
  try {
    const output = execSync(`ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`).toString().trim();
    return parseFloat(output);
  } catch (error) {
    logger.error(`Error getting duration for ${filePath}: ${error}`);
    return 0;
  }
}

/**
 * Check if file is video or audio
 */
export async function isVideoFile(filePath: string): Promise<boolean> {
  try {
    // First check file extension for common audio formats
    const extension = path.extname(filePath).toLowerCase();
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus'];
    
    if (audioExtensions.includes(extension)) {
      logger.info(`Identified ${filePath} as audio based on extension ${extension}`);
      return false;
    }
    
    // If extension check is inconclusive, use ffprobe
    const output = execSync(`ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${filePath}"`).toString().trim();
    const isVideo = output.includes('video');
    
    logger.info(`FFprobe identified ${filePath} as ${isVideo ? 'video' : 'audio'}`);
    return isVideo;
  } catch (error) {
    logger.info(`Could not determine if ${filePath} is video, assuming audio`);
    return false; // Assume audio if we can't determine
  }
}

/**
 * Encode media file with given settings
 */
export async function encodeMedia(
  inputPath: string,
  outputPath: string,
  isVideo: boolean,
  hasNvenc: boolean,
  height: number,
  videoQuality: string,
  audioQuality: string,
  preset?: string,
  trimDuration?: number | null,
  verbose = false
): Promise<boolean> {
  try {
    // Get file extension and prepare output path with correct extension
    const inputExt = path.extname(inputPath).toLowerCase();
    let outputExt = path.extname(outputPath).toLowerCase();
    
    // For audio files, ensure we're using .ogg format with Opus codec
    let tempOutputPath = outputPath;
    if (!isVideo) {
      // Convert all audio formats to .ogg
      tempOutputPath = outputPath.replace(/\.(wav|mp3|ogg|flac|m4a)$/i, '.ogg');
      outputExt = '.ogg';
      if (verbose) logger.info(`Converting audio from ${inputExt} to .ogg with Opus codec for better compatibility`);
    } else {
      // For WebM and MOV files, we need to convert to MP4 when using H.264 codec or Opus audio
      if (inputExt === '.webm' || outputExt === '.webm' || 
          inputExt === '.mov' || outputExt === '.mov') {
        tempOutputPath = outputPath.replace(/\.(webm|mov)$/i, '.mp4');
        outputExt = '.mp4';
        if (verbose) logger.info(`Converting from ${inputExt} to MP4 container for H.264/Opus compatibility`);
      }
    }
    
    const ffmpegLogLevel = verbose ? 'info' : 'warning';
    let command = `ffmpeg -y -i "${inputPath}" -hide_banner -loglevel ${ffmpegLogLevel}`;
    
    // Add trim duration if specified
    if (trimDuration) {
      if (verbose) logger.info(`Trimming to ${trimDuration} seconds`);
      command += ` -t ${trimDuration}`;
    }
    
    // Always downmix audio to stereo (2 channels) for better compatibility with Discord
    command += ' -ac 2';
    if (verbose) logger.info('Downmixing audio to stereo for optimal Discord playback');
    
    if (isVideo) {
      // Get original video dimensions
      const dimensions = getVideoDimensions(inputPath);
      if (verbose) logger.info(`Original video dimensions: ${dimensions.width}x${dimensions.height}`);
      
      // Only scale if original is larger than target dimensions
      if (dimensions.width > 1280 || dimensions.height > 720) {
        // Video scale filter - we'll use 1280x720 as the maximum resolution
        // Use single quotes around the scale arguments to ensure proper parsing
        command += ` -vf "scale=w='min(1280,iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease,format=yuv420p"`;
        if (verbose) logger.info(`Scaling video to max dimensions 1280x${height}`);
      } else {
        // Keep original resolution but ensure yuv420p pixel format
        command += ` -vf "format=yuv420p"`;
        if (verbose) logger.info(`Keeping original resolution ${dimensions.width}x${dimensions.height}`);
      }
      
      if (hasNvenc) {
        // Use NVIDIA hardware acceleration with true VBR settings
        // Map quality levels to appropriate CQ values for NVENC
        let cqValue = 23; // Default for high quality
        let aqStrength = 8; // Default AQ strength
        
        if (videoQuality === 'high') {
          cqValue = 23; // Better quality (lower value = higher quality for CQ)
          aqStrength = 8;
        } else if (videoQuality === 'medium') {
          cqValue = 28; // Medium quality
          aqStrength = 10;
        } else if (videoQuality === 'low') {
          cqValue = 35; // Low quality
          aqStrength = 12;
        } else if (videoQuality === 'very-low') {
          cqValue = 42; // Very low quality
          aqStrength = 15;
        } else { // extremely-low
          cqValue = 50; // Extremely low quality
          aqStrength = 15;
        }
        
        // Pure VBR settings with NVENC - Set to true VBR mode
        command += ` -c:v h264_nvenc -preset ${preset || 'p1'} -rc:v vbr`;
        command += ' -b:v 0'; // Pure VBR mode, let quality parameter control bitrate completely
        command += ` -cq:v ${cqValue}`; // Quality level (higher = more compression)
        
        // Adaptive quantization settings - enhanced for better compression
        command += ' -spatial-aq 1'; // Spatial adaptive quantization for better detail
        command += ' -temporal-aq 1'; // Temporal adaptive quantization
        command += ` -aq-strength ${aqStrength}`; // Control strength of adaptive quantization
        
        // Set max bitrate for frame size control, but let CQ govern quality
        // These act as safety limits but don't force CBR
        if (videoQuality === 'high') {
          command += ' -maxrate:v 3000k -bufsize:v 6000k';
        } else if (videoQuality === 'medium') {
          command += ' -maxrate:v 2000k -bufsize:v 4000k';
        } else if (videoQuality === 'low') {
          command += ' -maxrate:v 1000k -bufsize:v 2000k';
        } else if (videoQuality === 'very-low') {
          command += ' -maxrate:v 800k -bufsize:v 1600k';
        } else { // extremely-low
          command += ' -maxrate:v 600k -bufsize:v 1200k';
        }
      } else {
        // Software encoding fallback with x264 CRF mode (true VBR)
        // Map quality levels to appropriate CRF values for libx264
        let crf = 23; // Default for high quality
        let preset = 'medium'; // Default preset
        
        if (videoQuality === 'high') {
          crf = 23; // Better quality (lower value = higher quality for CRF)
          preset = 'medium';
        } else if (videoQuality === 'medium') {
          crf = 28; // Medium quality
          preset = 'faster';
        } else if (videoQuality === 'low') {
          crf = 35; // Low quality
          preset = 'faster';
        } else if (videoQuality === 'very-low') {
          crf = 42; // Very low quality
          preset = 'veryfast';
        } else { // extremely-low
          crf = 50; // Extremely low quality
          preset = 'superfast';
        }
        
        // Pure VBR settings with libx264
        command += ` -c:v libx264 -preset ${preset} -crf ${crf}`;
        
        // Set max bitrate for frame size control, but let CRF govern quality
        if (videoQuality === 'high') {
          command += ' -maxrate:v 3000k -bufsize:v 6000k';
        } else if (videoQuality === 'medium') {
          command += ' -maxrate:v 2000k -bufsize:v 4000k';
        } else if (videoQuality === 'low') {
          command += ' -maxrate:v 1000k -bufsize:v 2000k';
        } else if (videoQuality === 'very-low') {
          command += ' -maxrate:v 800k -bufsize:v 1600k';
        } else { // extremely-low
          command += ' -maxrate:v 600k -bufsize:v 1200k';
        }
      }
      
      // Common video settings
      command += ' -pix_fmt yuv420p -movflags +faststart';
      
      // Audio settings for video files - use Opus codec for better quality
      let audioBitrate;
      let opusQuality;
      
      if (audioQuality === 'high') {
        audioBitrate = '192k';
        opusQuality = 3;  // Best quality
      } else if (audioQuality === 'medium') {
        audioBitrate = '128k';
        opusQuality = 4;
      } else if (audioQuality === 'low') {
        audioBitrate = '96k';
        opusQuality = 5;
      } else if (audioQuality === 'very-low') {
        audioBitrate = '64k';
        opusQuality = 6;
      } else { // extremely-low
        audioBitrate = '48k';
        opusQuality = 7;  // Worst quality
      }
      
      // Use Opus codec for video files instead of AAC
      command += ` -c:a libopus -b:a ${audioBitrate}`;
      command += ` -compression_level ${opusQuality}`; // Opus compression level (1-10, lower = better)
      command += ' -vbr on -application audio'; // Use VBR and optimize for music
    } else {
      // Audio-only, remove video streams
      command += ' -vn';
      
      // For audio files, use Opus codec with .ogg container and variable bitrate
      let audioBitrate;
      let compressionLevel;
      
      if (audioQuality === 'high') {
        audioBitrate = '128k';
        compressionLevel = 6;
      } else if (audioQuality === 'medium') {
        audioBitrate = '96k';
        compressionLevel = 8;
      } else if (audioQuality === 'low') {
        audioBitrate = '64k';
        compressionLevel = 10;
      } else if (audioQuality === 'very-low') {
        audioBitrate = '48k';
        compressionLevel = 10;
      } else { // extremely-low
        audioBitrate = '32k';
        compressionLevel = 10;
      }
      
      // Pure VBR settings for Opus audio with enhanced quality
      command += ` -c:a libopus -b:a ${audioBitrate} -vbr on`;
      command += ` -compression_level ${compressionLevel}`;
      command += ' -application audio'; // Optimize for music and high quality audio instead of speech
    }
    
    // Output file
    command += ` "${tempOutputPath}"`;
    
    // Execute the command
    if (verbose) logger.info(`Running: ${command}`);
    execSync(command);
    
    // Check if the output file exists and has content
    return validFile(tempOutputPath);
  } catch (error) {
    logger.error(`FFmpeg encoding error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Process a single media file
 */
export async function processMediaFile(
  media: Media, 
  hasNvenc: boolean,
  verbose = false
): Promise<boolean> {
  const originalPath = media.filePath;
  
  // Skip if file doesn't exist
  if (!validFile(originalPath)) {
    logger.error(`File does not exist or is empty: ${originalPath}`);
    return false;
  }
  
  // Skip if already processed
  if (media.normalizedPath && validFile(path.join(process.cwd(), media.normalizedPath))) {
    if (verbose) logger.info(`File already normalized: ${media.title}`);
    return true;
  }
  
  // Determine the output file paths
  const fileName = path.basename(originalPath);
  const outputPath = path.join(NORMALIZED_DIR, fileName);
  const tempOutputPath = path.join(TEMP_DIR, `temp_${fileName}`);
  const preTrimPath = path.join(TEMP_DIR, `pretrim_${fileName}`);
  
  // Get the duration of the input file
  const duration = getMediaDuration(originalPath);
  if (duration === 0) {
    logger.error(`Couldn't determine duration for ${originalPath}`);
    return false;
  }
  
  // Determine if it's video or audio
  const isVideo = await isVideoFile(originalPath);
  
  // Determine final output path based on media type
  let finalOutputPath = outputPath;
  const inputExt = path.extname(originalPath).toLowerCase();
  
  if (!isVideo) {
    // For audio files, always convert to .ogg with Opus codec
    finalOutputPath = outputPath.replace(/\.(wav|mp3|ogg|flac|m4a|aac)$/i, '.ogg');
    if (verbose) logger.info(`Will convert ${inputExt} to .ogg with Opus codec for better compatibility`);
  } else {
    // For video files, always convert to .mp4 with H.264 codec
    // This ensures consistent output regardless of original format
    finalOutputPath = outputPath.replace(/\.(webm|mov|mkv|flv|avi|wmv|mp4|m4v)$/i, '.mp4');
    if (verbose) logger.info(`Will convert ${inputExt} to .mp4 with H.264 codec for better compatibility`);
  }
  
  // Pre-trim long media to 10 minutes (600 seconds) to save processing time
  let inputForEncoding = originalPath;
  
  if (duration > 600) {
    logger.info(`Media duration is ${Math.round(duration)}s. Pre-trimming ${media.title} to 10 minutes to optimize processing.`);
    try {
      // Simple trim command without any quality adjustments
      const preTrimCommand = `ffmpeg -y -i "${originalPath}" -t 600 -c copy "${preTrimPath}"`;
      if (verbose) logger.info(`Pre-trimming command: ${preTrimCommand}`);
      execSync(preTrimCommand);
      
      if (validFile(preTrimPath)) {
        inputForEncoding = preTrimPath;
        if (verbose) logger.info(`Successfully pre-trimmed ${media.title} to 10 minutes for faster processing`);
      } else {
        logger.error(`Failed to pre-trim ${media.title}, using original file}`);
      }
    } catch (error) {
      logger.error(`Error pre-trimming ${media.title}: ${error}`);
      // Continue with original file if pre-trimming fails
    }
  }
  
  // Try various encoding settings until successful
  const attempts = [
    // First attempt: 720p high quality
    { 
      height: 720, 
      videoQuality: 'high',     // Quality-based parameter for VBR (CQ 23)
      audioQuality: 'high', 
      preset: isVideo ? 'p1' : undefined, 
      trimDuration: null 
    },
    // Second attempt: 720p medium quality
    { 
      height: 720, 
      videoQuality: 'medium',   // Quality-based parameter for VBR (CQ 28)
      audioQuality: 'medium', 
      preset: isVideo ? 'p2' : undefined, 
      trimDuration: null 
    },
    // Third attempt: 360p low quality
    { 
      height: 360, 
      videoQuality: 'low',      // Quality-based parameter for VBR (CQ 35)
      audioQuality: 'low', 
      preset: isVideo ? 'p3' : undefined, 
      trimDuration: null 
    },
    // Fourth attempt: 360p very low quality
    { 
      height: 360, 
      videoQuality: 'very-low', // Quality-based parameter for VBR (CQ 42)
      audioQuality: 'very-low', 
      preset: isVideo ? 'p4' : undefined, 
      trimDuration: null 
    },
    // Fifth attempt: 360p extremely low quality
    { 
      height: 360, 
      videoQuality: 'extremely-low', // Quality-based parameter for VBR (CQ 50)
      audioQuality: 'extremely-low', 
      preset: isVideo ? 'p4' : undefined, 
      trimDuration: null 
    },
    // Sixth attempt: 360p extremely low quality + trim to 4 minutes (240s)
    { 
      height: 360, 
      videoQuality: 'extremely-low', // Quality-based parameter for VBR (CQ 50)
      audioQuality: 'extremely-low', 
      preset: isVideo ? 'p4' : undefined, 
      trimDuration: 240 
    },
    // Seventh attempt: 360p extremely low quality + trim to 2 minutes (120s)
    { 
      height: 360, 
      videoQuality: 'extremely-low', 
      audioQuality: 'extremely-low', 
      preset: isVideo ? 'p4' : undefined, 
      trimDuration: 120 
    },
    // Eighth attempt: 360p extremely low quality + trim to 1 minute (60s)
    { 
      height: 240, // Even lower resolution for last attempt
      videoQuality: 'extremely-low', 
      audioQuality: 'extremely-low', 
      preset: isVideo ? 'p4' : undefined, 
      trimDuration: 60 
    }
  ];
  
  // Track the file size of the previous attempt to display in logs
  let previousFileSizeMB = 0;
  let previousFileSizeText = "";
  
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    
    // Skip the final trim attempt if file is already under 4 minutes
    if (attempt.trimDuration && duration <= attempt.trimDuration) {
      if (verbose) logger.info(`Skipping trim attempt for ${media.title} as it's already shorter than ${attempt.trimDuration}s`);
      continue;
    }
    
    // Show previous attempt file size in the log if available
    if (previousFileSizeText) {
      logger.info(`Processing ${media.title} (attempt ${i+1}/${attempts.length})${attempt.trimDuration ? ` with ${attempt.trimDuration}s trim` : ''} [Previous: ${previousFileSizeText}]`);
    } else {
      logger.info(`Processing ${media.title} (attempt ${i+1}/${attempts.length})${attempt.trimDuration ? ` with ${attempt.trimDuration}s trim` : ''}`);
    }
    
    try {
      const success = await encodeMedia(
        inputForEncoding,
        tempOutputPath, 
        isVideo,
        hasNvenc, 
        attempt.height,
        attempt.videoQuality,
        attempt.audioQuality,
        attempt.preset,
        attempt.trimDuration,
        verbose
      );
      
      if (success) {
        // Calculate the actual temp output path based on media type
        let actualTempPath;
        if (!isVideo) {
          // For audio, always use .ogg extension
          actualTempPath = tempOutputPath.replace(/\.(wav|mp3|ogg|flac|m4a|aac)$/i, '.ogg');
        } else {
          // For video, always use .mp4 extension
          actualTempPath = tempOutputPath.replace(/\.(webm|mov|mkv|flv|avi|wmv|mp4|m4v)$/i, '.mp4');
        }
          
        // Check if file exists
        if (!validFile(actualTempPath)) {
          logger.error(`Expected output file not found: ${actualTempPath}`);
          continue;
        }
          
        // Check if file size is acceptable
        const stats = fs.statSync(actualTempPath);
        const fileSizeMB = Math.round(stats.size / 1024 / 1024 * 100) / 100;
        const fileSizeText = `${fileSizeMB}MB`;
        
        // Update previous file size for next attempt log
        previousFileSizeMB = fileSizeMB;
        previousFileSizeText = fileSizeText;
        
        if (stats.size <= MAX_FILE_SIZE_BYTES) {
          // Move from temp to final location
          fs.renameSync(actualTempPath, finalOutputPath);
          
          // Update database with the relative path - ensure consistent extension
          const relativePath = path.relative(process.cwd(), finalOutputPath);
          
          // Update the media object with the new path
          await saveMedia({
            id: media.id,
            normalizedPath: relativePath
          });
          
          logger.info(`Successfully normalized ${media.title} (${fileSizeText})`);
          return true;
        } else {
          // Always show file size info, regardless of verbose mode
          logger.info(`File still too large (${fileSizeText} > ${MAX_FILE_SIZE_MB}MB), trying next settings`);
          // Continue to next attempt
        }
      }
    } catch (error) {
      logger.error(`Error processing ${media.title} (attempt ${i+1}): ${error}`);
    }
  }
  
  // Cleanup pre-trimmed file if it exists
  if (inputForEncoding !== originalPath && fs.existsSync(preTrimPath)) {
    try {
      fs.unlinkSync(preTrimPath);
      if (verbose) logger.info(`Cleaned up pre-trimmed file: ${preTrimPath}`);
    } catch (error) {
      logger.error(`Error cleaning up pre-trimmed file: ${error}`);
    }
  }
  
  logger.error(`Failed to normalize ${media.title} after all attempts`);
  return false;
}

/**
 * Process a single file without database involvement
 */
export async function processSingleFile(
  filePath: string, 
  outputDir: string = NORMALIZED_DIR,
  verbose: boolean = false
): Promise<string | null> {
  // Skip if file doesn't exist
  if (!validFile(filePath)) {
    logger.error(`File does not exist or is empty: ${filePath}`);
    return null;
  }
  
  // Create a temporary Media object
  const fileName = path.basename(filePath);
  const tempMedia: Media = {
    id: 0, // Temporary ID that won't be used
    filePath: filePath,
    title: fileName,
    normalizedPath: null,
    uncompressedPath: null, // Add this required property
    year: null, // Add this required property
    metadata: {},
    createdAt: new Date()
  };
  
  // Make sure the output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Check if NVIDIA GPU is available
  const hasNvenc = await hasNvidiaGpu();
  
  // Process the file
  logger.info(`Processing standalone file: ${filePath}`);
  const success = await processMediaFile(tempMedia, hasNvenc, verbose);
  
  if (success && tempMedia.normalizedPath) {
    logger.info(`Successfully normalized ${filePath} to ${tempMedia.normalizedPath}`);
    return path.join(process.cwd(), tempMedia.normalizedPath);
  }
  
  return null;
}

/**
 * Normalize a media file to be compatible with Discord
 * This is the main entry point for external modules
 * 
 * @param filePath Path to the media file
 * @param options Optional settings
 * @returns Path to the normalized file (or original if already normalized)
 */
export async function normalizeMedia(
  filePath: string, 
  options: { outputDir?: string; verbose?: boolean } = {}
): Promise<string> {
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  // Check if file is already under the size limit
  const stats = fs.statSync(filePath);
  if (stats.size <= MAX_FILE_SIZE_BYTES) {
    logger.info(`File ${filePath} is already under size limit (${Math.round(stats.size / 1024 / 1024 * 100) / 100}MB), no need to normalize`);
    return filePath;
  }
  
  // Process the file
  const outputDir = options.outputDir || NORMALIZED_DIR;
  const normalizedPath = await processSingleFile(filePath, outputDir, options.verbose);
  
  if (normalizedPath) {
    return normalizedPath;
  } else {
    throw new Error(`Failed to normalize media file: ${filePath}`);
  }
}

/**
 * Normalize a media file only if it exceeds the size limit
 * 
 * @param filePath Path to the media file
 * @param options Optional settings
 * @returns Path to the normalized file (or original if already under limit)
 */
export async function normalizeMediaIfNeeded(
  filePath: string, 
  options: { outputDir?: string; verbose?: boolean } = {}
): Promise<string> {
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  // Check if file is already under the size limit
  const stats = fs.statSync(filePath);
  if (stats.size <= MAX_FILE_SIZE_BYTES) {
    logger.info(`File ${filePath} is already under size limit (${Math.round(stats.size / 1024 / 1024 * 100) / 100}MB), no need to normalize`);
    return filePath;
  }
  
  // File needs normalization
  return normalizeMedia(filePath, options);
}

/**
 * Process all media in the database
 * This is used by the CLI tool
 */
export async function processAllMedia(verbose = false): Promise<{
  total: number;
  skipped: number;
  success: number;
  failed: number;
}> {
  logger.info('Starting media normalization process');
  
  // Make sure directories exist
  ensureDirectoriesExist();
  
  // Check for NVIDIA GPU
  const hasNvenc = await hasNvidiaGpu();
  logger.info(`NVIDIA GPU encoding: ${hasNvenc ? 'Available' : 'Not available'}`);
  
  // Get all media records from the database using our new repository
  // Use require instead of dynamic import to avoid TS errors
  const connection = require('../../database/connection.js');
  const allMedia = await connection.getQuery('SELECT * FROM media');
  
  logger.info(`Found ${allMedia.length} media files to process`);
  
  // Process each media file
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  
  for (let i = 0; i < allMedia.length; i++) {
    const media = allMedia[i];
    
    // Quick check if already normalized to avoid excessive logging
    if (media.normalizedPath && validFile(path.join(process.cwd(), media.normalizedPath))) {
      if (verbose) logger.info(`Processing ${i+1}/${allMedia.length}: ${media.title}`);
      if (verbose) logger.info(`File already normalized: ${media.title}`);
      skippedCount++;
      continue;
    }
    
    // Only show progress for files that actually need processing
    logger.info(`Processing ${i+1}/${allMedia.length}: ${media.title}`);
    
    const success = await processMediaFile(media, hasNvenc, verbose);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }
  
  // Show summary statistics at end of run
  logger.info('==========================================');
  logger.info('Media Normalization Summary:');
  logger.info(`Total files: ${allMedia.length}`);
  logger.info(`Already normalized (skipped): ${skippedCount}`);
  logger.info(`Successfully normalized: ${successCount}`);
  logger.info(`Failed to normalize: ${failCount}`);
  logger.info('==========================================');
  
  return {
    total: allMedia.length,
    skipped: skippedCount,
    success: successCount,
    failed: failCount
  };
}