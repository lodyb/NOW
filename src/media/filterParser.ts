import { Effect, EffectType, effectRegistry, effectAliases, resolveEffectName, effectExists } from './effectRegistry';
import { logFFmpegCommand, logFFmpegError } from '../utils/logger';

export interface ParsedEffect {
  name: string;
  value?: number | string;
  resolvedName: string;
  effectType: EffectType;
  filterString: string;
}

export interface FilterParseResult {
  audioFilters: string[];
  videoFilters: string[];
  complexFilters: string[];
  rawComplexFilter?: string;
  effects: ParsedEffect[];
}

/**
 * Parse a filter string into a structured filter object
 * Handles formats like: 
 * - {filter1=value1,filter2=value2}
 * - {filter1,filter2=value}
 * - {raw_complex_filter_string}
 */
export const parseFilterString = (filterString: string): Record<string, number | string> => {
  if (!filterString || !filterString.trim()) {
    return {};
  }

  // Normalize filter string format
  const normalizedStr = filterString.trim();
  if (!normalizedStr.startsWith('{') || !normalizedStr.endsWith('}')) {
    throw new Error('Invalid filter format. Expected format: {filter1=value1,filter2=value2}');
  }
  
  const content = normalizedStr.substring(1, normalizedStr.length - 1).trim();
  
  // Handle empty filter string
  if (!content) {
    return {};
  }
  
  // Check if this is a raw complex filter string (no key=value format)
  if (!content.includes('=') || content.includes(';')) {
    // This appears to be a raw complex filter string
    return { __raw_complex_filter: content };
  }
  
  const filters: Record<string, number | string> = {};
  
  // Handle complex filters with nested parameters more intelligently
  let segmentStart = 0;
  let currentKey = '';
  let inQuote = false;
  let depth = 0;
  
  for (let i = 0; i <= content.length; i++) {
    const char = i < content.length ? content[i] : ',';
    
    // Handle quotes
    if (char === "'" || char === '"') {
      inQuote = !inQuote;
      continue;
    }
    
    // Skip processing if inside quotes
    if (inQuote) continue;
    
    // Track nested structure depth
    if (char === '(') depth++;
    if (char === ')') depth--;
    
    // Process key-value pairs
    if (char === '=' && !currentKey) {
      currentKey = content.substring(segmentStart, i).trim();
      segmentStart = i + 1;
    } else if ((char === ',' && depth === 0) || i === content.length) {
      // End of segment
      if (currentKey) {
        // We have a key-value pair
        const value = content.substring(segmentStart, i).trim();
        
        // Convert to number if possible, otherwise keep as string
        const numValue = Number(value);
        filters[currentKey] = isNaN(numValue) ? value : numValue;
        
        currentKey = '';
      } else if (i > segmentStart) {
        // Handle filter without value (flag)
        const key = content.substring(segmentStart, i).trim();
        if (key) {
          filters[key] = 1; // Default value for flags is 1 (enabled)
        }
      }
      segmentStart = i + 1;
    }
  }
  
  return filters;
};

/**
 * Parse filters into structured format with validation
 * Returns categorized filters ready to be applied
 */
export const parseEffects = (filters: Record<string, number | string>): FilterParseResult => {
  const result: FilterParseResult = {
    audioFilters: [],
    videoFilters: [],
    complexFilters: [],
    effects: []
  };
  
  // Handle raw complex filter string case
  if (filters.__raw_complex_filter) {
    result.rawComplexFilter = filters.__raw_complex_filter as string;
    // Try to parse the raw filter as a single effect name
    const effectName = filters.__raw_complex_filter as string;
    if (effectExists(effectName)) {
      const resolvedName = resolveEffectName(effectName);
      const effect = effectRegistry[resolvedName];
      
      // Special case for single effect - it might be a custom effect
      if (effect) {
        const filterString = effect.apply();
        result.effects.push({
          name: effectName,
          resolvedName,
          effectType: effect.type,
          filterString
        });
        
        // Add to appropriate filter list
        if (effect.type === 'audio') {
          result.audioFilters.push(filterString);
        } else if (effect.type === 'video') {
          result.videoFilters.push(filterString);
        } else if (effect.type === 'complex') {
          result.complexFilters.push(filterString);
        }
      }
    }
    return result;
  }
  
  // Process each filter
  for (const [name, value] of Object.entries(filters)) {
    try {
      // Resolve alias if it exists
      const resolvedName = resolveEffectName(name);
      
      // Check if effect exists in registry
      if (!effectRegistry[resolvedName]) {
        logFFmpegError(`Unknown effect: ${name}`, new Error(`Unknown effect: ${name}`));
        continue;
      }
      
      const effect = effectRegistry[resolvedName];
      
      // Validate effect value if validator exists
      if (effect.validate && !effect.validate(value)) {
        const err = new Error(`Invalid value for effect "${name}": ${value}`);
        logFFmpegError(`Effect validation error: ${name}=${value}`, err);
        throw err;
      }
      
      // Generate filter string
      const filterString = effect.apply(value);
      
      // Add to the appropriate filter category
      if (effect.type === 'audio') {
        result.audioFilters.push(filterString);
      } else if (effect.type === 'video') {
        result.videoFilters.push(filterString);
      } else if (effect.type === 'complex') {
        result.complexFilters.push(filterString);
      }
      
      // Add to effects list
      result.effects.push({
        name,
        value,
        resolvedName,
        effectType: effect.type,
        filterString
      });
      
      logFFmpegCommand(`Applied effect: ${name}${value !== undefined ? '=' + value : ''} -> ${filterString}`);
    } catch (error) {
      if (error instanceof Error) {
        logFFmpegError(`Error applying effect: ${name}`, error);
        throw error;
      }
    }
  }
  
  return result;
};

/**
 * Check if filters contain any video-only effects
 */
export const containsVideoEffects = (filters: Record<string, number | string>): boolean => {
  // Check for special raw complex filter case
  if (filters.__raw_complex_filter) {
    // Most complex filters require video, so assume true unless we can determine otherwise
    const rawFilterName = filters.__raw_complex_filter as string;
    if (effectExists(rawFilterName)) {
      const resolvedName = resolveEffectName(rawFilterName);
      const effect = effectRegistry[resolvedName];
      return effect ? effect.type === 'video' || effect.type === 'complex' : true;
    }
    return true;
  }
  
  // Check each filter
  return Object.keys(filters).some(name => {
    const resolvedName = resolveEffectName(name);
    const effect = effectRegistry[resolvedName];
    return effect && (effect.type === 'video' || effect.type === 'complex');
  });
};