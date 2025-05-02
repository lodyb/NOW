import ffmpeg from 'fluent-ffmpeg';
import { ParsedEffect, FilterParseResult, parseFilterString, generateFilterStrings } from './filterParser';
import { logFFmpegCommand, logFFmpegError } from '../utils/logger';
import { EffectType, formatEffectForLogging } from './effectRegistry';

export interface MediaFilter {
  [key: string]: string | number | undefined;
  __raw_complex_filter?: string;
}

/**
 * Apply filters to an ffmpeg command
 * @param command The ffmpeg command to modify
 * @param filters Filter configuration object or string
 * @param isVideo Whether we're processing a video file
 * @returns Object with validation results
 */
export const applyFilters = (
  command: ffmpeg.FfmpegCommand, 
  filters: MediaFilter | string,
  isVideo: boolean
): {
  success: boolean;
  errors: string[];
  invalidEffects: string[];
  appliedEffects: string[];
} => {
  try {
    // Convert string filter to MediaFilter object if needed
    if (typeof filters === 'string') {
      filters = { __raw_complex_filter: filters.replace(/^\{|\}$/g, '') };
    }
    
    // If no filters, return early
    if (!filters || Object.keys(filters).length === 0) {
      return { success: true, errors: [], invalidEffects: [], appliedEffects: [] };
    }
    
    // Convert MediaFilter to filter string
    const filterString = mediaFilterToString(filters);
    
    // Parse filter string into structured data
    const parseResult = parseFilterString(filterString);
    
    // Log validation errors if any
    if (parseResult.errors.length > 0) {
      logFFmpegError('Filter validation errors', new Error(parseResult.errors.join(', ')));
    }
    
    if (parseResult.invalidEffects.length > 0) {
      logFFmpegError('Invalid effects', new Error(`Unknown effects: ${parseResult.invalidEffects.join(', ')}`));
    }
    
    // Apply the parsed filters to the ffmpeg command
    return applyParsedFilters(command, parseResult, isVideo);
  } catch (error) {
    logFFmpegError('Error applying filters', error as Error);
    return { 
      success: false, 
      errors: [error instanceof Error ? error.message : String(error)],
      invalidEffects: [],
      appliedEffects: []
    };
  }
};

/**
 * Convert MediaFilter object to filter string format
 */
const mediaFilterToString = (filters: MediaFilter): string => {
  if (filters.__raw_complex_filter) {
    return `{${filters.__raw_complex_filter}}`;
  }
  
  const filterParts = Object.entries(filters).map(([key, value]) => {
    if (value === undefined) return key;
    return `${key}=${value}`;
  });
  
  return `{${filterParts.join(',')}}`;
};

/**
 * Apply parsed filters to an ffmpeg command
 */
const applyParsedFilters = (
  command: ffmpeg.FfmpegCommand,
  parseResult: FilterParseResult,
  isVideo: boolean
): {
  success: boolean;
  errors: string[];
  invalidEffects: string[];
  appliedEffects: string[];
} => {
  // Convert parsed effects to filter strings
  const { audioFilters, videoFilters, complexFilters } = generateFilterStrings(parseResult, isVideo);
  
  // Apply audio filters
  if (audioFilters.length > 0) {
    const audioFilterStr = audioFilters.join(',');
    command.audioFilters(audioFilterStr);
    logFFmpegCommand(`Applied audio filters: ${audioFilterStr}`);
  }
  
  // Apply video filters (only for video files)
  if (videoFilters.length > 0 && isVideo) {
    const videoFilterStr = videoFilters.join(',');
    command.videoFilters(videoFilterStr);
    logFFmpegCommand(`Applied video filters: ${videoFilterStr}`);
  }
  
  // Apply complex filters
  if (complexFilters.length > 0 && isVideo) {
    complexFilters.forEach(filter => {
      command.complexFilter(filter);
      logFFmpegCommand(`Applied complex filter: ${filter}`);
    });
  }
  
  // Get list of applied effects for reporting
  const appliedEffects = parseResult.effects
    .filter(e => !e.error)
    .map(e => formatEffectForLogging(e.originalName, e.value));
  
  if (parseResult.rawComplexFilter) {
    appliedEffects.push(`raw_filter:${parseResult.rawComplexFilter}`);
  }
  
  return {
    success: parseResult.errors.length === 0,
    errors: parseResult.errors,
    invalidEffects: parseResult.invalidEffects,
    appliedEffects
  };
};