import { parseFilterString, parseClipOptions, processMedia, ProcessOptions, getDjFilters } from './processor';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// Directory for temporary files
const TEMP_DIR = path.join(process.cwd(), 'temp');

/**
 * Result of a filter application attempt
 */
interface FilterResult {
  success: boolean;
  filterName: string;
  outputPath?: string;
  error?: string;
}

/**
 * Process a media file with a chain of filters with robust error handling
 * Failed filters are skipped and processing continues with remaining filters
 * 
 * @param inputPath - Path to the input media file
 * @param outputFilename - Filename (not full path) for the final output file
 * @param filterString - Filter string in the format "{filter1=value1,filter2=value2}"
 * @param clipOptions - Optional clip options (duration, start position)
 * @param progressCallback - Optional callback for progress updates
 * @param enforceDiscordLimit - Whether to enforce Discord's file size limits
 * @returns Object with final path and applied filters info
 */
export const processFilterChainRobust = async (
  inputPath: string,
  outputFilename: string,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string },
  progressCallback?: (stage: string, progress: number) => Promise<void>,
  enforceDiscordLimit: boolean = true
): Promise<{ path: string; appliedFilters: string[]; skippedFilters: string[] }> => {
  const appliedFilters: string[] = [];
  const skippedFilters: string[] = [];
  
  try {
    // If we don't have any filters or clip options, just apply Discord limits if needed
    if ((!filterString || filterString === '{}') && 
        (!clipOptions || Object.keys(clipOptions).length === 0)) {
      
      if (enforceDiscordLimit) {
        const path = await processMedia(
          inputPath, 
          outputFilename, 
          { enforceDiscordLimit: true, progressCallback }
        );
        return { path, appliedFilters, skippedFilters };
      } else {
        // Just copy the file
        const outputPath = path.join(TEMP_DIR, outputFilename);
        await copyFile(inputPath, outputPath);
        return { path: outputPath, appliedFilters, skippedFilters };
      }
    }

    let currentInputPath = inputPath;
    let isFirstStep = true;
    const randomId = crypto.randomBytes(4).toString('hex');

    // 1. Apply clip options first if provided
    if (clipOptions && (clipOptions.duration || clipOptions.start)) {
      try {
        const clipOutputFilename = `clip_${randomId}_${path.basename(inputPath)}`;
        
        if (progressCallback) {
          await progressCallback('Applying clip options', 0.1);
        }
        
        const clipResult = await processMedia(currentInputPath, clipOutputFilename, {
          clip: clipOptions,
          enforceDiscordLimit: false,
          progressCallback: async (stage, progress) => {
            if (progressCallback) {
              await progressCallback(stage, 0.1 + progress * 0.2);
            }
          }
        });
        
        currentInputPath = clipResult;
        isFirstStep = false;
        appliedFilters.push('clip');
      } catch (error) {
        console.error('Error applying clip options:', error);
        skippedFilters.push('clip');
        // Continue without clipping
      }
    }

    // 2. Parse the filter string if provided
    if (filterString && filterString !== '{}') {
      const parsedFilters = parseFilterString(filterString);
      
      // Handle stacked filters with robust error handling
      if (parsedFilters.__stacked_filters && parsedFilters.__stacked_filters.length > 0) {
        let stackedFilters = parsedFilters.__stacked_filters;
        
        // Check if this is DJ mode and implement retry logic
        if (stackedFilters.length === 2 && filterString.toLowerCase().includes('dj')) {
          const maxRetries = 3;
          let retryCount = 0;
          let djSuccess = false;
          const blacklistedFilters: string[] = [];
          
          while (!djSuccess && retryCount < maxRetries) {
            try {
              if (retryCount > 0) {
                // Get new DJ filters excluding blacklisted ones
                stackedFilters = getDjFilters(blacklistedFilters);
                console.log(`DJ retry attempt ${retryCount}: ${stackedFilters.join(', ')}`);
              }
              
              const filterOutputFilename = `dj_attempt_${retryCount}_${randomId}_${path.basename(currentInputPath)}`;
              
              if (progressCallback) {
                await progressCallback(
                  `Applying DJ filters (attempt ${retryCount + 1}): ${stackedFilters.join(', ')}`, 
                  0.3
                );
              }
              
              const filterOptions: ProcessOptions = {
                filters: { __stacked_filters: stackedFilters },
                enforceDiscordLimit: false,
                progressCallback: async (stage, progress) => {
                  if (progressCallback) {
                    await progressCallback(`DJ filters: ${stage}`, 0.3 + progress * 0.4);
                  }
                }
              };
              
              const processedPath = await processMedia(
                currentInputPath,
                filterOutputFilename,
                filterOptions
              );
              
              // Success! Clean up previous file and continue
              if (!isFirstStep) {
                try {
                  fs.unlinkSync(currentInputPath);
                } catch (err) {
                  console.error('Error cleaning up temporary file:', err);
                }
              }
              
              currentInputPath = processedPath;
              isFirstStep = false;
              appliedFilters.push(...stackedFilters);
              djSuccess = true;
              console.log(`✅ DJ filters applied successfully: ${stackedFilters.join(', ')}`);
              
            } catch (error) {
              console.error(`❌ DJ attempt ${retryCount + 1} failed:`, error);
              
              // Blacklist the failed filters and try again
              blacklistedFilters.push(...stackedFilters);
              retryCount++;
              
              if (retryCount >= maxRetries) {
                console.error('All DJ filter attempts failed, skipping DJ mode');
                skippedFilters.push('dj');
              }
            }
          }
        } else {
          // Regular stacked filter processing
          const totalFilters = stackedFilters.length;
          
          // Check if macroblock is present - if so, try to process all together first
          const hasMacroblock = stackedFilters.some(f => f.startsWith('macroblock'));
          
          if (hasMacroblock) {
            // Try to process all filters together with macroblock
            const filterOutputFilename = `filter_combined_${randomId}_${path.basename(currentInputPath)}`;
            
            if (progressCallback) {
              await progressCallback(
                `Applying filters with macroblock: ${stackedFilters.join(', ')}`, 
                0.3
              );
            }
            
            const filterOptions: ProcessOptions = {
              filters: parsedFilters,
              enforceDiscordLimit: false,
              progressCallback: async (stage, progress) => {
                if (progressCallback) {
                  await progressCallback('Processing with macroblock', 0.3 + progress * 0.4);
                }
              }
            };
            
            try {
              const processedPath = await processMedia(
                currentInputPath,
                filterOutputFilename,
                filterOptions
              );
              
              // Clean up the previous temporary file
              if (!isFirstStep) {
                try {
                  fs.unlinkSync(currentInputPath);
                } catch (err) {
                  console.error('Error cleaning up temporary file:', err);
                }
              }
              
              currentInputPath = processedPath;
              isFirstStep = false;
              appliedFilters.push(...stackedFilters);
            } catch (error) {
              console.error(`Error applying filters with macroblock:`, error);
              
              // Fall back to individual filter processing, skipping macroblock
              skippedFilters.push('macroblock');
              
              const nonMacroblockFilters = stackedFilters.filter(f => !f.startsWith('macroblock'));
              const result = await processFiltersIndividually(
                nonMacroblockFilters,
                currentInputPath,
                randomId,
                isFirstStep,
                progressCallback,
                0.3
              );
              
              currentInputPath = result.outputPath;
              isFirstStep = result.isFirstStep;
              appliedFilters.push(...result.appliedFilters);
              skippedFilters.push(...result.skippedFilters);
            }
          } else {
            // Process filters individually
            const result = await processFiltersIndividually(
              stackedFilters,
              currentInputPath,
              randomId,
              isFirstStep,
              progressCallback,
              0.3
            );
            
            currentInputPath = result.outputPath;
            isFirstStep = result.isFirstStep;
            appliedFilters.push(...result.appliedFilters);
            skippedFilters.push(...result.skippedFilters);
          }
        }
      } else {
        // Process key-value filters individually
        const filterKeys = Object.keys(parsedFilters).filter(key => 
          key !== '__stacked_filters' && 
          key !== '__raw_complex_filter' && 
          key !== '__overlay_path'
        );
        
        const result = await processKeyValueFiltersIndividually(
          filterKeys,
          parsedFilters,
          currentInputPath,
          randomId,
          isFirstStep,
          progressCallback,
          0.3
        );
        
        currentInputPath = result.outputPath;
        isFirstStep = result.isFirstStep;
        appliedFilters.push(...result.appliedFilters);
        skippedFilters.push(...result.skippedFilters);
      }
    }

    // 3. Final step: Apply Discord limits if needed
    if (enforceDiscordLimit) {
      // Ensure correct file extension - videos should be .mp4, audio should be .ogg
      let finalOutputFilename = outputFilename;
      const isVideo = await import('./processor').then(p => p.isVideoFile(currentInputPath));
      
      if (isVideo && !finalOutputFilename.toLowerCase().endsWith('.mp4')) {
        // Replace extension with .mp4 for videos
        finalOutputFilename = finalOutputFilename.replace(/\.[^.]+$/, '.mp4');
      } else if (!isVideo && !finalOutputFilename.toLowerCase().endsWith('.ogg')) {
        // Replace extension with .ogg for audio
        finalOutputFilename = finalOutputFilename.replace(/\.[^.]+$/, '.ogg');
      }
      
      if (progressCallback) {
        await progressCallback('Optimizing for Discord', 0.9);
      }
      
      const finalOptions: ProcessOptions = {
        enforceDiscordLimit: true,
        // Add 30-second duration limit for videos to ensure they embed properly in Discord
        clip: isVideo ? { duration: '30' } : undefined,
        progressCallback: async (stage, progress) => {
          if (progressCallback) {
            await progressCallback('Finalizing', 0.9 + progress * 0.1);
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
      
      return { path: finalPath, appliedFilters, skippedFilters };
    } else {
      // If we don't need to enforce Discord limits, use the current file
      return { path: currentInputPath, appliedFilters, skippedFilters };
    }
  } catch (error) {
    console.error('Error in processFilterChainRobust:', error);
    throw error;
  }
};

/**
 * Process filters individually with error handling
 */
async function processFiltersIndividually(
  filters: string[],
  inputPath: string,
  randomId: string,
  isFirstStep: boolean,
  progressCallback?: (stage: string, progress: number) => Promise<void>,
  baseProgress: number = 0
): Promise<{ outputPath: string; isFirstStep: boolean; appliedFilters: string[]; skippedFilters: string[] }> {
  const appliedFilters: string[] = [];
  const skippedFilters: string[] = [];
  let currentInputPath = inputPath;
  let currentIsFirstStep = isFirstStep;
  
  const totalFilters = filters.length;
  const progressRange = 0.6 - baseProgress; // Use remaining progress space
  
  for (let i = 0; i < totalFilters; i++) {
    const filterName = filters[i];
    const filterOutputFilename = `filter_${i}_${randomId}_${path.basename(currentInputPath)}`;
    
    if (progressCallback) {
      await progressCallback(
        `Filter ${i + 1}/${totalFilters}: ${filterName}`,
        baseProgress + (i / totalFilters) * progressRange
      );
    }
    
    const filterOptions: ProcessOptions = {
      filters: { __stacked_filters: [filterName] },
      enforceDiscordLimit: false,
      progressCallback: async (stage, progress) => {
        if (progressCallback) {
          const overallProgress = baseProgress + ((i + progress) / totalFilters) * progressRange;
          await progressCallback(
            `Filter ${i + 1}/${totalFilters}: ${filterName}`,
            overallProgress
          );
        }
      }
    };
    
    try {
      const processedPath = await processMedia(
        currentInputPath,
        filterOutputFilename,
        filterOptions
      );
      
      // Clean up the previous temporary file
      if (!currentIsFirstStep) {
        try {
          fs.unlinkSync(currentInputPath);
        } catch (err) {
          console.error('Error cleaning up temporary file:', err);
        }
      }
      
      currentInputPath = processedPath;
      currentIsFirstStep = false;
      appliedFilters.push(filterName);
      
      console.log(`✅ Successfully applied filter: ${filterName}`);
    } catch (error) {
      console.error(`❌ Skipping filter '${filterName}':`, error);
      skippedFilters.push(filterName);
      // Continue with the current file - don't break the chain
    }
  }
  
  return {
    outputPath: currentInputPath,
    isFirstStep: currentIsFirstStep,
    appliedFilters,
    skippedFilters
  };
}

/**
 * Process key-value filters individually with error handling
 */
async function processKeyValueFiltersIndividually(
  filterKeys: string[],
  parsedFilters: any,
  inputPath: string,
  randomId: string,
  isFirstStep: boolean,
  progressCallback?: (stage: string, progress: number) => Promise<void>,
  baseProgress: number = 0
): Promise<{ outputPath: string; isFirstStep: boolean; appliedFilters: string[]; skippedFilters: string[] }> {
  const appliedFilters: string[] = [];
  const skippedFilters: string[] = [];
  let currentInputPath = inputPath;
  let currentIsFirstStep = isFirstStep;
  
  const totalFilters = filterKeys.length;
  const progressRange = 0.6 - baseProgress;
  
  for (let i = 0; i < totalFilters; i++) {
    const filterKey = filterKeys[i];
    const filterValue = parsedFilters[filterKey];
    const filterOutputFilename = `filter_${i}_${randomId}_${path.basename(currentInputPath)}`;
    
    if (progressCallback) {
      await progressCallback(
        `Filter ${i + 1}/${totalFilters}: ${filterKey}${filterValue ? `=${filterValue}` : ''}`,
        baseProgress + (i / totalFilters) * progressRange
      );
    }
    
    const filterOptions: ProcessOptions = {
      filters: { [filterKey]: filterValue },
      enforceDiscordLimit: false,
      progressCallback: async (stage, progress) => {
        if (progressCallback) {
          const overallProgress = baseProgress + ((i + progress) / totalFilters) * progressRange;
          await progressCallback(
            `Filter ${i + 1}/${totalFilters}: ${filterKey}`,
            overallProgress
          );
        }
      }
    };
    
    try {
      const processedPath = await processMedia(
        currentInputPath,
        filterOutputFilename,
        filterOptions
      );
      
      // Clean up the previous temporary file
      if (!currentIsFirstStep) {
        try {
          fs.unlinkSync(currentInputPath);
        } catch (err) {
          console.error('Error cleaning up temporary file:', err);
        }
      }
      
      currentInputPath = processedPath;
      currentIsFirstStep = false;
      appliedFilters.push(filterKey);
      
      console.log(`✅ Successfully applied filter: ${filterKey}=${filterValue}`);
    } catch (error) {
      console.error(`❌ Skipping filter '${filterKey}':`, error);
      skippedFilters.push(filterKey);
      // Continue with the current file
    }
  }
  
  return {
    outputPath: currentInputPath,
    isFirstStep: currentIsFirstStep,
    appliedFilters,
    skippedFilters
  };
}

/**
 * Legacy function that calls the robust version for backwards compatibility
 * Throws error if any filter fails (original behavior)
 */
export const processFilterChain = async (
  inputPath: string,
  outputFilename: string,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string },
  progressCallback?: (stage: string, progress: number) => Promise<void>,
  enforceDiscordLimit: boolean = true
): Promise<string> => {
  const result = await processFilterChainRobust(
    inputPath,
    outputFilename,
    filterString,
    clipOptions,
    progressCallback,
    enforceDiscordLimit
  );
  
  // Log any skipped filters but don't throw an error unless nothing worked
  if (result.skippedFilters.length > 0) {
    console.warn(`Some filters were skipped: ${result.skippedFilters.join(', ')}`);
  }
  
  return result.path;
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