import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

/**
 * Generate a random frame from a video file and return as Buffer
 */
export async function generateRandomFrame(videoPath: string): Promise<Buffer | null> {
  try {
    // First check if the file has video streams
    const probeCmd = `ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_type -of csv="p=0" "${videoPath}"`;
    try {
      const { stdout: streamOutput } = await execAsync(probeCmd);
      if (!streamOutput.trim() || streamOutput.trim() !== 'video') {
        console.log('File has no video stream, skipping frame extraction');
        return null;
      }
    } catch (probeError) {
      console.log('Could not probe video streams, file likely has no video');
      return null;
    }

    // Get video duration first
    const durationCmd = `ffprobe -v quiet -show_entries format=duration -of csv="p=0" "${videoPath}"`;
    const { stdout: durationOutput } = await execAsync(durationCmd);
    const duration = parseFloat(durationOutput.trim());
    
    if (isNaN(duration) || duration <= 0) {
      throw new Error('Could not determine video duration');
    }
    
    // Generate random timestamp (avoid first and last 5% to skip intro/outro)
    const margin = duration * 0.05;
    const randomTime = margin + Math.random() * (duration - 2 * margin);
    
    // Create temp output path
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const outputPath = path.join(tempDir, `frame_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`);
    
    // Extract frame at random timestamp
    const extractCmd = `ffmpeg -ss ${randomTime} -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;
    await execAsync(extractCmd);
    
    // Verify the frame was created and read it
    if (!fs.existsSync(outputPath)) {
      throw new Error('Failed to extract frame');
    }
    
    const frameBuffer = fs.readFileSync(outputPath);
    
    // Clean up temp file
    fs.unlinkSync(outputPath);
    
    return frameBuffer;
  } catch (error) {
    console.error('Error generating random frame:', error);
    return null;
  }
}