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
    // Special case for concat command
    if (searchTerm === 'concat') {
      await handleConcatPlayback(message, filterString, clipOptions);
      return;
    }
    
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
    // Add fps=25 to standardize frame rate and avoid frame duplication
    const command = `${ffmpegBin} -i "${inputFiles[0]}" -i "${inputFiles[1]}" -filter_complex "[0:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[left];[1:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[right];[left][right]hstack=inputs=2[v];[0:a][1:a]amix=inputs=2:duration=longest[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 23 -vsync vfr -c:a aac -b:a 128k -shortest "${outputPath}"`;
    
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
    const command = `${ffmpegBin} -i "${inputFiles[0]}" -i "${inputFiles[1]}" -filter_complex "[0:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[right];[1:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[right];[left][right]hstack=inputs=2[v]" -map "[v]" -an -c:v libx264 -preset medium -crf 23 -shortest "${outputPath}"`;
    
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

/**
 * Handle concatenation of random media clips
 * Creates a montage of short random segments from different media files
 */
export const handleConcatPlayback = async (
  message: Message,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
) => {
  try {
    // Send initial status message
    const statusMessage = await message.reply(`Processing concat request... ⏳`);
    
    // Determine number of clips to concat (default 3-5)
    let clipCount = 4;
    if (filterString) {
      const countMatch = filterString.match(/count=(\d+)/);
      if (countMatch && countMatch[1]) {
        clipCount = Math.min(Math.max(2, parseInt(countMatch[1], 10)), 10); // Between 2 and 10 clips
      }
    }
    
    // Default clip duration if not specified (3-8 seconds)
    const defaultClipDuration = clipOptions?.duration || '5';
    
    await statusMessage.edit(`Finding ${clipCount} random media clips... ⏳`);
    
    // Get random media files, preferring videos
    const mediaItems = await getRandomMedia(clipCount * 2, true); // Get more than needed in case some fail
    
    if (mediaItems.length === 0) {
      await statusMessage.edit('No suitable media found in the database');
      return;
    }
    
    // Prepare temp directory
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    const randomId = crypto.randomBytes(4).toString('hex');
    
    // Process each clip
    const processedClips: {
      filePath: string;
      duration: number;
      start?: string;
      isVideo: boolean;
    }[] = [];
    
    for (let i = 0; i < Math.min(clipCount, mediaItems.length); i++) {
      const media = mediaItems[i];
      
      // Generate clip parameters
      const clipDuration = clipOptions?.duration || `${Math.floor(Math.random() * 6) + 3}`; // 3-8 seconds if not specified
      let clipStart: string | undefined = clipOptions?.start;
      
      // If start not specified, pick a random position
      if (!clipStart) {
        // Get file duration to determine valid start position
        const filePath = media.normalizedPath 
          ? path.join(process.cwd(), 'normalized', path.basename(media.normalizedPath))
          : media.filePath;
        
        try {
          const { duration } = await getMediaInfo(filePath);
          if (duration) {
            // Pick a random start point, but not too close to the end
            const maxStart = Math.max(0, duration - parseInt(clipDuration, 10));
            if (maxStart > 0) {
              const randomStart = Math.floor(Math.random() * maxStart);
              clipStart = `${randomStart}`;
            }
          }
        } catch (err) {
          console.error(`Error getting media duration for ${filePath}:`, err);
          // Continue without a specified start time
        }
      }
      
      await statusMessage.edit(`Processing clip ${i+1}/${clipCount}... ⏳`);
      
      try {
        // Process the clip
        const clipFilename = `temp_concat_${randomId}_${i}_${path.basename(media.normalizedPath || media.filePath)}`;
        const clipOptions: { start?: string; duration?: string } = {
          duration: clipDuration
        };
        if (clipStart) {
          clipOptions.start = clipStart;
        }
        
        const filePath = media.normalizedPath 
          ? path.join(process.cwd(), 'normalized', path.basename(media.normalizedPath))
          : media.filePath;
        
        // Process with optional filters
        const options: ProcessOptions = {
          clip: clipOptions,
          enforceDiscordLimit: false, // We'll enforce limits on the final output
        };
        
        // Add filters if provided (except count which we handled already)
        if (filterString) {
          const parsedFilters = parseFilterString(filterString.replace(/count=\d+,?/g, ''));
          if (Object.keys(parsedFilters).length > 0) {
            options.filters = parsedFilters;
          }
        }
        
        const processedPath = await processMedia(filePath, clipFilename, options);
        const isVideo = await isVideoFile(processedPath);
        
        // Get actual duration to ensure accurate concatenation
        const { duration } = await getMediaInfo(processedPath);
        
        // Only use if processing succeeded
        if (fs.existsSync(processedPath)) {
          processedClips.push({
            filePath: processedPath,
            duration: duration || parseInt(clipDuration, 10),
            start: clipStart,
            isVideo
          });
        }
      } catch (error) {
        console.error(`Error processing clip ${i+1}:`, error);
        // Continue with other clips
      }
    }
    
    if (processedClips.length === 0) {
      await statusMessage.edit('Failed to process any clips ❌');
      return;
    }
    
    // Concatenate the clips
    await statusMessage.edit(`Concatenating ${processedClips.length} clips... ⏳`);
    
    // Check if we have video clips
    const hasVideoClips = processedClips.some(clip => clip.isVideo);
    const outputFilename = `concat_${randomId}.${hasVideoClips ? 'mp4' : 'ogg'}`;
    const outputPath = path.join(TEMP_DIR, outputFilename);
    
    try {
      // Use direct ffmpeg for more reliable concat
      const concatPath = await createConcatenatedMedia(
        processedClips.map(clip => clip.filePath),
        outputPath,
        hasVideoClips,
        async (progress) => {
          await statusMessage.edit(`Concatenating (${Math.round(progress * 100)}%)... ⏳`);
        }
      );
      
      // Ensure the result is under Discord file size limit
      await statusMessage.edit(`Optimizing for Discord... ⏳`);
      
      const finalOutputFilename = `final_concat_${randomId}.${hasVideoClips ? 'mp4' : 'ogg'}`;
      const finalOutputPath = path.join(TEMP_DIR, finalOutputFilename);
      
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
      
      const finalPath = await processMedia(concatPath, finalOutputFilename, options);
      
      if (!fs.existsSync(finalPath)) {
        throw new Error('Failed to create final concatenated media');
      }
      
      // Upload the final result
      await statusMessage.edit(`Concatenation complete! Uploading... 📤`);
      
      const attachment = new AttachmentBuilder(finalPath);
      await safeReply(message, { files: [attachment] });
      
      // Clean up the status message
      await statusMessage.delete().catch(err => console.error('Failed to delete status message:', err));
      
      // Clean up temporary files
      cleanupTempFiles(
        [...processedClips.map(clip => clip.filePath), concatPath],
        finalPath
      );
    } catch (error) {
      console.error('Error concatenating clips:', error);
      await statusMessage.edit(`Error concatenating clips: ${(error as Error).message} ❌`);
    }
  } catch (error) {
    console.error('Error handling concat playback:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
};

/**
 * Get media information (duration, dimensions) using ffmpeg
 */
async function getMediaInfo(filePath: string): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      
      // Extract duration and dimensions
      const info: { duration?: number; width?: number; height?: number } = {};
      
      if (metadata.format && metadata.format.duration) {
        info.duration = metadata.format.duration;
      }
      
      // Find video stream if exists
      const videoStream = metadata.streams?.find(stream => stream.codec_type === 'video');
      if (videoStream) {
        info.width = videoStream.width;
        info.height = videoStream.height;
      }
      
      resolve(info);
    });
  });
}

