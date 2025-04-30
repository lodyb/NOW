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

// Get video dimensions using ffprobe
function getVideoDimensions(filePath: string): { width: number; height: number } {
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
  
  // Determine final output path - for audio files, we convert to .ogg
  let finalOutputPath = outputPath;
  const inputExt = path.extname(originalPath).toLowerCase();
  if (!isVideo) {
    // For audio files, we'll output as .ogg with Opus codec
    finalOutputPath = outputPath.replace(/\.(wav|mp3|ogg|flac|m4a)$/i, '.ogg');
    logger.info(`Will convert ${inputExt} to .ogg with Opus codec for better compatibility`);
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
    // Final attempt: 360p extremely low quality + trim to 4 minutes
    { 
      height: 360, 
      videoQuality: 'extremely-low', // Quality-based parameter for VBR (CQ 50)
      audioQuality: 'extremely-low', 
      preset: isVideo ? 'p4' : undefined, 
      trimDuration: 240 
    }
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
        attempt.videoQuality,
        attempt.audioQuality,
        attempt.preset,
        attempt.trimDuration
      );
      
      if (success) {
        // Check the actual temp output path (might have changed extension)
        const actualTempPath = !isVideo
          ? tempOutputPath.replace(/\.(wav|mp3|ogg|flac|m4a)$/i, '.ogg') 
          : tempOutputPath;
          
        // Check if file exists
        if (!validFile(actualTempPath)) {
          logger.error(`Expected output file not found: ${actualTempPath}`);
          continue;
        }
          
        // Check if file size is acceptable
        const stats = fs.statSync(actualTempPath);
        if (stats.size <= MAX_FILE_SIZE_BYTES) {
          // Move from temp to final location
          fs.renameSync(actualTempPath, finalOutputPath);
          
          // Update database with the relative path
          // For audio files, make sure we're using the .ogg extension in the database
          const dbPath = !isVideo 
            ? finalOutputPath.replace(/\.(wav|mp3|ogg|flac|m4a)$/i, '.ogg')
            : finalOutputPath;
            
          const relativePath = path.relative(process.cwd(), dbPath);
          media.normalizedPath = relativePath;
          
          logger.info(`Saving path in database: ${relativePath}`);
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
  videoQuality: string,
  audioQuality: string,
  preset?: string,
  trimDuration?: number | null
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
      logger.info(`Converting audio from ${inputExt} to .ogg with Opus codec for better compatibility`);
    }
    
    let command = `ffmpeg -y -i "${inputPath}" -hide_banner -loglevel ${FFMPEG_LOG_LEVEL}`;
    
    // Add trim duration if specified
    if (trimDuration) {
      logger.info(`Trimming to ${trimDuration} seconds`);
      command += ` -t ${trimDuration}`;
    }
    
    if (isVideo) {
      // Get original video dimensions
      const dimensions = getVideoDimensions(inputPath);
      logger.info(`Original video dimensions: ${dimensions.width}x${dimensions.height}`);
      
      // Only scale if original is larger than target dimensions
      if (dimensions.width > 1280 || dimensions.height > 720) {
        // Video scale filter - we'll use 1280x720 as the maximum resolution
        // Use single quotes around the scale arguments to ensure proper parsing
        command += ` -vf "scale=w='min(1280,iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease,format=yuv420p"`;
        logger.info(`Scaling video to max dimensions 1280x${height}`);
      } else {
        // Keep original resolution but ensure yuv420p pixel format
        command += ` -vf "format=yuv420p"`;
        logger.info(`Keeping original resolution ${dimensions.width}x${dimensions.height}`);
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
        audioBitrate = '128k';
        opusQuality = 3;  // Best quality
      } else if (audioQuality === 'medium') {
        audioBitrate = '96k';
        opusQuality = 4;
      } else if (audioQuality === 'low') {
        audioBitrate = '64k';
        opusQuality = 5;
      } else if (audioQuality === 'very-low') {
        audioBitrate = '48k';
        opusQuality = 6;
      } else { // extremely-low
        audioBitrate = '32k';
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
    logger.info(`Running: ${command}`);
    execSync(command);
    
    // Check if the output file exists and has content
    return validFile(tempOutputPath);
  } catch (error) {
    logger.error(`FFmpeg encoding error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// Helper function to determine the quality level based on the bitrate
function getQualityLevel(videoBitrate: string): number {
  // For NVENC, CQ values range from 1 (best) to 51 (worst)
  // For libx264, CRF values also range from 1 (best) to 51 (worst)
  // We'll use more reasonable ranges in the middle to ensure good quality
  
  if (videoBitrate === '1500k') {
    return 23; // High quality (good compromise for first attempt)
  } else if (videoBitrate === '1000k') {
    return 28; // Medium quality
  } else {
    return 33; // Lower quality
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