// filepath: /home/lody/now/src/media/visualizer.ts
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const THUMBNAILS_DIR = path.join(process.cwd(), 'thumbnails');
const TEMP_DIR = path.join(process.cwd(), 'temp');

// Ensure directories exist
[THUMBNAILS_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

interface MediaItem {
  id: number;
  title: string;
  filePath: string;
  normalizedPath?: string;
}

/**
 * Generate waveform visualization for any media file
 */
export const generateWaveformForMedia = async (media: MediaItem): Promise<string> => {
  // Use normalized path if available, otherwise use original
  const mediaPath = getMediaPath(media);
  
  // Generate a random ID to prevent filename conflicts
  const randomId = crypto.randomBytes(4).toString('hex');
  const outputFilename = `temp_${randomId}_${path.basename(mediaPath)}_waveform.png`;
  const outputPath = path.join(THUMBNAILS_DIR, outputFilename);
  
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(mediaPath)
        .outputOptions([
          '-filter_complex', 'compand,showwavespic=s=640x480:colors=blue|lightblue',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
    
    return outputPath;
  } catch (error) {
    console.error(`Error generating waveform for ${media.title}:`, error);
    throw new Error(`Failed to generate waveform: ${(error as Error).message}`);
  }
};

/**
 * Generate spectrogram visualization for any media file
 */
export const generateSpectrogramForMedia = async (media: MediaItem): Promise<string> => {
  // Use normalized path if available, otherwise use original
  const mediaPath = getMediaPath(media);
  
  // Generate a random ID to prevent filename conflicts
  const randomId = crypto.randomBytes(4).toString('hex');
  const outputFilename = `temp_${randomId}_${path.basename(mediaPath)}_spectrogram.png`;
  const outputPath = path.join(THUMBNAILS_DIR, outputFilename);
  
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(mediaPath)
        .outputOptions([
          '-lavfi', 'showspectrumpic=s=640x480',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
    
    return outputPath;
  } catch (error) {
    console.error(`Error generating spectrogram for ${media.title}:`, error);
    throw new Error(`Failed to generate spectrogram: ${(error as Error).message}`);
  }
};

/**
 * Helper function to get the correct media path
 */
const getMediaPath = (media: MediaItem): string => {
  if (media.normalizedPath) {
    const filename = path.basename(media.normalizedPath);
    // Ensure normalized path starts with 'norm_'
    const normalizedFilename = filename.startsWith('norm_') ? filename : `norm_${filename}`;
    return path.join(process.cwd(), 'normalized', normalizedFilename);
  }
  return media.filePath;
};