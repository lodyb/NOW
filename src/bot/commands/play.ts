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
import { exec, execSync } from 'child_process';

export const handlePlayCommand = async (
  message: Message, 
  searchTerm?: string, 
  filterString?: string, 
  clipOptions?: { duration?: string; start?: string },
  multi?: number
) => {
  try {
    // Special case for stereo split command - when using 'stereo' keyword explicitly
    if (filterString && filterString.startsWith('{') && filterString.endsWith('}') && 
        (filterString.toLowerCase().includes('stereo') || filterString.toLowerCase() === '{split}')) {
      // Trigger stereo split with random media
      await handleStereoSplitPlayback(message, searchTerm, undefined, clipOptions);
      return;
    }
    
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
    
    // Parse advanced options from filterString
    let mediaDelay = 0; // Default: no delay between videos (in ms)
    let mediaSpeed = 1.0; // Default: all videos play at normal speed
    let msyncEnabled = false; // Default: don't sync media durations
    let msyncDuration: number | null = null; // Optional fixed duration in seconds for all media
    
    if (filterString) {
      // Extract mdelay option
      const delayMatch = filterString.match(/mdelay=(\d+)/);
      if (delayMatch && delayMatch[1]) {
        mediaDelay = Math.min(5000, Math.max(0, parseInt(delayMatch[1], 10))); // Limit to 0-5000ms
        // Remove the processed option
        filterString = filterString.replace(/mdelay=\d+,?/g, '');
        if (filterString.endsWith(',')) {
          filterString = filterString.slice(0, -1);
        }
      }
      
      // Extract mspeed option
      const speedMatch = filterString.match(/mspeed=(\d+(\.\d+)?)/);
      if (speedMatch && speedMatch[1]) {
        mediaSpeed = Math.min(2.0, Math.max(0.5, parseFloat(speedMatch[1]))); // Limit to 0.5-2.0
        // Remove the processed option
        filterString = filterString.replace(/mspeed=\d+(\.\d+)?,?/g, '');
        if (filterString.endsWith(',')) {
          filterString = filterString.slice(0, -1);
        }
      }
      
      // Extract msync option
      const msyncMatch = filterString.match(/msync(=(\d+))?/);
      if (msyncMatch) {
        msyncEnabled = true;
        // If a specific duration is provided, use it
        if (msyncMatch[2]) {
          msyncDuration = Math.min(300, Math.max(1, parseInt(msyncMatch[2], 10))); // Limit to 1-300 seconds
        }
        // Remove the processed option
        filterString = filterString.replace(/msync(=\d+)?,?/g, '');
        if (filterString.endsWith(',')) {
          filterString = filterString.slice(0, -1);
        }
      }
      
      // Remove the multi parameter from the filter string to avoid passing it to FFmpeg
      if (filterString) {
        filterString = filterString.replace(/multi=\d+,?/g, '');
        if (filterString.endsWith(',')) {
          filterString = filterString.slice(0, -1);
        }
        // If we emptied the filter string, set it to undefined or keep the braces format
        if (filterString === '{' || filterString === '{}') {
          filterString = undefined;
        }
      }
    }
    
    // Send initial status message with advanced options if specified
    let statusText = `Processing multi-media request (${multi} items)`;
    if (mediaDelay > 0) statusText += `, delay=${mediaDelay}ms`;
    if (mediaSpeed !== 1.0) statusText += `, speed progression=${mediaSpeed.toFixed(2)}x`;
    if (msyncEnabled) statusText += msyncDuration ? `, synced to ${msyncDuration}s` : `, synced to longest`;
    
    const statusMessage = await message.reply(`${statusText}... ⏳`);
    
    // Get media files to use
    let mediaItems;
    if (!searchTerm) {
      // Get random media when no search term provided
      mediaItems = await getRandomMedia(multi);
    } else {
      // Try to find matches for the search term
      mediaItems = await findMediaBySearch(searchTerm, false, multi);
    }
    
    if (mediaItems.length === 0) {
      await statusMessage.edit(`No media files found ${searchTerm ? `for "${searchTerm}"` : 'in the database'}`);
      return;
    }
    
    // If we didn't get enough items, duplicate existing items to fill the grid
    if (mediaItems.length < multi) {
      // Create duplicates of existing items
      const originalCount = mediaItems.length;
      while (mediaItems.length < multi) {
        // Cycle through the original items
        const itemToDuplicate = mediaItems[mediaItems.length % originalCount];
        mediaItems.push(itemToDuplicate);
      }
      
      await statusMessage.edit(`Found ${originalCount} media item(s), duplicating to fill ${multi} slots... ⏳`);
    }
    
    // Generate temp dir for processing
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    const randomId = crypto.randomBytes(4).toString('hex');
    
    // Process each media file to prepare it for the grid
    await statusMessage.edit(`Processing ${multi} media files for grid layout... ⏳`);
    
    const processedFiles: string[] = [];
    const fileTypes: { isVideo: boolean }[] = [];
    
    // If msync is enabled, we need to get duration information first
    let mediaDurations: number[] = [];
    let targetDuration = 0;
    
    if (msyncEnabled) {
      await statusMessage.edit(`Getting media durations for sync... ⏳`);
      
      // First, get all the normalized file paths
      const normalizedPaths = mediaItems.map(media => {
        if (media.normalizedPath) {
          const filename = path.basename(media.normalizedPath);
          const normalizedFilename = filename.startsWith('norm_') ? filename : `norm_${filename}`;
          return path.join(process.cwd(), 'normalized', normalizedFilename);
        }
        return media.filePath;
      });
      
      // Get duration for each file
      for (let i = 0; i < normalizedPaths.length; i++) {
        try {
          const { duration } = await getMediaInfo(normalizedPaths[i]);
          if (duration) {
            mediaDurations.push(duration);
          } else {
            // If we can't get duration, use a default value
            mediaDurations.push(30); // Default to 30 seconds
          }
        } catch (err) {
          console.error(`Error getting duration for ${normalizedPaths[i]}:`, err);
          mediaDurations.push(30); // Default to 30 seconds on error
        }
      }
      
      // Determine target duration - either specified by user or the longest media
      if (msyncDuration !== null) {
        targetDuration = msyncDuration;
      } else {
        // Use the longest duration from all media files
        targetDuration = Math.max(...mediaDurations, 1);
      }
      
      await statusMessage.edit(`Syncing ${multi} media files to ${targetDuration.toFixed(1)}s duration... ⏳`);
    }
    
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
      fileTypes.push({ isVideo });
      
      // Update status for this media item
      await statusMessage.edit(`Processing media ${i+1}/${multi}... ⏳`);
      
      // For audio files, we need to create a video with a placeholder image
      if (!isVideo) {
        try {
          const audioToVideoFilename = `temp_audio_video_${randomId}_${i}.mp4`;
          const audioToVideoPath = path.join(TEMP_DIR, audioToVideoFilename);
          
          // Create a blank video with audio
          await createAudioPlaceholderVideo(filePath, audioToVideoPath, async (progress) => {
            await statusMessage.edit(`Converting audio to video ${i+1}/${multi} (${Math.round(progress * 100)}%)... ⏳`);
          });
          
          filePath = audioToVideoPath;
        } catch (error) {
          console.error(`Error converting audio to video for item ${i+1}:`, error);
          // Continue with original file as fallback
        }
      }
      
      // Apply filters/clip options if needed
      if (filterString || (clipOptions && Object.keys(clipOptions).length > 0) || msyncEnabled) {
        try {
          const outputFilename = `temp_grid_${randomId}_${i}_${path.basename(filePath)}`;
          const options: ProcessOptions = {};
          
          // Apply base filters first
          if (filterString) {
            options.filters = parseFilterString(filterString);
          } else {
            options.filters = {}; // Ensure we have a filters object to work with
          }
          
          // Apply clip options
          if (clipOptions) {
            options.clip = clipOptions;
          }
          
          // If msync is enabled, calculate and apply speed adjustment for this file
          if (msyncEnabled && targetDuration > 0 && mediaDurations[i] > 0) {
            // Calculate speed factor: if file is shorter than target, slow it down; if longer, speed it up
            let speedFactor = mediaDurations[i] / targetDuration;
            
            // Limit speed factor to reasonable ranges to avoid FFmpeg errors
            // Too slow causes artifacts and too fast makes content unrecognizable
            const MIN_SPEED = 0.5; // Safer minimum speed - don't go slower than 1/2 speed
            const MAX_SPEED = 2.0; // Safer maximum speed - don't go faster than 2x speed
            
            if (speedFactor < MIN_SPEED) {
              console.log(`Warning: Speed factor ${speedFactor.toFixed(2)} too low, limiting to ${MIN_SPEED}`);
              speedFactor = MIN_SPEED;
            } else if (speedFactor > MAX_SPEED) {
              console.log(`Warning: Speed factor ${speedFactor.toFixed(2)} too high, limiting to ${MAX_SPEED}`);
              speedFactor = MAX_SPEED;
            }
            
            if (speedFactor !== 1.0) {
              // Apply video speed adjustment
              if (isVideo) {
                // setpts filter: 1/speed for speedFactor
                options.filters.setpts = `${1.0/speedFactor}*PTS`;
              }
              
              // Apply audio speed adjustment using atempo
              // atempo is limited to 0.5-2.0 range in ffmpeg
              options.filters.atempo = speedFactor.toString();
              
              // Log the sync adjustment
              console.log(`Media sync: File ${i+1} duration=${mediaDurations[i].toFixed(2)}s, target=${targetDuration.toFixed(2)}s, speed=${speedFactor.toFixed(2)}`);
            }
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
        }, { mediaDelay, mediaSpeed });
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
 * Create a video grid using ffmpeg complex filter with optimized mapping
 */
async function createVideoGrid(
  inputFiles: string[], 
  outputPath: string, 
  grid: { rows: number; cols: number },
  progressCallback?: (progress: number) => Promise<void>,
  options?: { mediaDelay?: number; mediaSpeed?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { rows, cols } = grid;
    const mediaDelay = options?.mediaDelay || 0;
    const mediaSpeed = options?.mediaSpeed || 1.0;
    
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
    
    // For 2 files, use specialized function with options
    if (fileCount === 2) {
      createSideBySideVideo(inputFiles, outputPath, progressCallback, options)
        .then(resolve)
        .catch(reject);
      return;
    }
    
    // Calculate actual grid dimensions based on file count
    let useRows = rows;
    let useCols = cols;
    
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
    
    // Build command using direct ffmpeg command with mapping
    const ffmpegBin = 'ffmpeg';
    let inputArgs = '';
    let filterComplex = '';
    let mapArgs = '';
    
    // Add input files
    for (let i = 0; i < fileCount; i++) {
      inputArgs += ` -i "${inputFiles[i]}"`;
    }
    
    // Create processing blocks for each video
    for (let i = 0; i < fileCount; i++) {
      // Calculate progressive speed for this video
      const speedFactor = mediaSpeed !== 1.0 ? Math.pow(mediaSpeed, i) : 1.0;
      
      // Calculate delay for this video in milliseconds
      const delayMs = i * mediaDelay;
      const delayFilter = delayMs > 0 ? `,tpad=start_duration=${delayMs/1000}` : '';
      
      // Apply speed adjustment if needed
      const speedFilter = speedFactor !== 1.0 ? `,setpts=PTS/${speedFactor}` : '';
      
      // Filter for video
      filterComplex += `[${i}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25${speedFilter}${delayFilter}[v${i}];`;
    }
    
    // Add black frames for empty spots if needed
    for (let i = fileCount; i < useRows * useCols; i++) {
      filterComplex += `color=c=black:s=640x360:r=25[v${i}];`;
    }
    
    // Create grid layout
    // Create the rows using hstack
    for (let r = 0; r < useRows; r++) {
      const rowInputs = [];
      for (let c = 0; c < useCols; c++) {
        const index = r * useCols + c;
        if (index < useRows * useCols) {
          rowInputs.push(`[v${index}]`);
        }
      }
      
      if (rowInputs.length > 0) {
        filterComplex += `${rowInputs.join('')}hstack=inputs=${rowInputs.length}[row${r}];`;
      }
    }
    
    // Stack the rows vertically
    const rowRefs = [];
    for (let r = 0; r < useRows; r++) {
      rowRefs.push(`[row${r}]`);
    }
    
    if (rowRefs.length > 1) {
      filterComplex += `${rowRefs.join('')}vstack=inputs=${rowRefs.length}[vout];`;
    } else {
      filterComplex += `${rowRefs[0]}copy[vout];`;
    }
    
    // Handle audio streams with mapping
    for (let i = 0; i < fileCount; i++) {
      // Calculate progressive speed for this audio
      const speedFactor = mediaSpeed !== 1.0 ? Math.pow(mediaSpeed, i) : 1.0;
      
      // Calculate delay for this audio in milliseconds
      const delayMs = i * mediaDelay;
      const delayFilter = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : '';
      
      // Apply appropriate audio speed filter
      let audioSpeedFilter = '';
      if (speedFactor !== 1.0) {
        if (speedFactor >= 0.5 && speedFactor <= 2.0) {
          audioSpeedFilter = `,atempo=${speedFactor}`;
        } else if (speedFactor < 0.5) {
          const filterValues = [];
          let remainingSpeed = speedFactor;
          
          while (remainingSpeed < 0.5) {
            filterValues.push('atempo=0.5');
            remainingSpeed /= 0.5;
          }
          
          if (remainingSpeed < 1.0) {
            filterValues.push(`atempo=${remainingSpeed}`);
          }
          
          audioSpeedFilter = `,${filterValues.join(',')}`;
        } else {
          const filterValues = [];
          let remainingSpeed = speedFactor;
          
          while (remainingSpeed > 2.0) {
            filterValues.push('atempo=2.0');
            remainingSpeed /= 2.0;
          }
          
          if (remainingSpeed > 1.0) {
            filterValues.push(`atempo=${remainingSpeed}`);
          }
          
          audioSpeedFilter = `,${filterValues.join(',')}`;
        }
      }
      
      // Add audio processing
      filterComplex += `[${i}:a]aresample=44100:async=1000,aformat=sample_fmts=fltp:channel_layouts=stereo${audioSpeedFilter}${delayFilter}[a${i}];`;
    }
    
    // Mix all audio streams
    if (fileCount > 0) {
      const audioInputs = Array.from({ length: fileCount }, (_, i) => `[a${i}]`).join('');
      if (fileCount > 1) {
        filterComplex += `${audioInputs}amix=inputs=${fileCount}:dropout_transition=0[aout]`;
      } else {
        filterComplex += `${audioInputs}acopy[aout]`;
      }
    }
    
    // Build the full command with mapping
    const command = `${ffmpegBin}${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset medium -crf 23 -vsync vfr -c:a aac -b:a 128k -shortest "${outputPath}"`;
    
    console.log('Running optimized grid command:', command);
    
    const childProcess = exec(command);
    let stderrData = '';
    
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.log('FFmpeg stderr (grid):', data.toString());
        
        // Parse progress
        const match = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match && match[1] && progressCallback) {
          const timeStr = match[1];
          const [hours, minutes, seconds] = timeStr.split(':').map(parseFloat);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          
          // Estimate progress based on a 2-minute video
          const estimatedDuration = 120;
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
        console.error(`FFmpeg grid process exited with code ${code}`);
        console.error('stderr:', stderrData);
        
        // Try with simpler approach if failed
        createVideoGridNoAudio(inputFiles, outputPath, grid, progressCallback)
          .then(resolve)
          .catch(reject);
      }
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
  progressCallback?: (progress: number) => Promise<void>,
  options?: { mediaDelay?: number; mediaSpeed?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (inputFiles.length !== 2) {
      reject(new Error("Side-by-side requires exactly 2 videos"));
      return;
    }
    
    const mediaDelay = options?.mediaDelay || 0;
    const mediaSpeed = options?.mediaSpeed || 1.0;
    
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
      
      // Create scaled video streams with fps standardization to prevent frame duplication
      for (let i = 0; i < inputFiles.length; i++) {
        filterComplex += `[${i}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[v${i}];`;
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
      
      // Build the full command with vsync=vfr to prevent frame duplication
      const command = `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset medium -crf 23 -vsync vfr -c:a aac -b:a 128k "${outputPath}"`;
      
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

/**
 * Handle stereo split playback (left/right channels for different media)
 */
export const handleStereoSplitPlayback = async (
  message: Message,
  searchTerm?: string,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
) => {
  try {
    // Send initial status message
    const statusMessage = await message.reply(`Processing stereo split request... ⏳`);
    
    // We need exactly 2 media items
    const requireVideo = false; // Allow any media type
    const mediaCount = 2;
    
    // Get media files to use
    let mediaItems;
    if (!searchTerm) {
      // Get random media when no search term provided
      mediaItems = await getRandomMedia(mediaCount);
    } else {
      mediaItems = await findMediaBySearch(searchTerm, requireVideo, mediaCount);
    }
    
    if (mediaItems.length < 2) {
      await statusMessage.edit(`Not enough media found for "${searchTerm || 'random'}" (need 2)`);
      return;
    }
    
    // Generate temp dir for processing
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    const randomId = crypto.randomBytes(4).toString('hex');
    
    // Process each media file
    await statusMessage.edit(`Processing 2 media files for stereo split... ⏳`);
    
    const processedFiles: string[] = [];
    
    // Process each media file sequentially
    for (let i = 0; i < 2; i++) {
      const media = mediaItems[i];
      
      // Determine the file path
      let filePath;
      if (media.normalizedPath) {
        const filename = path.basename(media.normalizedPath);
        const normalizedFilename = filename.startsWith('norm_') ? filename : `norm_${filename}`;
        filePath = path.join(process.cwd(), 'normalized', normalizedFilename);
      } else {
        filePath = media.filePath;
      }
      
      // Update status for this media item
      await statusMessage.edit(`Processing media ${i+1}/2... ⏳`);
      
      // Apply filters/clip options if needed
      if (filterString || (clipOptions && Object.keys(clipOptions).length > 0)) {
        try {
          const outputFilename = `temp_stereo_${randomId}_${i}_${path.basename(filePath)}`;
          const options: ProcessOptions = {};
          
          if (filterString) {
            options.filters = parseFilterString(filterString);
          }
          
          if (clipOptions) {
            options.clip = clipOptions;
          }
          
          options.enforceDiscordLimit = false;
          
          // Add progress callback
          options.progressCallback = async (stage, progress) => {
            try {
              await statusMessage.edit(`Processing media ${i+1}/2: ${stage} (${Math.round(progress * 100)}%)... ⏳`);
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
    
    if (processedFiles.length !== 2) {
      await statusMessage.edit('Failed to process both media files ❌');
      return;
    }
    
    // Create the stereo split output using ffmpeg
    await statusMessage.edit(`Creating stereo split video... ⏳`);
    
    const outputFilename = `stereo_${randomId}.mp4`;
    const outputPath = path.join(TEMP_DIR, outputFilename);
    
    try {
      // Create stereo split (left/right) audio with side-by-side video
      await createStereoSplitVideo(processedFiles, outputPath, async (progress) => {
        await statusMessage.edit(`Creating video (${Math.round(progress * 100)}%)... ⏳`);
      });
      
      // Ensure the result is under Discord file size limit
      await statusMessage.edit(`Optimizing for Discord... ⏳`);
      
      const finalOutputFilename = `final_stereo_${randomId}.mp4`;
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
      
      const finalPath = await processMedia(outputPath, finalOutputFilename, options);
      
      if (!fs.existsSync(finalPath)) {
        throw new Error('Failed to create final stereo split video');
      }
      
      // Upload the final result
      await statusMessage.edit(`Stereo split created! Uploading... 📤`);
      
      const attachment = new AttachmentBuilder(finalPath);
      await safeReply(message, { files: [attachment] });
      
      // Clean up the status message
      await statusMessage.delete().catch(err => console.error('Failed to delete status message:', err));
      
      // Clean up temporary files
      cleanupTempFiles(processedFiles, outputPath);
    } catch (error) {
      console.error('Error creating stereo split video:', error);
      await statusMessage.edit(`Error creating stereo split: ${(error as Error).message} ❌`);
    }
  } catch (error) {
    console.error('Error handling stereo split playback:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
};

/**
 * Create a stereo split video with left media in left channel and right media in right channel
 */
async function createStereoSplitVideo(
  inputFiles: string[],
  outputPath: string,
  progressCallback?: (progress: number) => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (inputFiles.length !== 2) {
      reject(new Error("Stereo split requires exactly 2 media files"));
      return;
    }
    
    // Use the shell command approach for reliability
    const ffmpegBin = 'ffmpeg';
    
    // Build a complex filter that:
    // 1. Scales both videos to the same size
    // 2. Puts the first video in the left audio channel only
    // 3. Puts the second video in the right audio channel only
    // 4. Displays videos side by side
    // Also handle framerate differences with fps=25 and vsync=vfr
    const command = `${ffmpegBin} -i "${inputFiles[0]}" -i "${inputFiles[1]}" -filter_complex "[0:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[left_v];[1:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[right_v];[left_v][right_v]hstack=inputs=2[v];[0:a]aresample=44100:async=1000,aformat=sample_fmts=fltp:channel_layouts=stereo,pan=stereo|c0=c0|c1=0[a_left];[1:a]aresample=44100:async=1000,aformat=sample_fmts=fltp:channel_layouts=stereo,pan=stereo|c0=0|c1=c1[a_right];[a_left][a_right]amix=inputs=2:duration=longest[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 23 -vsync vfr -c:a aac -b:a 128k -shortest "${outputPath}"`;
    
    console.log('Running ffmpeg stereo split command:', command);
    
    // Execute command
    const childProcess = exec(command);
    let stderrData = '';
    
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.log('FFmpeg stderr (stereo):', data.toString());
        
        // Parse progress
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
        console.error(`FFmpeg stereo split exited with code ${code}`);
        console.error('stderr:', stderrData);
        reject(new Error(`FFmpeg stereo split failed with code ${code}`));
      }
    });
  });
}

/**
 * Creates a video placeholder for audio files
 * This allows audio files to be used in grid layouts
 */
const createAudioPlaceholderVideo = async (
  audioPath: string,
  outputPath: string,
  progressCallback?: (progress: number) => Promise<void>
): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(audioPath)) {
      reject(new Error(`Audio file not found: ${audioPath}`));
      return;
    }
    
    // Get waveform image if it exists
    const baseFilename = path.basename(audioPath, path.extname(audioPath));
    const waveformPath = path.join(process.cwd(), 'thumbnails', `${baseFilename}_waveform.png`);
    const spectrogramPath = path.join(process.cwd(), 'thumbnails', `${baseFilename}_spectrogram.png`);
    
    // Choose a background image - waveform, spectrogram, or generate a blank one
    let backgroundImage: string;
    
    if (fs.existsSync(waveformPath)) {
      backgroundImage = waveformPath;
    } else if (fs.existsSync(spectrogramPath)) {
      backgroundImage = spectrogramPath;
    } else {
      // Generate a blank image with audio name
      const blankImagePath = path.join(process.cwd(), 'temp', `blank_${baseFilename}.png`);
      
      // Use ffmpeg to create a blank image with text
      const command = `ffmpeg -f lavfi -i color=c=black:s=640x360 -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Audio: ${path.basename(audioPath, path.extname(audioPath))}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2" -frames:v 1 "${blankImagePath}"`;
      
      try {
        execSync(command);
        backgroundImage = blankImagePath;
      } catch (error) {
        console.error('Error creating blank image:', error);
        reject(new Error(`Failed to create placeholder image for audio: ${error}`));
        return;
      }
    }
    
    // Now create a video with the audio
    const ffmpegCommand = ffmpeg();
    
    // Add inputs
    ffmpegCommand.input(backgroundImage);
    ffmpegCommand.input(audioPath);
    
    // Set output options
    ffmpegCommand
      .outputOptions([
        '-c:v libx264',         // Video codec
        '-preset:v fast',        // Fast encoding preset
        '-crf 23',              // Quality level
        '-c:a aac',             // Audio codec
        '-b:a 192k',            // Audio bitrate
        '-shortest',            // End when audio ends
        '-pix_fmt yuv420p'      // Compatible pixel format
      ]);
    
    // Progress tracking
    ffmpegCommand.on('progress', (progress) => {
      if (progressCallback && progress.percent !== undefined) {
        progressCallback(progress.percent / 100).catch(err => {
          console.error('Error updating progress:', err);
        });
      }
    });
    
    // Error handling
    ffmpegCommand.on('error', (err) => {
      console.error('Error creating audio placeholder video:', err);
      reject(err);
    });
    
    // Set output path and start processing
    ffmpegCommand.save(outputPath)
      .on('end', () => {
        if (fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error('Failed to create audio placeholder video'));
        }
      });
  });
};