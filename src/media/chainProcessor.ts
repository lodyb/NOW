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
      
      // Special handling when macroblock is involved
      if (parsedFilters.__stacked_filters && 
          parsedFilters.__stacked_filters.some(f => f.startsWith('macroblock'))) {
        
        // When macroblock is present, process all filters in a single step
        // This ensures the codec settings from macroblock are preserved
        const filterOutputFilename = `filter_combined_${randomId}_${path.basename(currentInputPath)}`;
        
        if (progressCallback) {
          await progressCallback(
            `Applying filters with macroblock: ${parsedFilters.__stacked_filters.join(', ')}`, 
            0.5
          );
        }
        
        const filterOptions: ProcessOptions = {
          filters: parsedFilters,
          enforceDiscordLimit: false,
          progressCallback: async (stage, progress) => {
            if (progressCallback) {
              await progressCallback('Processing with macroblock', 0.5 + progress * 0.4);
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
        } catch (error) {
          console.error(`Error applying filters with macroblock:`, error);
          throw new Error(`Failed to apply filters: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Normal processing without macroblock - process filters one by one
      else if (parsedFilters.__stacked_filters && parsedFilters.__stacked_filters.length > 0) {
        const stackedFilters = parsedFilters.__stacked_filters;
        const totalFilters = stackedFilters.length;
        
        for (let i = 0; i < totalFilters; i++) {
          const filterName = stackedFilters[i];
          const filterOutputFilename = `filter_${i}_${randomId}_${path.basename(currentInputPath)}`;
          
          if (progressCallback) {
            await progressCallback(
              `Filter ${i + 1}/${totalFilters}: ${filterName}`,
              i / totalFilters
            );
          }
          
          // Create filter options for this single filter
          const filterOptions: ProcessOptions = {
            filters: { __stacked_filters: [filterName] }, // Apply just this one filter
            enforceDiscordLimit: false,
            progressCallback: async (stage, progress) => {
              if (progressCallback) {
                const overallProgress = (i + progress) / totalFilters;
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
            if (!isFirstStep) {
              try {
                fs.unlinkSync(currentInputPath);
              } catch (err) {
                console.error('Error cleaning up temporary file:', err);
              }
            }
            
            currentInputPath = processedPath;
            isFirstStep = false;
          } catch (error) {
            console.error(`Error applying filter '${filterName}':`, error);
            throw new Error(`Failed to apply filter '${filterName}': ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else {
        // Process key-value filters one by one
        const filterKeys = Object.keys(parsedFilters).filter(key => 
          key !== '__stacked_filters' && 
          key !== '__raw_complex_filter' && 
          key !== '__overlay_path'
        );
        
        // Check if macroblock is present in key-value filters
        const hasMacroblock = filterKeys.includes('macroblock');
        
        if (hasMacroblock) {
          // When macroblock is present, process all filters in a single step
          const filterOutputFilename = `filter_combined_${randomId}_${path.basename(currentInputPath)}`;
          
          if (progressCallback) {
            await progressCallback(
              `Applying filters with macroblock`, 
              0.5
            );
          }
          
          const filterOptions: ProcessOptions = {
            filters: parsedFilters,
            enforceDiscordLimit: false,
            progressCallback: async (stage, progress) => {
              if (progressCallback) {
                await progressCallback('Processing with macroblock', 0.5 + progress * 0.4);
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
          } catch (error) {
            console.error(`Error applying filters with macroblock:`, error);
            throw new Error(`Failed to apply filters: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          // Process filters one by one (original logic)
          const totalFilters = filterKeys.length;
          
          for (let i = 0; i < totalFilters; i++) {
            const filterKey = filterKeys[i];
            const filterValue = parsedFilters[filterKey];
            const filterOutputFilename = `filter_${i}_${randomId}_${path.basename(currentInputPath)}`;
            
            if (progressCallback) {
              await progressCallback(
                `Filter ${i + 1}/${totalFilters}: ${filterKey}${filterValue ? `=${filterValue}` : ''}`,
                i / totalFilters
              );
            }
            
            // Create filter options for this single filter
            const filterOptions: ProcessOptions = {
              filters: { [filterKey]: filterValue },
              enforceDiscordLimit: false,
              progressCallback: async (stage, progress) => {
                if (progressCallback) {
                  const overallProgress = (i + progress) / totalFilters;
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
              if (!isFirstStep) {
                try {
                  fs.unlinkSync(currentInputPath);
                } catch (err) {
                  console.error('Error cleaning up temporary file:', err);
                }
              }
              
              currentInputPath = processedPath;
              isFirstStep = false;
            } catch (error) {
              console.error(`Error applying filter '${filterKey}':`, error);
              throw new Error(`Failed to apply filter '${filterKey}': ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
    }
    
    // 3. Final step: Apply Discord limits if needed
    if (enforceDiscordLimit) {
      const finalOutputFilename = outputFilename;
      
      if (progressCallback) {
        await progressCallback('Optimizing for Discord', 0.9);
      }
      
      const finalOptions: ProcessOptions = {
        enforceDiscordLimit: true,
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