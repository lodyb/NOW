import { Message, AttachmentBuilder } from 'discord.js';
import { findMediaBySearch, getRandomMedia } from '../../database/db';
import { processMedia, parseFilterString, parseClipOptions, ProcessOptions, containsVideoFilters, isVideoFile } from '../../media/processor';
import { safeReply } from '../utils/helpers';
import { logFFmpegCommand } from '../../utils/logger';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import { promisify } from 'util';
import { exec } from 'child_process';

export const handlePlayCommand = async (
  message: Message, 
  searchTerm?: string, 
  filterString?: string, 
  clipOptions?: { duration?: string; start?: string },
  multi?: number
) => {
  try {
    // Handle multi-media playback if multi parameter is provided
    if (multi && multi > 1) {
      await handleMultiMediaPlayback(message, searchTerm, multi, filterString, clipOptions);
      return;
    }

    // Original single media playback code
    let media;
    
    if (!searchTerm) {
      // Get random media when no search term provided
      const randomResults = await getRandomMedia(1);
      if (randomResults.length === 0) {
        await safeReply(message, 'No media found in the database');
        return;
      }
      media = randomResults[0];
    } else {
      // Check if filters require video-only content
      let requireVideo = false;
      
      if (filterString) {
        try {
          const parsedFilters = parseFilterString(filterString);
          requireVideo = containsVideoFilters(parsedFilters);
          
          if (requireVideo) {
            console.log(`Video filters detected, searching for video files only`);
          }
        } catch (err) {
          console.error('Error parsing filters:', err);
        }
      }
      
      const results = await findMediaBySearch(searchTerm, requireVideo);
      
      if (results.length === 0) {
        if (requireVideo) {
          await safeReply(message, `No video files found for "${searchTerm}" with those video filters. Try a different search or filters compatible with audio files.`);
        } else {
          await safeReply(message, `No media found for "${searchTerm}"`);
        }
        return;
      }
      media = results[0];
    }

    // Send initial status message
    const statusMessage = await message.reply(`Processing request${filterString ? ' with filters' : ''}... ⏳`);

    // Determine the file path by standardizing the normalized path format
    let filePath;
    
    if (media.normalizedPath) {
      const filename = path.basename(media.normalizedPath);
      // Ensure normalized path starts with 'norm_'
      const normalizedFilename = filename.startsWith('norm_') ? filename : `norm_${filename}`;
      filePath = path.join(process.cwd(), 'normalized', normalizedFilename);
    } else {
      filePath = media.filePath;
    }
    
    // Apply filters or clip options if provided
    if (filterString || (clipOptions && Object.keys(clipOptions).length > 0)) {
      try {
        // Update status message
        await statusMessage.edit(`Applying filters... ⚙️`);
        
        const randomId = crypto.randomBytes(4).toString('hex');
        const outputFilename = `temp_${randomId}_${path.basename(filePath)}`;
        const options: ProcessOptions = {};
        
        if (filterString) {
          options.filters = parseFilterString(filterString);
        }
        
        if (clipOptions) {
          options.clip = clipOptions;
        }
        
        // Always enforce Discord limit when posting in a text channel
        options.enforceDiscordLimit = true;
        
        // Add progress callback function
        options.progressCallback = async (stage, progress) => {
          try {
            await statusMessage.edit(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
          } catch (err) {
            console.error('Error updating status message:', err);
          }
        };
        
        logFFmpegCommand(`Processing with options ${JSON.stringify(options)} for Discord message`);
        filePath = await processMedia(filePath, outputFilename, options);
        
        // Update status message when processing is complete
        await statusMessage.edit(`Processing complete! Uploading... 📤`);
      } catch (error) {
        console.error('Error processing media:', error);
        await statusMessage.edit(`Error applying filters: ${(error as Error).message} ❌`);
        return;
      }
    }
    
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      await statusMessage.edit('Error: Media file not found ❌');
      return;
    }
    
    // Final update: delete status message since we're about to send the actual file
    await statusMessage.delete().catch(err => console.error('Failed to delete status message:', err));
    
    const attachment = new AttachmentBuilder(filePath);
    await safeReply(message, { files: [attachment] });
  } catch (error) {
    console.error('Error handling play command:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
};

/**
 * Handle multi-media playback with grid layout
 */
export const handleMultiMediaPlayback = async (
  message: Message,
  searchTerm?: string,
  multi: number = 2,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
) => {
  try {
    // Cap the multi value to a reasonable maximum (3x3 grid = 9 videos)
    const maxMulti = 9;
    multi = Math.min(Math.max(2, multi), maxMulti);
    
    // Send initial status message
    const statusMessage = await message.reply(`Processing multi-media request (${multi} items)... ⏳`);
    
    // Determine if we need to find video files (based on the grid layout)
    const requireVideo = true; // Grid layout requires video
    
    // Get media files to use
    let mediaItems;
    if (!searchTerm) {
      // Get random media when no search term provided
      mediaItems = await getRandomMedia(multi, requireVideo);
      if (mediaItems.length === 0) {
        await statusMessage.edit('No video files found in the database');
        return;
      }
    } else {
      mediaItems = await findMediaBySearch(searchTerm, requireVideo, multi);
      if (mediaItems.length === 0) {
        await statusMessage.edit(`No video files found for "${searchTerm}"`);
        return;
      }
    }
    
    // If we didn't get enough items, we use what we have but adjust expectations
    if (mediaItems.length < multi) {
      multi = mediaItems.length;
      await statusMessage.edit(`Found only ${multi} video items... processing... ⏳`);
    }
    
    // Generate temp dir for processing
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    const randomId = crypto.randomBytes(4).toString('hex');
    
    // Process each media file to prepare it for the grid
    await statusMessage.edit(`Processing ${multi} media files for grid layout... ⏳`);
    
    const processedFiles: string[] = [];
    let allFilesAreVideo = true;
    
    // Process each media file sequentially
    for (let i = 0; i < mediaItems.length; i++) {
      const media = mediaItems[i];
      
      // Determine the file path from normalized path
      let filePath;
      if (media.normalizedPath) {
        const filename = path.basename(media.normalizedPath);
        const normalizedFilename = filename.startsWith('norm_') ? filename : `norm_${filename}`;
        filePath = path.join(process.cwd(), 'normalized', normalizedFilename);
      } else {
        filePath = media.filePath;
      }
      
      // Check if this is a video file
      const isVideo = await isVideoFile(filePath);
      if (!isVideo) {
        allFilesAreVideo = false;
      }
      
      // Update status for this media item
      await statusMessage.edit(`Processing media ${i+1}/${multi}... ⏳`);
      
      // Apply filters/clip options if needed
      if (filterString || (clipOptions && Object.keys(clipOptions).length > 0)) {
        try {
          const outputFilename = `temp_grid_${randomId}_${i}_${path.basename(filePath)}`;
          const options: ProcessOptions = {};
          
          if (filterString) {
            options.filters = parseFilterString(filterString);
          }
          
          if (clipOptions) {
            options.clip = clipOptions;
          }
          
          // No need to enforce Discord limit for individual files, only the final output
          options.enforceDiscordLimit = false;
          
          // Add progress callback
          options.progressCallback = async (stage, progress) => {
            try {
              await statusMessage.edit(`Processing media ${i+1}/${multi}: ${stage} (${Math.round(progress * 100)}%)... ⏳`);
            } catch (err) {
              console.error('Error updating status message:', err);
            }
          };
          
          // Process the media file
          const processedPath = await processMedia(filePath, outputFilename, options);
          processedFiles.push(processedPath);
        } catch (error) {
          console.error(`Error processing media item ${i+1}:`, error);
          await statusMessage.edit(`Error processing media item ${i+1}: ${(error as Error).message} ❌`);
          return;
        }
      } else {
        // No processing needed, use the file directly
        processedFiles.push(filePath);
      }
    }
    
    // Check if we can continue
    if (processedFiles.length === 0) {
      await statusMessage.edit('Failed to process any media files ❌');
      return;
    }
    
    if (!allFilesAreVideo) {
      await statusMessage.edit('Cannot create a grid with audio-only files. All files must be videos. ❌');
      return;
    }
    
    // Create a grid layout using ffmpeg
    await statusMessage.edit(`Creating ${multi}-item grid layout... ⏳`);
    
    // Determine grid dimensions based on number of videos
    const gridDimensions = calculateGridDimensions(multi);
    const outputFilename = `grid_${randomId}.mp4`;
    const outputPath = path.join(TEMP_DIR, outputFilename);
    
    try {
      // Special case for 2 videos - use our more reliable side-by-side function
      if (processedFiles.length === 2) {
        await statusMessage.edit(`Creating side-by-side video... ⏳`);
        await createSideBySideVideo(processedFiles, outputPath, async (progress) => {
          await statusMessage.edit(`Creating video (${Math.round(progress * 100)}%)... ⏳`);
        });
      } else {
        // For 3+ videos, use the grid layout
        await statusMessage.edit(`Creating ${multi}-item grid layout... ⏳`);
        await createVideoGrid(processedFiles, outputPath, gridDimensions, async (progress) => {
          await statusMessage.edit(`Creating grid (${Math.round(progress * 100)}%)... ⏳`);
        });
      }
      
      // Ensure the result is under Discord file size limit
      await statusMessage.edit(`Optimizing for Discord... ⏳`);
      
      const finalOutputFilename = `final_grid_${randomId}.mp4`;
      const finalOutputPath = path.join(TEMP_DIR, finalOutputFilename);
      
      // We need to use encodeMediaWithBitrates since we're creating a new video
      const options: ProcessOptions = {
        enforceDiscordLimit: true,
        progressCallback: async (stage, progress) => {
          try {
            await statusMessage.edit(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
          } catch (err) {
            console.error('Error updating status message:', err);
          }
        }
      };
      
      const finalPath = await processMedia(outputPath, finalOutputFilename, options);
      
      if (!fs.existsSync(finalPath)) {
        throw new Error('Failed to create final grid video');
      }
      
      // Upload the final result
      await statusMessage.edit(`Grid created! Uploading... 📤`);
      
      const attachment = new AttachmentBuilder(finalPath);
      await safeReply(message, { files: [attachment] });
      
      // Clean up the status message
      await statusMessage.delete().catch(err => console.error('Failed to delete status message:', err));
      
      // Clean up temporary files
      cleanupTempFiles(processedFiles, outputPath);
    } catch (error) {
      console.error('Error creating video grid:', error);
      await statusMessage.edit(`Error creating video grid: ${(error as Error).message} ❌`);
    }
  } catch (error) {
    console.error('Error handling multi-media playback:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
};

/**
 * Calculate grid dimensions based on number of videos
 */
function calculateGridDimensions(count: number): { rows: number; cols: number } {
  // For 2 videos, use 1x2 grid
  if (count === 2) return { rows: 1, cols: 2 };
  
  // For 3-4 videos, use 2x2 grid
  if (count <= 4) return { rows: 2, cols: 2 };
  
  // For 5-6 videos, use 2x3 grid
  if (count <= 6) return { rows: 2, cols: 3 };
  
  // For 7-9 videos, use 3x3 grid
  return { rows: 3, cols: 3 };
}

/**
 * Create a video grid using ffmpeg complex filter
 */
async function createVideoGrid(
  inputFiles: string[], 
  outputPath: string, 
  grid: { rows: number; cols: number },
  progressCallback?: (progress: number) => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { rows, cols } = grid;
    
    // Check if we have enough files for a grid
    const fileCount = Math.min(inputFiles.length, rows * cols);
    
    // Handle special case - if we only have 1 file, just copy it
    if (fileCount <= 1) {
      const command = ffmpeg(inputFiles[0])
        .outputOptions('-c copy')
        .save(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(err));
      
      return;
    }
    
    // For 2 files, do a simple side-by-side layout
    if (fileCount === 2) {
      const command = ffmpeg();
      
      // Add inputs
      inputFiles.slice(0, 2).forEach(file => {
        command.input(file);
      });
      
      // Simple 2-video layout with proper termination
      const filterComplex = [
        "[0:v]scale=640:360,setsar=1[v0]",
        "[1:v]scale=640:360,setsar=1[v1]",
        "[v0][v1]hstack=inputs=2[vout]"
      ].join(';');
      
      // Handle audio separately to avoid issues
      let audioFilter = "";
      try {
        audioFilter = "[0:a][1:a]amix=inputs=2:duration=longest[aout]";
        command.complexFilter(`${filterComplex};${audioFilter}`, ['vout', 'aout']);
      } catch (err) {
        // If audio mixing fails, try without audio
        console.log('Audio mixing failed, trying without audio mix:', err);
        command.complexFilter(filterComplex, ['vout']);
      }
      
      // Set output options
      command
        .outputOptions('-map [vout]');
      
      // Only map audio if we have an audio filter
      if (audioFilter) {
        command.outputOptions('-map [aout]');
      } else {
        command.outputOptions('-an');
      }
      
      command
        .outputOptions('-c:v libx264')
        .outputOptions('-preset medium')
        .outputOptions('-crf 23');
        
      if (audioFilter) {
        command
          .outputOptions('-c:a aac')
          .outputOptions('-b:a 128k');
      }
      
      command.outputOptions('-shortest');
      
      // Debug the filter
      console.log('Using simplified filter complex for 2 videos:', filterComplex);
      
      // Add error logging
      command.on('stderr', (stderrLine) => {
        console.log('FFmpeg stderr:', stderrLine);
      });
      
      // Add progress tracking
      if (progressCallback) {
        command.on('progress', (progress) => {
          if (progress.percent) {
            progressCallback(progress.percent / 100);
          }
        });
      }
      
      // Execute the command
      command.save(outputPath)
        .on('end', () => {
          resolve(outputPath);
        })
        .on('error', (err) => {
          // If the error is related to audio, try again without audio
          if (audioFilter && err.message && err.message.includes('aout')) {
            console.log('Error with audio mixing, retrying without audio');
            // Call the function again without audio
            createVideoGridNoAudio(inputFiles, outputPath, grid, progressCallback)
              .then(resolve)
              .catch(reject);
          } else {
            console.error('Error creating video grid:', err);
            reject(err);
          }
        });
        
      return;
    }
    
    // For more than 2 files, use the grid approach
    // Prepare input arguments
    const command = ffmpeg();
    
    // Add all input files
    inputFiles.slice(0, fileCount).forEach(file => {
      command.input(file);
    });

    // Calculate grid dimensions that work with the actual number of videos
    let useRows = rows;
    let useCols = cols;
    
    // Ensure grid works with the actual file count
    if (fileCount < rows * cols) {
      // Recalculate for a more balanced grid
      if (fileCount <= 4) {
        useRows = 2;
        useCols = 2;
      } else if (fileCount <= 6) {
        useRows = 2;
        useCols = 3;
      } else {
        useRows = 3;
        useCols = 3;
      }
    }
    
    // Build the filter graph
    let filterComplex = '';
    
    // Scale each video
    for (let i = 0; i < fileCount; i++) {
      filterComplex += `[${i}:v]scale=640:360,setsar=1[v${i}];`;
    }
    
    // Create black padding for empty slots if needed
    const totalSlots = useRows * useCols;
    for (let i = fileCount; i < totalSlots; i++) {
      filterComplex += `color=c=black:s=640x360[v${i}];`;
    }
    
    // Create each row
    for (let r = 0; r < useRows; r++) {
      const rowInputs = [];
      for (let c = 0; c < useCols; c++) {
        const idx = r * useCols + c;
        if (idx < totalSlots) {
          rowInputs.push(`[v${idx}]`);
        }
      }
      
      if (rowInputs.length > 0) {
        filterComplex += `${rowInputs.join('')}hstack=inputs=${rowInputs.length}[row${r}];`;
      }
    }
    
    // Stack all rows
    const rowOutputs = [];
    for (let r = 0; r < useRows; r++) {
      rowOutputs.push(`[row${r}]`);
    }
    
    filterComplex += `${rowOutputs.join('')}vstack=inputs=${useRows}[vout];`;
    
    // Handle audio mixing - only mix the available audio streams
    const audioInputs = [];
    for (let i = 0; i < fileCount; i++) {
      filterComplex += `[${i}:a]aresample=44100:async=1000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
      audioInputs.push(`[a${i}]`);
    }
    
    if (audioInputs.length > 1) {
      filterComplex += `${audioInputs.join('')}amix=inputs=${audioInputs.length}:dropout_transition=0[aout]`;
    } else if (audioInputs.length === 1) {
      filterComplex += `${audioInputs[0]}acopy[aout]`;
    }
    
    // Debug the filter
    console.log('Using filter complex:', filterComplex);
    
    // Apply the filter
    command.complexFilter(filterComplex, audioInputs.length > 0 ? ['vout', 'aout'] : ['vout']);
    
    // Set output options
    command
      .outputOptions('-map [vout]')
      .outputOptions(audioInputs.length > 0 ? '-map [aout]' : '-an')
      .outputOptions('-c:v libx264')
      .outputOptions('-preset medium')
      .outputOptions('-crf 23');
      
    if (audioInputs.length > 0) {
      command
        .outputOptions('-c:a aac')
        .outputOptions('-b:a 128k');
    }
    
    command.outputOptions('-shortest');
    
    // Add error event handler
    command.on('stderr', (stderrLine) => {
      console.log('FFmpeg stderr:', stderrLine);
    });
    
    // Add progress tracking
    if (progressCallback) {
      command.on('progress', (progress) => {
        if (progress.percent) {
          progressCallback(progress.percent / 100);
        }
      });
    }
    
    // Execute the command
    command.save(outputPath)
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('Error creating video grid:', err);
        reject(err);
      });
  });
}

/**
 * Fallback function for creating a video grid without audio
 * Used when audio mixing fails
 */
async function createVideoGridNoAudio(
  inputFiles: string[], 
  outputPath: string, 
  grid: { rows: number; cols: number },
  progressCallback?: (progress: number) => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (inputFiles.length < 2) {
      reject(new Error("Need at least 2 videos for grid"));
      return;
    }
    
    const command = ffmpeg();
    
    // Add only the first 2 inputs to keep it simple
    inputFiles.slice(0, 2).forEach(file => {
      command.input(file);
    });
    
    // Create a simple side-by-side layout without audio
    const filterComplex = [
      "[0:v]scale=640:360,setsar=1[v0]",
      "[1:v]scale=640:360,setsar=1[v1]",
      "[v0][v1]hstack=inputs=2[vout]"
    ].join(';');
    
    // Apply the filter
    command.complexFilter(filterComplex, ['vout']);
    
    // Set output options - no audio
    command
      .outputOptions('-map [vout]')
      .outputOptions('-an')
      .outputOptions('-c:v libx264')
      .outputOptions('-preset medium')
      .outputOptions('-crf 23');
    
    // Add error logging
    command.on('stderr', (stderrLine) => {
      console.log('FFmpeg stderr (noAudio):', stderrLine);
    });
    
    // Add progress tracking
    if (progressCallback) {
      command.on('progress', (progress) => {
        if (progress.percent) {
          progressCallback(progress.percent / 100);
        }
      });
    }
    
    // Execute the command
    command.save(outputPath)
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('Error creating video grid (noAudio):', err);
        reject(err);
      });
  });
}

/**
 * Create a simple side-by-side video (special case for exactly 2 videos)
 */
async function createSideBySideVideo(
  inputFiles: string[],
  outputPath: string,
  progressCallback?: (progress: number) => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (inputFiles.length !== 2) {
      reject(new Error("Side-by-side requires exactly 2 videos"));
      return;
    }
    
    // Use the shell command approach which is more reliable
    const ffmpegBin = 'ffmpeg';
    const command = `${ffmpegBin} -i "${inputFiles[0]}" -i "${inputFiles[1]}" -filter_complex "[0:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[left];[1:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[right];[left][right]hstack=inputs=2[v];[0:a][1:a]amix=inputs=2:duration=longest[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k -shortest "${outputPath}"`;
    
    console.log('Running ffmpeg command:', command);
    
    // Use native exec instead of fluent-ffmpeg
    const childProcess = exec(command);
    
    // Track progress and errors
    let stdoutData = '';
    let stderrData = '';
    
    if (childProcess.stdout) {
      childProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
        console.log('FFmpeg stdout:', data.toString());
      });
    }
    
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.log('FFmpeg stderr:', data.toString());
        
        // Try to parse progress
        const match = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match && match[1] && progressCallback) {
          const timeStr = match[1];
          const [hours, minutes, seconds] = timeStr.split(':').map(parseFloat);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          
          // Estimate total duration as 2 minutes for progress calculation
          const estimatedDuration = 120; 
          const progress = Math.min(totalSeconds / estimatedDuration, 0.99);
          
          progressCallback(progress).catch(err => {
            console.error('Error updating progress:', err);
          });
        }
      });
    }
    
    // Handle completion
    childProcess.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        console.error(`FFmpeg exited with code ${code}`);
        console.error('stderr:', stderrData);
        
        // Try without audio if it failed
        createSideBySideVideoNoAudio(inputFiles, outputPath, progressCallback)
          .then(resolve)
          .catch(reject);
      }
    });
  });
}

