import { Message, AttachmentBuilder } from 'discord.js';
import { processMedia, isVideoFile, getMediaDuration, ProcessOptions, parseFilterString } from '../../../media/processor';
import { safeReply } from '../../utils/helpers';
import { MediaService, FileService, StatusService } from '../../services';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';

interface GridOptions {
  mediaDelay?: number;
  mediaSpeed?: number; 
  msyncEnabled?: boolean;
  msyncDuration?: number | null;
}

export async function handleMultiMediaPlayback(
  message: Message,
  searchTerm?: string,
  multi: number = 2,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
): Promise<void> {
  const updateStatus = StatusService.createStatusUpdater(message);
  
  try {
    multi = Math.min(Math.max(2, multi), 9);
    const gridOptions = parseGridOptions(filterString);
    
    await updateStatus(`Processing multi-media request (${multi} items)... ⏳`);
    
    const mediaItems = await MediaService.findMedia(searchTerm, false, multi);
    
    if (mediaItems.length === 0) {
      await updateStatus(`No media files found ${searchTerm ? `for "${searchTerm}"` : 'in the database'}`);
      return;
    }
    
    // Duplicate items if needed to fill grid
    while (mediaItems.length < multi) {
      const itemToDuplicate = mediaItems[mediaItems.length % mediaItems.length];
      mediaItems.push(itemToDuplicate);
    }
    
    const randomId = FileService.generateCryptoId();
    const tempDir = MediaService.getTempDir();
    const processedFiles: string[] = [];
    
    await updateStatus(`Processing ${multi} media files for grid layout... ⏳`);
    
    for (let i = 0; i < multi; i++) {
      const media = mediaItems[i];
      const filePath = MediaService.resolveMediaPath(media);
      
      if (!MediaService.validateMediaExists(filePath)) continue;
      
      let processedPath = filePath;
      
      if (filterString || clipOptions || gridOptions.msyncEnabled) {
        const outputFilename = `temp_grid_${randomId}_${i}_${path.basename(filePath)}`;
        const options: ProcessOptions = {};
        
        if (filterString) {
          options.filters = parseFilterString(filterString);
        }
        
        if (clipOptions) {
          options.clip = clipOptions;
        }
        
        if (gridOptions.msyncEnabled) {
          // Apply speed adjustment for sync
          const mediaDuration = await getMediaDuration(filePath);
          if (mediaDuration > 0 && gridOptions.msyncDuration) {
            const speedFactor = Math.min(2.0, Math.max(0.5, mediaDuration / gridOptions.msyncDuration));
            
            if (!options.filters) options.filters = {};
            if (await isVideoFile(filePath)) {
              options.filters.setpts = `${1.0/speedFactor}*PTS`;
            }
            options.filters.atempo = speedFactor.toString();
          }
        }
        
        options.enforceDiscordLimit = false;
        processedPath = await processMedia(filePath, outputFilename, options);
      }
      
      processedFiles.push(processedPath);
    }
    
    if (processedFiles.length === 0) {
      await updateStatus('Failed to process any media files ❌');
      return;
    }
    
    const gridDimensions = calculateGridDimensions(multi);
    const outputFilename = `grid_${randomId}.mp4`;
    const outputPath = path.join(tempDir, outputFilename);
    
    if (processedFiles.length === 2) {
      await updateStatus('Creating side-by-side video... ⏳');
      await createSideBySideVideo(processedFiles, outputPath);
    } else {
      await updateStatus(`Creating ${multi}-item grid layout... ⏳`);
      await createVideoGrid(processedFiles, outputPath, gridDimensions, gridOptions);
    }
    
    await updateStatus('Optimizing for Discord... ⏳');
    
    const finalOutputFilename = `final_grid_${randomId}.mp4`;
    const options: ProcessOptions = { enforceDiscordLimit: true };
    const finalPath = await processMedia(outputPath, finalOutputFilename, options);
    
    if (!MediaService.validateMediaExists(finalPath)) {
      throw new Error('Failed to create final grid video');
    }
    
    await updateStatus('Grid complete! Uploading... 📤');
    
    const attachment = new AttachmentBuilder(finalPath);
    await safeReply(message, { files: [attachment] });
    
    FileService.cleanupTempFiles([...processedFiles, outputPath, finalPath]);
    
  } catch (error) {
    console.error('Error handling multi-media playback:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
}

function parseGridOptions(filterString?: string): GridOptions {
  const options: GridOptions = {
    mediaDelay: 0,
    mediaSpeed: 1.0,
    msyncEnabled: false,
    msyncDuration: null
  };
  
  if (!filterString) return options;
  
  const delayMatch = filterString.match(/mdelay=(\d+)/);
  if (delayMatch) {
    options.mediaDelay = Math.min(5000, Math.max(0, parseInt(delayMatch[1], 10)));
  }
  
  const speedMatch = filterString.match(/mspeed=(\d+(\.\d+)?)/);
  if (speedMatch) {
    options.mediaSpeed = Math.min(2.0, Math.max(0.5, parseFloat(speedMatch[1])));
  }
  
  const msyncMatch = filterString.match(/msync(=(\d+))?/);
  if (msyncMatch) {
    options.msyncEnabled = true;
    if (msyncMatch[2]) {
      options.msyncDuration = Math.min(300, Math.max(1, parseInt(msyncMatch[2], 10)));
    }
  }
  
  return options;
}

function calculateGridDimensions(count: number): { rows: number; cols: number } {
  if (count <= 4) return { rows: 2, cols: 2 };
  if (count <= 6) return { rows: 2, cols: 3 };
  return { rows: 3, cols: 3 };
}

function createSideBySideVideo(inputFiles: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i "${inputFiles[0]}" -i "${inputFiles[1]}" -filter_complex "[0:v]scale=640:360[left];[1:v]scale=640:360[right];[left][right]hstack[v];[0:a][1:a]amix=inputs=2[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k -shortest "${outputPath}"`;
    
    exec(command, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createVideoGrid(
  inputFiles: string[], 
  outputPath: string, 
  grid: { rows: number; cols: number },
  options: GridOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { rows, cols } = grid;
    const fileCount = Math.min(inputFiles.length, rows * cols);
    
    if (fileCount <= 1) {
      const command = `ffmpeg -i "${inputFiles[0]}" -c copy "${outputPath}"`;
      exec(command, (error) => {
        if (error) reject(error);
        else resolve();
      });
      return;
    }
    
    let inputArgs = '';
    let filterComplex = '';
    
    for (let i = 0; i < fileCount; i++) {
      inputArgs += ` -i "${inputFiles[i]}"`;
      filterComplex += `[${i}:v]scale=320:240[v${i}];`;
      filterComplex += `[${i}:a]volume=1[a${i}];`;
    }
    
    // Create rows
    for (let r = 0; r < rows; r++) {
      const rowInputs = [];
      for (let c = 0; c < cols; c++) {
        const index = r * cols + c;
        if (index < fileCount) {
          rowInputs.push(`[v${index}]`);
        }
      }
      
      if (rowInputs.length > 0) {
        filterComplex += `${rowInputs.join('')}hstack=inputs=${rowInputs.length}[row${r}];`;
      }
    }
    
    // Stack rows vertically
    const rowRefs = Array.from({ length: rows }, (_, i) => `[row${i}]`);
    if (rowRefs.length > 1) {
      filterComplex += `${rowRefs.join('')}vstack=inputs=${rowRefs.length}[vout];`;
    } else {
      filterComplex += `[row0]copy[vout];`;
    }
    
    // Mix audio
    const audioInputs = Array.from({ length: fileCount }, (_, i) => `[a${i}]`).join('');
    if (fileCount > 1) {
      filterComplex += `${audioInputs}amix=inputs=${fileCount}:dropout_transition=0[aout]`;
    } else {
      filterComplex += `${audioInputs}acopy[aout]`;
    }
    
    const command = `ffmpeg${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k -shortest "${outputPath}"`;
    
    exec(command, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}