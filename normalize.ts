#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { AppDataSource } from './src/database/connection';
import { Media } from './src/database/entities/Media';
import { logger } from './src/utils/logger';

// Constants
const MAX_FILE_SIZE_MB = 9;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const NORMALIZED_DIR = process.env.NORMALIZED_DIR || './normalized';
const TEMP_DIR = process.env.TEMP_DIR || './temp';
const FFMPEG_LOG_LEVEL = 'warning'; // Options: quiet, panic, fatal, error, warning, info, verbose, debug, trace

// Ensure directories exist
function ensureDirectoriesExist() {
  if (!fs.existsSync(NORMALIZED_DIR)) {
    fs.mkdirSync(NORMALIZED_DIR, { recursive: true });
  }
  
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

// Check if NVIDIA GPU encoding is available
function hasNvidiaGpuEncoder(): boolean {
  try {
    const output = execSync('ffmpeg -encoders | grep nvenc').toString();
    return output.includes('nvenc');
  } catch (error) {
    logger.info('NVIDIA hardware encoding not available, will use software encoding');
    return false;
  }
}

// Check if file exists and is not empty
function validFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch (error) {
    return false;
  }
}

// Get media duration using ffprobe
function getMediaDuration(filePath: string): number {
  try {
    const output = execSync(`ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`).toString().trim();
    return parseFloat(output);
  } catch (error) {
    logger.error(`Error getting duration for ${filePath}: ${error}`);
    return 0;
  }
}

// Process a single media file
async function processMediaFile(media: Media, hasNvenc: boolean): Promise<boolean> {
  const originalPath = media.filePath;
  
  // Skip if file doesn't exist
  if (!validFile(originalPath)) {
    logger.error(`File does not exist or is empty: ${originalPath}`);
    return false;
  }
  
  // Skip if already processed
  if (media.normalizedPath && validFile(path.join(process.cwd(), media.normalizedPath))) {
    logger.info(`File already normalized: ${media.title}`);
    return true;
  }
  
  // Determine the output file path (in normalized dir)
  const fileName = path.basename(originalPath);
  const outputPath = path.join(NORMALIZED_DIR, fileName);
  const tempOutputPath = path.join(TEMP_DIR, `temp_${fileName}`);
  
  // Get the duration of the input file
  const duration = getMediaDuration(originalPath);
  if (duration === 0) {
    logger.error(`Couldn't determine duration for ${originalPath}`);
    return false;
  }
  
  // Determine if it's video or audio
  const isVideo = await isVideoFile(originalPath);
  
  // Try various encoding settings until successful
  const attempts = [
    // First attempt: 720p high quality
    { height: 720, videoBitrate: '1500k', audioBitrate: '128k', preset: isVideo ? 'p1' : undefined, trimDuration: null },
    // Second attempt: 720p medium quality
    { height: 720, videoBitrate: '1000k', audioBitrate: '96k', preset: isVideo ? 'p2' : undefined, trimDuration: null },
    // Third attempt: 360p lower quality
    { height: 360, videoBitrate: '800k', audioBitrate: '64k', preset: isVideo ? 'p3' : undefined, trimDuration: null },
    // Final attempt: 360p lower quality + trim to 4 minutes
    { height: 360, videoBitrate: '800k', audioBitrate: '64k', preset: isVideo ? 'p3' : undefined, trimDuration: 240 }
  ];
  
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    
    // Skip the final trim attempt if file is already under 4 minutes
    if (attempt.trimDuration && duration <= attempt.trimDuration) {
      logger.info(`Skipping trim attempt for ${media.title} as it's already shorter than ${attempt.trimDuration}s`);
      continue;
    }
    
    logger.info(`Processing ${media.title} (attempt ${i+1}/${attempts.length})${attempt.trimDuration ? ` with ${attempt.trimDuration}s trim` : ''}`);
    
    try {
      const success = await encodeMedia(
        originalPath, 
        tempOutputPath, 
        isVideo,
        hasNvenc, 
        attempt.height,
        attempt.videoBitrate,
        attempt.audioBitrate,
        attempt.preset,
        attempt.trimDuration
      );
      
      if (success) {
        // Check if file size is acceptable
        const stats = fs.statSync(tempOutputPath);
        if (stats.size <= MAX_FILE_SIZE_BYTES) {
          // Move from temp to final location
          fs.renameSync(tempOutputPath, outputPath);
          
          // Update database with the relative path
          const relativePath = path.relative(process.cwd(), outputPath);
          media.normalizedPath = relativePath;
          await AppDataSource.getRepository(Media).save(media);
          
          logger.info(`Successfully normalized ${media.title} (${Math.round(stats.size / 1024 / 1024 * 100) / 100}MB)`);
          return true;
        } else {
          logger.info(`File still too large (${Math.round(stats.size / 1024 / 1024 * 100) / 100}MB > ${MAX_FILE_SIZE_MB}MB), trying next settings`);
          // Continue to next attempt
        }
      }
    } catch (error) {
      logger.error(`Error processing ${media.title} (attempt ${i+1}): ${error}`);
    }
  }
  
  logger.error(`Failed to normalize ${media.title} after all attempts`);
  return false;
}

