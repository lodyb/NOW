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

// Target directory for clips
const CLIPS_DIR = path.resolve(process.env.NORMALIZED_DIR || './normalized', 'clips');

// Create clips directory if it doesn't exist
if (!fs.existsSync(CLIPS_DIR)) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

/**
 * Extracts metadata from a media file
 * @param filePath Path to the media file
 * @returns Duration in seconds
 */
export async function getMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: Error | null, metadata: any) => {
      if (err) {
        reject(new Error(`Error probing media file: ${err.message}`));
        return;
      }
      
      const duration = metadata.format.duration;
      if (typeof duration !== 'number' || isNaN(duration)) {
        reject(new Error('Could not determine media duration'));
        return;
      }
      
      resolve(duration);
    });
  });
}

/**
 * Creates a clip from a media file
 * @param filePath Path to the media file
 * @param duration Duration of the clip in seconds
 * @param startPosition Start position in seconds (random if not specified)
 * @returns Path to the generated clip
 */
export async function createClip(
  filePath: string,
  duration: number,
  startPosition?: number | null
): Promise<string> {
  // Validate input
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  // Default to a reasonable clip duration
  if (!duration || duration <= 0) {
    duration = 5; // Default to 5 seconds
  }
  
  // Cap the clip duration at 30 seconds for safety
  duration = Math.min(duration, 30);
  
  // Determine total media duration and validate start position
  const totalDuration = await getMediaDuration(filePath);
  
  // If start position is not specified, pick a random point
  if (startPosition === undefined || startPosition === null) {
    // Leave some buffer at the end to fit the clip duration
    const maxStart = Math.max(0, totalDuration - duration);
    startPosition = Math.floor(Math.random() * maxStart);
  }
  
  // Make sure start position is within bounds
  startPosition = Math.max(0, Math.min(startPosition, totalDuration - 1));
  
  // Cap the duration to not exceed the file length
  duration = Math.min(duration, totalDuration - startPosition);
  
  // Generate output file name
  const ext = path.extname(filePath);
  const timestamp = Date.now();
  const outputFileName = `clip_${timestamp}_${startPosition.toFixed(1)}_${duration.toFixed(1)}${ext}`;
  const outputPath = path.join(CLIPS_DIR, outputFileName);
  
  // Generate the clip
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .setStartTime(startPosition)
      .setDuration(duration)
      .output(outputPath)
      .noVideo() // Audio only for clips - remove this line if you want video as well
      .audioCodec('libopus') // Use Discord-compatible codec
      .outputOptions([
        '-map_metadata -1', // Remove metadata
        '-b:a 128k'         // Set audio bitrate
      ])
      .on('error', (err: Error) => {
        logger.error(`Error creating clip: ${err.message}`);
        reject(new Error(`Error creating clip: ${err.message}`));
      })
      .on('end', () => {
        logger.info(`Successfully created clip at ${outputPath}`);
        resolve(outputPath);
      })
      .run();
  });
}