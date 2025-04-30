import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../../utils/logger';

// Set ffmpeg path if available
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
} else {
  logger.warn('ffmpeg-static path not found, relying on system ffmpeg installation');
}

// Target directory for processed files
const TEMP_DIR = path.resolve(process.cwd(), 'src/services/media/temp');

// Create temp directory if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Apply FFmpeg filters to a media file
 * @param filePath Path to the media file
 * @param options Filter options (e.g., {amplify: 2, reverse: 1})
 * @returns Path to the processed file
 */
export async function processMedia(
  filePath: string,
  options: Record<string, string | number>
): Promise<string> {
  // Validate input
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  if (Object.keys(options).length === 0) {
    return filePath; // No processing needed
  }
  
  // Generate a unique output file name
  const ext = path.extname(filePath);
  const timestamp = Date.now();
  const optionsStr = Object.entries(options)
    .map(([key, value]) => `${key}-${value}`)
    .join('_');
  const outputFileName = `processed_${timestamp}_${optionsStr}${ext}`;
  const outputPath = path.join(TEMP_DIR, outputFileName);
  
  // Build ffmpeg filter complex string
  const filterOptions: string[] = [];
  
  if (options.amplify) {
    const volume = parseFloat(options.amplify as string);
    if (!isNaN(volume)) {
      filterOptions.push(`volume=${volume}`);
    }
  }
  
  if (options.reverse && options.reverse === '1') {
    filterOptions.push('areverse');
  }
  
  if (options.speed) {
    const speed = parseFloat(options.speed as string);
    if (!isNaN(speed) && speed > 0) {
      // atempo must be between 0.5 and 2.0, chain for more extreme values
      let tempoFilter = '';
      let remainingSpeed = speed;
      
      while (remainingSpeed > 2.0) {
        tempoFilter += 'atempo=2.0,';
        remainingSpeed /= 2.0;
      }
      
      while (remainingSpeed < 0.5) {
        tempoFilter += 'atempo=0.5,';
        remainingSpeed *= 2.0;
      }
      
      tempoFilter += `atempo=${remainingSpeed.toFixed(2)}`;
      filterOptions.push(tempoFilter);
    }
  }
  
  if (options.pitch) {
    const semitones = parseFloat(options.pitch as string);
    if (!isNaN(semitones)) {
      filterOptions.push(`asetrate=44100*2^(${semitones}/12),aresample=44100`);
    }
  }
  
  const filterComplex = filterOptions.join(',');
  
  // Create FFmpeg command
  const command = ffmpeg(filePath);
  
  if (filterComplex) {
    command.audioFilters(filterComplex);
  }
  
  // Set output options and format
  command
    .outputOptions(['-map_metadata -1']) // Remove metadata
    .output(outputPath)
    .format(ext.substring(1));
  
  // Execute the command
  return new Promise((resolve, reject) => {
    command
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err: Error) => {
        reject(new Error(`Error processing media: ${err.message}`));
      })
      .run();
  });
}