/**
 * Create concatenated media from multiple input files using FFmpeg
 */
async function createConcatenatedMedia(
  inputFiles: string[],
  outputPath: string,
  hasVideo: boolean,
  progressCallback?: (progress: number) => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (inputFiles.length === 0) {
      reject(new Error("No input files provided for concatenation"));
      return;
    }
    
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    const randomId = crypto.randomBytes(4).toString('hex');
    
    // For video files, use filter_complex approach
    // For audio-only files, use concat demuxer approach (more reliable for audio)
    if (hasVideo) {
      // Create a complex filter for video+audio concatenation
      // Generate input args
      const inputArgs = inputFiles.map(file => `-i "${file}"`).join(' ');
      
      // Create video and audio stream maps
      const streams: string[] = [];
      let filterComplex = '';
      
      // Create scaled video streams
      for (let i = 0; i < inputFiles.length; i++) {
        filterComplex += `[${i}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
      }
      
      // Concat video streams
      const videoInputs = Array.from({ length: inputFiles.length }, (_, i) => `[v${i}]`).join('');
      filterComplex += `${videoInputs}concat=n=${inputFiles.length}:v=1:a=0[vout];`;
      
      // Concat audio streams with fallback for missing audio
      // First create normalized audio streams
      for (let i = 0; i < inputFiles.length; i++) {
        filterComplex += `[${i}:a]aresample=44100:async=1000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
      }
      
      // Then concat them
      const audioInputs = Array.from({ length: inputFiles.length }, (_, i) => `[a${i}]`).join('');
      filterComplex += `${audioInputs}concat=n=${inputFiles.length}:v=0:a=1[aout]`;
      
      // Build the full command
      const command = `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k "${outputPath}"`;
      
      console.log('Running ffmpeg concat command (video):', command);
      
      // Execute the command
      const childProcess = exec(command);
      let stderrData = '';
      
      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data) => {
          stderrData += data.toString();
          console.log('FFmpeg stderr (concat):', data.toString());
          
          // Parse progress
          const match = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/);
          if (match && match[1] && progressCallback) {
            const timeStr = match[1];
            const [hours, minutes, seconds] = timeStr.split(':').map(parseFloat);
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;
            
            // Estimate total duration based on 10 seconds per clip
            const estimatedDuration = inputFiles.length * 10;
            const progress = Math.min(totalSeconds / estimatedDuration, 0.99);
            
            progressCallback(progress).catch(err => {
              console.error('Error updating progress:', err);
            });
          }
        });
      }
      
      childProcess.on('close', (code) => {
        if (code === 0) {
          resolve(outputPath);
        } else {
          console.error(`FFmpeg concat process exited with code ${code}`);
          console.error('stderr:', stderrData);
          
          // Try using the fallback method with concat demuxer
          createConcatDemuxer(inputFiles, outputPath, progressCallback)
            .then(resolve)
            .catch(reject);
        }
      });
    } else {
      // For audio-only, use the concat demuxer which is more reliable
      createConcatDemuxer(inputFiles, outputPath, progressCallback)
        .then(resolve)
        .catch(reject);
    }
  });
}

