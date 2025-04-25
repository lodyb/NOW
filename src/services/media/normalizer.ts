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
 * Normalizes a media file for consistent playback on Discord
 * Currently just copies the file instead of normalizing
 * @param filePath Path to the original media file
 * @param outputDir Directory to save normalized file
 * @returns Path to the normalized (or copied) file
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
  
  // Skip normalization for now - just copy the file
  const fileName = path.basename(filePath);
  const outputPath = path.join(outputDir, fileName);
  
  // Don't overwrite if file already exists
  if (fs.existsSync(outputPath)) {
    logger.info(`File ${outputPath} already exists, skipping copy`);
    return outputPath;
  }
  
  // Copy file instead of normalizing
  logger.info(`Copying file instead of normalizing: ${filePath} -> ${outputPath}`);
  fs.copyFileSync(filePath, outputPath);
  return outputPath;
}

/**
 * Normalizes a media file if it exceeds Discord's file size limit
 * Uses NVIDIA hardware acceleration if available
 * @param filePath Path to the original media file
 * @param outputDir Directory to save normalized file
 * @returns Path to the normalized file
 */
export async function normalizeMediaIfNeeded(
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
  
  // Check file size
  const stats = fs.statSync(filePath);
  const maxSize = (parseInt(process.env.MAX_FILE_SIZE || '9') * 1024 * 1024);
  
  // If file is under size limit, just copy it
  if (stats.size <= maxSize) {
    const fileName = path.basename(filePath);
    const outputPath = path.join(outputDir, fileName);
    
    // Don't overwrite if file already exists
    if (fs.existsSync(outputPath)) {
      logger.info(`File ${outputPath} already exists, skipping copy`);
      return outputPath;
    }
    
    logger.info(`File is under size limit (${stats.size} bytes), copying instead of normalizing`);
    fs.copyFileSync(filePath, outputPath);
    return outputPath;
  }
  
  // File exceeds size limit, need to normalize
  logger.info(`File exceeds size limit (${stats.size} bytes > ${maxSize} bytes), normalizing`);
  
  // Get file metadata
  const metadata = await getMediaMetadata(filePath);
  
  // Determine if this is a video or audio file
  const isVideo = metadata.streams.some((stream: any) => stream.codec_type === 'video');
  
  // Check if NVIDIA GPU is available
  const hasNvenc = await hasNvidiaGpu();
  
  // Generate output filename
  const fileName = path.basename(filePath);
  const outputPath = path.join(outputDir, `norm_${fileName}`);
  
  let command = ffmpeg(filePath);
  
  if (isVideo) {
    // Get video dimensions
    const videoStream = metadata.streams.find((stream: any) => stream.codec_type === 'video');
    const width = videoStream?.width || 1280;
    const height = videoStream?.height || 720;
    
    // Calculate scale filter to maintain aspect ratio
    const maxHeight = 720;
    const scaleFilter = height > maxHeight ? `scale=-1:${maxHeight}` : 'scale=-1:-1';
    
    if (hasNvenc) {
      // Use NVIDIA hardware acceleration
      command
        .outputOptions([
          '-c:v h264_nvenc',              // nvidia h264 encoder
          '-preset p1',                   // p1 is slowest but highest quality preset
          '-rc vbr',                      // variable bitrate for better quality
          '-b:v 0',                       // let qp control quality
          '-cq 23',                       // quality level (higher = more compression)
          `-maxrate:v ${Math.min(8000, metadata.format.bit_rate ? Math.floor(metadata.format.bit_rate/1000) : 4000)}k`,  // higher max bitrate
          `-bufsize ${Math.min(16000, metadata.format.bit_rate ? Math.floor(metadata.format.bit_rate/500) : 8000)}k`,    // larger buffer for smoother bitrate
          '-spatial-aq 1',                // spatial adaptive quantization for better detail
          '-temporal-aq 1',               // temporal adaptive quantization
          '-aq-strength 15',              // strength of adaptive quantization (higher = stronger)
          '-c:a libopus',                 // opus audio codec
          '-compression_level 8',         // opus compression level (1-10, lower = better)
          '-vbr on',                      // variable bitrate mode
          '-application audio',           // favor quality over speech
          `-vf ${scaleFilter}`,           // scale video if needed
          '-pix_fmt yuv420p',             // widely compatible pixel format
          '-movflags +faststart'          // enable streaming
        ]);
    } else {
      // Fallback to software encoding
      command
        .videoCodec('libx264')
        .size('?x720')                    // Max height 720px, maintain aspect ratio
        .videoBitrate('1500k')
        .audioCodec('libopus')
        .audioBitrate('128k')
        .outputOptions([
          '-pix_fmt yuv420p',             // Widely compatible pixel format
          '-preset medium',               // Encoding speed/quality tradeoff
          '-movflags +faststart'          // Enable streaming
        ]);
    }
  } else {
    // Audio-specific settings
    command
      .audioCodec('libopus')
      .audioBitrate('128k')
      .outputOptions([
        '-compression_level 8',           // opus compression level
        '-vbr on',                        // variable bitrate mode
        '-application audio'              // favor quality over speech
      ]);
  }
  
  // Set output path
  command.output(outputPath);
  
  try {
    // Run the encoding
    await runFFmpegCommand(command);
    
    // Check if the file is still over the limit
    const newSize = fs.statSync(outputPath).size;
    
    if (newSize <= maxSize) {
      return outputPath;
    }
    
    // If still too large, we'll need a more aggressive approach
    // For simplicity now, we'll just warn and return the file anyway
    logger.warn(`File ${outputPath} is still over size limit (${newSize} bytes), but returning anyway`);
    return outputPath;
  } catch (error) {
    logger.error(`Error normalizing media: ${error instanceof Error ? error.message : String(error)}`);
    
    // On error, try to fall back to just copying the file
    logger.info(`Falling back to copying the original file`);
    fs.copyFileSync(filePath, outputPath);
    return outputPath;
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