import { parseFilterString } from './filterParser';
import { parseClipOptions, ClipOptions } from './filterProcessor';
import { MediaFilter } from './processor';

export interface CommandProcessResult {
  searchTerm: string;
  filters: MediaFilter;
  clip: ClipOptions;
}

/**
 * Process command arguments to extract search term, filters, and clip options
 * Handles formats like:
 * - NOW play star wars
 * - NOW play imperial march {amplify=2,reverse=1}
 * - NOW clip=4s start=3s imperial march
 * - NOW clip=4s start=3s imperial march {reverse=1}
 */
export const processCommandArgs = (args: string[]): CommandProcessResult => {
  const result: CommandProcessResult = {
    searchTerm: '',
    filters: {},
    clip: {}
  };
  
  if (!args.length) return result;
  
  // Extract clip options
  result.clip = parseClipOptions(args);
  
  // Remove clip options from args
  const filteredArgs = args.filter(
    arg => !arg.startsWith('clip=') && !arg.startsWith('start=')
  );
  
  // Check if the last argument is a filter block
  const lastArg = filteredArgs[filteredArgs.length - 1];
  if (lastArg && lastArg.startsWith('{') && lastArg.endsWith('}')) {
    // Remove the filter block from args
    const filterBlock = filteredArgs.pop() || '';
    
    // Parse the filter block
    try {
      result.filters = parseFilterString(filterBlock);
    } catch (error) {
      console.error(`Error parsing filter block: ${error}`);
    }
  }
  
  // Join remaining args as search term
  result.searchTerm = filteredArgs.join(' ').trim();
  
  return result;
};