/**
 * Create concatenated media using FFmpeg's concat demuxer
 * This is a fallback method that works better for audio-only content
 */
async function createConcatDemuxer(
  inputFiles: string[],
  outputPath: string,
  progressCallback?: (progress: number) => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (inputFiles.length === 0) {
      reject(new Error("No input files provided for concatenation"));
      return;
    }
    
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    const randomId = crypto.randomBytes(4).toString('hex');
    const concatListPath = path.join(TEMP_DIR, `concat_${randomId}.txt`);
    
    // Create a concat list file
    const concatContent = inputFiles
      .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
      .join('\n');
    
    try {
      fs.writeFileSync(concatListPath, concatContent);
      
      // Determine if we're concatenating video or audio
      const isVideo = outputPath.endsWith('.mp4');
      const outputOptions = isVideo 
        ? '-c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k'
        : '-c:a libopus -b:a 128k';
      
      // Build the command
      const command = `ffmpeg -f concat -safe 0 -i "${concatListPath}" ${outputOptions} "${outputPath}"`;
      
      console.log('Running ffmpeg concat demuxer command:', command);
      
      // Execute the command
      const childProcess = exec(command);
      let stderrData = '';
      
      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data) => {
          stderrData += data.toString();
          console.log('FFmpeg stderr (concat demuxer):', data.toString());
          
          // Parse progress
          const match = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/);
          if (match && match[1] && progressCallback) {
            const timeStr = match[1];
            const [hours, minutes, seconds] = timeStr.split(':').map(parseFloat);
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;
            
            // Estimate total duration based on 10 seconds per clip
            const estimatedDuration = inputFiles.length * 10;
            const progress = Math.min(totalSeconds / estimatedDuration, 0.99);
            
            progressCallback(progress).catch(err => {
              console.error('Error updating progress:', err);
            });
          }
        });
      }
      
      childProcess.on('close', (code) => {
        // Always clean up the temp concat list file
        try {
          if (fs.existsSync(concatListPath)) {
            fs.unlinkSync(concatListPath);
          }
        } catch (e) {
          console.error('Error cleaning up concat list file:', e);
        }
        
        if (code === 0) {
          resolve(outputPath);
        } else {
          console.error(`FFmpeg concat demuxer process exited with code ${code}`);
          console.error('stderr:', stderrData);
          reject(new Error(`FFmpeg concat failed with code ${code}`));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}