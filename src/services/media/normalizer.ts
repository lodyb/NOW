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

/**
 * Normalizes a media file for consistent playback on Discord
 * @param filePath Path to the original media file
 * @param outputDir Directory to save normalized file
 * @returns Path to the normalized file
 */
export async function normalizeMedia(
  filePath: string,
  outputDir: string = process.env.NORMALIZED_DIR || './normalized'
): Promise<string> {
  // Validate input
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Get file metadata for determining encoding settings
  const metadata = await getMediaMetadata(filePath);
  
  // Determine if this is a video or audio file
  const isVideo = metadata.streams.some((stream: any) => stream.codec_type === 'video');
  
  // Generate output filename
  const fileName = path.basename(filePath);
  let command = ffmpeg(filePath);
  
  // Set up output path
  const outputPath = path.join(outputDir, fileName);
  
  // Set common options
  command
    .outputOptions('-map_metadata -1') // Strip metadata
    .output(outputPath);
  
  if (isVideo) {
    // Video-specific settings
    command
      .videoCodec('libx264')
      .size('?x720') // Max height 720px, maintain aspect ratio
      .videoBitrate('1500k')
      .audioCodec('libopus')
      .audioBitrate('128k')
      .outputOptions([
        '-pix_fmt yuv420p', // Widely compatible pixel format
        '-preset medium',   // Encoding speed/quality tradeoff
        '-movflags +faststart' // Enable streaming
      ]);
  } else {
    // Audio-specific settings
    command
      .audioCodec('libopus')
      .audioBitrate('128k');
  }
  
  // Run the first encoding attempt
  try {
    await runFFmpegCommand(command);
    
    // Check if the file is under Discord's size limit (9MB by default)
    const maxSize = (parseInt(process.env.MAX_FILE_SIZE || '9') * 1024 * 1024);
    const fileSize = fs.statSync(outputPath).size;
    
    if (fileSize <= maxSize) {
      // First attempt successful, return the path
      return outputPath;
    }
    
    // If we're here, file is too large - need a second attempt with more compression
    logger.info(`First encoding of ${fileName} resulted in ${fileSize} bytes, exceeding the limit of ${maxSize}. Retrying with higher compression.`);
    
    // Second encoding attempt with reduced quality
    const secondAttemptPath = outputPath.replace(fileName, `compressed_${fileName}`);
    
    let secondCommand = ffmpeg(outputPath);
    
    if (isVideo) {
      // More aggressive video compression
      secondCommand
        .videoCodec('libx264')
        .size('?x360') // Reduce resolution further
        .videoBitrate('800k')
        .audioCodec('libopus')
        .audioBitrate('96k')
        .outputOptions([
          '-pix_fmt yuv420p',
          '-preset faster',   // Faster encoding, lower quality
          '-movflags +faststart',
          '-max_muxing_queue_size 9999' // Prevent muxing errors
        ]);
    } else {
      // More aggressive audio compression
      secondCommand
        .audioCodec('libopus')
        .audioBitrate('96k');
    }
    
    secondCommand.output(secondAttemptPath);
    
    await runFFmpegCommand(secondCommand);
    
    // Check file size again
    const secondFileSize = fs.statSync(secondAttemptPath).size;
    
    if (secondFileSize <= maxSize) {
      // Delete the first attempt to save space
      fs.unlinkSync(outputPath);
      return secondAttemptPath;
    }
    
    // If we're still here, try a third attempt with extreme compression or truncation
    logger.info(`Second encoding of ${fileName} resulted in ${secondFileSize} bytes, still exceeding the limit. Final attempt.`);
    
    // For final attempt, trim the duration to 4 minutes if longer
    const originalDuration = parseFloat(metadata.format.duration || '0');
    const maxDuration = 240; // 4 minutes in seconds
    
    // Only trim if needed and if the duration is valid
    const needsTrimming = originalDuration > maxDuration && originalDuration !== 0;
    
    // Final attempt path
    const finalAttemptPath = outputPath.replace(fileName, `final_${fileName}`);
    
    let finalCommand = ffmpeg(secondAttemptPath)
      .outputOptions('-map_metadata -1') // Strip metadata again
      .output(finalAttemptPath);
    
    if (isVideo) {
      // Extreme video compression
      finalCommand
        .videoCodec('libx264')
        .size('?x240') // Reduce resolution to minimum
        .videoBitrate('500k')
        .audioCodec('libopus')
        .audioBitrate('64k')
        .outputOptions([
          '-pix_fmt yuv420p',
          '-preset veryfast',
          '-crf 30', // High compression, lower quality
          '-movflags +faststart'
        ]);
    } else {
      // Extreme audio compression
      finalCommand
        .audioCodec('libopus')
        .audioBitrate('64k');
    }
    
    // Add duration limit if needed
    if (needsTrimming) {
      finalCommand.setDuration(maxDuration);
    }
    
    await runFFmpegCommand(finalCommand);
    
    // Clean up intermediate files
    fs.unlinkSync(outputPath);
    fs.unlinkSync(secondAttemptPath);
    
    return finalAttemptPath;
    
  } catch (error) {
    logger.error(`Error normalizing media: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`Error normalizing media: ${error instanceof Error ? error.message : String(error)}`);
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