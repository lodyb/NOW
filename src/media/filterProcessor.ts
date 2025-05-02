import ffmpeg from 'fluent-ffmpeg';
import { logFFmpegCommand, logFFmpegError } from '../utils/logger';
import { parseFilterString, parseEffects, FilterParseResult } from './filterParser';

/**
 * Apply filters to a ffmpeg command
 * Handles applying audio, video, and complex filters based on their types
 */
export const applyFilters = (
  command: ffmpeg.FfmpegCommand, 
  filters: Record<string, string | number | undefined>, 
  isVideo: boolean
): void => {
  try {
    // Log filter application attempt
    logFFmpegCommand(`Applying filters to ${isVideo ? 'video' : 'audio'} file: ${JSON.stringify(filters)}`);
    
    // Parse and validate filters - filter out undefined values
    const cleanedFilters: Record<string, string | number> = {};
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined) {
        cleanedFilters[key] = value;
      }
    });
    
    const parsedFilters = parseEffects(cleanedFilters);
    
    // Check for video filters in audio-only file
    if (!isVideo && (parsedFilters.videoFilters.length > 0 || parsedFilters.complexFilters.length > 0)) {
      const videoEffects = parsedFilters.effects
        .filter(e => e.effectType === 'video' || e.effectType === 'complex')
        .map(e => e.name)
        .join(', ');
        
      const err = new Error(
        `Cannot apply video effects to audio file: ${videoEffects}. ` +
        `This file is audio-only and doesn't support video effects.`
      );
      logFFmpegError('Filter type mismatch', err);
      throw err;
    }
    
    // Handle raw complex filter if present (prioritize over parsed filters)
    if (parsedFilters.rawComplexFilter) {
      if (isVideo) {
        // For video files, we can use complex filtergraph
        command.complexFilter(parsedFilters.rawComplexFilter);
        logFFmpegCommand(`Applied raw complex filter: ${parsedFilters.rawComplexFilter}`);
        return; // Skip other filter processing
      } else {
        // For audio-only files, check if it contains video-specific operations
        if (
          parsedFilters.rawComplexFilter.includes('[v]') || 
          parsedFilters.rawComplexFilter.includes('[0:v]') || 
          /\[[0-9]+:[v]\]/.test(parsedFilters.rawComplexFilter)
        ) {
          throw new Error(
            `The complex filter "${parsedFilters.rawComplexFilter}" appears to require video streams, ` +
            `but this is an audio-only file.`
          );
        }
        
        // Apply as audio filter if it seems audio-compatible
        command.audioFilters(parsedFilters.rawComplexFilter);
        logFFmpegCommand(`Applied raw audio filter: ${parsedFilters.rawComplexFilter}`);
        return; // Skip other filter processing
      }
    }
    
    // Apply standard filter categories
    if (parsedFilters.audioFilters.length > 0) {
      const audioFilterStr = parsedFilters.audioFilters.join(',');
      command.audioFilters(audioFilterStr);
      logFFmpegCommand(`Applied audio filters: ${audioFilterStr}`);
    }
    
    if (isVideo && parsedFilters.videoFilters.length > 0) {
      const videoFilterStr = parsedFilters.videoFilters.join(',');
      command.videoFilters(videoFilterStr);
      logFFmpegCommand(`Applied video filters: ${videoFilterStr}`);
    }
    
    // Apply complex filters
    if (isVideo && parsedFilters.complexFilters.length > 0) {
      parsedFilters.complexFilters.forEach(filter => {
        // Special handling for filters that use [v] and [a] pad names
        if (filter.includes('[v];') && filter.includes('[a]')) {
          command.complexFilter(filter, ['v', 'a']);
        } else {
          command.complexFilter(filter);
        }
        logFFmpegCommand(`Applied complex filter: ${filter}`);
      });
    }
  } catch (error) {
    logFFmpegError(`Error in applyFilters: ${error}`, error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Error applying filters: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Parse clip options for media processing
 */
export interface ClipOptions {
  duration?: string;
  start?: string;
}

export const parseClipOptions = (args: string[]): ClipOptions => {
  const options: ClipOptions = {};
  
  args.forEach(arg => {
    if (arg.startsWith('clip=')) {
      options.duration = arg.substring(5);
    } else if (arg.startsWith('start=')) {
      options.start = arg.substring(6);
    }
  });
  
  return options;
};