// Check if file is video or audio
async function isVideoFile(filePath: string): Promise<boolean> {
  try {
    const output = execSync(`ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${filePath}"`).toString().trim();
    return output.includes('video');
  } catch (error) {
    return false; // Assume audio if we can't determine
  }
}

// Encode media file with given settings
async function encodeMedia(
  inputPath: string,
  outputPath: string,
  isVideo: boolean,
  hasNvenc: boolean,
  height: number,
  videoBitrate: string,
  audioBitrate: string,
  preset?: string,
  trimDuration?: number | null
): Promise<boolean> {
  try {
    let command = `ffmpeg -y -i "${inputPath}" -hide_banner -loglevel ${FFMPEG_LOG_LEVEL}`;
    
    // Add trim duration if specified
    if (trimDuration) {
      logger.info(`Trimming to ${trimDuration} seconds`);
      command += ` -t ${trimDuration}`;
    }
    
    if (isVideo) {
      // Video encoding settings
      if (hasNvenc) {
        // Use NVIDIA hardware acceleration
        command += ` -c:v h264_nvenc -preset ${preset || 'p1'} -rc vbr -b:v ${videoBitrate}`;
        command += ` -maxrate:v ${parseInt(videoBitrate) * 1.5}k -bufsize ${parseInt(videoBitrate) * 2}k`;
        command += ' -spatial-aq 1 -temporal-aq 1';
      } else {
        // Software encoding fallback
        command += ` -c:v libx264 -preset medium -crf 23 -b:v ${videoBitrate}`;
        command += ` -maxrate:v ${parseInt(videoBitrate) * 1.5}k -bufsize ${parseInt(videoBitrate) * 2}k`;
      }
      
      // Common video settings
      command += ` -vf "scale=-1:${height},format=yuv420p"`;
      command += ' -movflags +faststart';
    } else {
      // Audio-only, copy video stream if it exists
      command += ' -vn';
    }
    
    // Audio settings (always use opus)
    command += ` -c:a libopus -b:a ${audioBitrate} -vbr on -compression_level 10 -application audio`;
    
    // Output file
    command += ` "${outputPath}"`;
    
    // Execute the command
    execSync(command);
    
    // Check if the output file exists and has content
    return validFile(outputPath);
  } catch (error) {
    logger.error(`FFmpeg encoding error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// Main function to process all media
async function processAllMedia() {
  logger.info('Starting media normalization process');
  
  // Initialize database connection
  await AppDataSource.initialize();
  
  // Make sure directories exist
  ensureDirectoriesExist();
  
  // Check for NVIDIA GPU
  const hasNvenc = hasNvidiaGpuEncoder();
  logger.info(`NVIDIA GPU encoding: ${hasNvenc ? 'Available' : 'Not available'}`);
  
  // Get all media records from the database
  const mediaRepository = AppDataSource.getRepository(Media);
  const allMedia = await mediaRepository.find();
  
  logger.info(`Found ${allMedia.length} media files to process`);
  
  // Process each media file
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < allMedia.length; i++) {
    const media = allMedia[i];
    logger.info(`Processing ${i+1}/${allMedia.length}: ${media.title}`);
    
    const success = await processMediaFile(media, hasNvenc);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }
  
  logger.info(`Normalization complete. Success: ${successCount}, Failed: ${failCount}`);
  
  // Close database connection
  await AppDataSource.destroy();
}

// Run the main function
processAllMedia()
  .then(() => {
    logger.info('Media normalization process completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error(`Error in media normalization process: ${error}`);
    process.exit(1);
  });