/**
 * Create a side-by-side video with no audio (fallback)
 */
async function createSideBySideVideoNoAudio(
  inputFiles: string[],
  outputPath: string,
  progressCallback?: (progress: number) => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (inputFiles.length !== 2) {
      reject(new Error("Side-by-side requires exactly 2 videos"));
      return;
    }
    
    // Direct command without audio mixing
    const ffmpegBin = 'ffmpeg';
    const command = `${ffmpegBin} -i "${inputFiles[0]}" -i "${inputFiles[1]}" -filter_complex "[0:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[left];[1:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[right];[left][right]hstack=inputs=2[v]" -map "[v]" -an -c:v libx264 -preset medium -crf 23 -shortest "${outputPath}"`;
    
    console.log('Running ffmpeg command (no audio):', command);
    
    // Use native exec instead of fluent-ffmpeg
    const childProcess = exec(command);
    
    // Track progress and errors
    let stdoutData = '';
    let stderrData = '';
    
    if (childProcess.stdout) {
      childProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
        console.log('FFmpeg stdout (noAudio):', data.toString());
      });
    }
    
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.log('FFmpeg stderr (noAudio):', data.toString());
        
        // Try to parse progress
        const match = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match && match[1] && progressCallback) {
          const timeStr = match[1];
          const [hours, minutes, seconds] = timeStr.split(':').map(parseFloat);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          
          // Estimate total duration as 2 minutes for progress calculation
          const estimatedDuration = 120; 
          const progress = Math.min(totalSeconds / estimatedDuration, 0.99);
          
          progressCallback(progress).catch(err => {
            console.error('Error updating progress:', err);
          });
        }
      });
    }
    
    // Handle completion
    childProcess.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        console.error(`FFmpeg exited with code ${code} (noAudio)`);
        console.error('stderr:', stderrData);
        reject(new Error(`FFmpeg failed with code ${code}: ${stderrData}`));
      }
    });
  });
}

/**
 * Clean up temporary files after processing
 */
function cleanupTempFiles(processedFiles: string[], gridFile: string): void {
  // Only delete temp files, not original files
  const TEMP_DIR = path.join(process.cwd(), 'temp');
  const filesToDelete = processedFiles.filter(file => file.includes(TEMP_DIR));
  
  filesToDelete.forEach(file => {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (error) {
      console.error(`Error deleting temporary file ${file}:`, error);
    }
  });
  
  // Also delete the grid file if it exists
  try {
    if (fs.existsSync(gridFile)) {
      fs.unlinkSync(gridFile);
    }
  } catch (error) {
    console.error(`Error deleting grid file ${gridFile}:`, error);
  }
}