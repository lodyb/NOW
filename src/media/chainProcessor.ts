import { parseFilterString, parseClipOptions, processMedia, ProcessOptions } from './processor';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// Directory for temporary files
const TEMP_DIR = path.join(process.cwd(), 'temp');

/**
 * Process a media file with a chain of filters
 * Each filter is applied sequentially, using the output of the previous filter as input
 * 
 * @param inputPath - Path to the input media file
 * @param outputFilename - Filename (not full path) for the final output file
 * @param filterString - Filter string in the format "{filter1=value1,filter2=value2}"
 * @param clipOptions - Optional clip options (duration, start position)
 * @param progressCallback - Optional callback for progress updates
 * @param enforceDiscordLimit - Whether to enforce Discord's file size limits
 * @returns Path to the processed file
 */
export const processFilterChain = async (
  inputPath: string,
  outputFilename: string,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string },
  progressCallback?: (stage: string, progress: number) => Promise<void>,
  enforceDiscordLimit: boolean = true
): Promise<string> => {
  try {
    // If we don't have any filters or clip options, just apply Discord limits if needed
    if ((!filterString || filterString === '{}') && 
        (!clipOptions || Object.keys(clipOptions).length === 0)) {
      
      if (enforceDiscordLimit) {
        // Apply Discord size limit without any filters
        return processMedia(
          inputPath, 
          outputFilename, 
          { enforceDiscordLimit: true, progressCallback }
        );
      } else {
        // Just copy the file
        const outputPath = path.join(TEMP_DIR, outputFilename);
        await copyFile(inputPath, outputPath);
        return outputPath;
      }
    }
    
    // Generate random ID for temporary files
    const randomId = crypto.randomBytes(4).toString('hex');
    
    let currentInputPath = inputPath;
    let isFirstStep = true;
    
    // 1. Apply clip options first if provided
    if (clipOptions && Object.keys(clipOptions).length > 0) {
      const clipOutputFilename = `clip_${randomId}_${path.basename(inputPath)}`;
      const clipOutputPath = path.join(TEMP_DIR, clipOutputFilename);
      
      if (progressCallback) {
        await progressCallback('Applying clip options', 0);
      }
      
      const options: ProcessOptions = {
        clip: clipOptions,
        enforceDiscordLimit: false,
        progressCallback: async (stage, progress) => {
          if (progressCallback) {
            await progressCallback('Clipping media', progress);
          }
        }
      };
      
      currentInputPath = await processMedia(currentInputPath, clipOutputFilename, options);
      isFirstStep = false;
    }
    
    // 2. Parse the filter string if provided
    if (filterString && filterString !== '{}') {
      const parsedFilters = parseFilterString(filterString);
      const filterKeys = Object.keys(parsedFilters);
      
      // Process each filter in sequence
      for (let i = 0; i < filterKeys.length; i++) {
        const filterKey = filterKeys[i];
        const filterValue = parsedFilters[filterKey];
        
        // Apply this individual filter
        const filterOutputFilename = `filter_${i}_${randomId}_${path.basename(currentInputPath)}`;
        
        if (progressCallback) {
          await progressCallback(
            `Applying filter: ${filterKey}${filterValue ? `=${filterValue}` : ''}`, 
            0
          );
        }
        
        // Create filter options for this single filter
        const filterOptions: ProcessOptions = {
          filters: { [filterKey]: filterValue },
          enforceDiscordLimit: false,
          progressCallback: async (stage, progress) => {
            if (progressCallback) {
              await progressCallback(
                `Filter ${i + 1}/${filterKeys.length}: ${filterKey}`, 
                progress
              );
            }
          }
        };
        
        // Process the media with this single filter
        const processedPath = await processMedia(
          currentInputPath, 
          filterOutputFilename, 
          filterOptions
        );
        
        // Update the current input path for the next filter
        if (!isFirstStep) {
          // Clean up the previous temporary file
          try {
            fs.unlinkSync(currentInputPath);
          } catch (err) {
            console.error('Error cleaning up temporary file:', err);
          }
        }
        
        currentInputPath = processedPath;
        isFirstStep = false;
      }
    }
    
    // 3. Final step: Apply Discord limits if needed
    if (enforceDiscordLimit) {
      const finalOutputFilename = outputFilename;
      
      if (progressCallback) {
        await progressCallback('Optimizing for Discord', 0);
      }
      
      const finalOptions: ProcessOptions = {
        enforceDiscordLimit: true,
        progressCallback: async (stage, progress) => {
          if (progressCallback) {
            await progressCallback('Finalizing', progress);
          }
        }
      };
      
      const finalPath = await processMedia(currentInputPath, finalOutputFilename, finalOptions);
      
      // Clean up the last temporary file
      if (!isFirstStep) {
        try {
          fs.unlinkSync(currentInputPath);
        } catch (err) {
          console.error('Error cleaning up temporary file:', err);
        }
      }
      
      return finalPath;
    } else {
      // If we don't need to enforce Discord limits, use the current file
      return currentInputPath;
    }
  } catch (error) {
    console.error('Error in processFilterChain:', error);
    throw error;
  }
};

/**
 * Simple utility to copy a file
 */
const copyFile = async (src: string, dest: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    fs.copyFile(src, dest, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};