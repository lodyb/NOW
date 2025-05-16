import { Message, MessagePayload, MessageCreateOptions } from 'discord.js';

export interface CommandArgs {
  command: string;
  searchTerm?: string;
  filterString?: string;
  clipOptions?: {
    duration?: string;
    start?: string;
  };
  multi?: number;
}

export const parseCommand = (message: Message): CommandArgs | null => {
  // Check if message starts with NOW prefix
  if (!message.content.startsWith('NOW ')) {
    return null;
  }

  // Special handling for complex filter strings
  let content = message.content.substring(4).trim();

  // Special handling for multi-word commands like "what was that"
  if (content.startsWith('what was that')) {
    return {
      command: 'what was that'
    };
  }
  
  // Special handling for "!!" command to repeat last command
  if (content === '!!') {
    return { 
      command: 'repeat',
    };
  }
  
  let filterString: string | undefined;
  
  // Extract filter string between { and } considering nested braces
  const filterMatch = content.match(/{([^{}]*(\{[^{}]*\}[^{}]*)*)}/);
  if (filterMatch) {
    filterString = filterMatch[0];
    // Remove the filter string from content
    content = content.replace(filterString, '').trim();
  }
  
  // Extract multi parameter from filter string
  let multi: number | undefined;
  if (filterString) {
    const multiMatch = filterString.match(/multi=(\d+)/);
    if (multiMatch && multiMatch[1]) {
      multi = parseInt(multiMatch[1], 10);
      // Remove multi parameter from filter string if it's the only parameter
      if (filterString === `{multi=${multi}}`) {
        filterString = undefined;
      }
    }
  }
  
  const parts = content.split(' ').filter(p => p.trim() !== '');
  if (parts.length === 0) {
    // Default to play command if only filter specified
    parts.push('play');
  }
  
  const command = parts[0].toLowerCase();
  
  // Handle basic commands without search term
  if (['upload', 'quiz', 'stop', 'help'].includes(command) && parts.length === 1) {
    const result: CommandArgs = { command };
    if (filterString) {
      result.filterString = filterString;
    }
    if (multi !== undefined) {
      result.multi = multi;
    }
    return result;
  }
  
  // Handle clip options
  const clipOptions: { duration?: string; start?: string } = {};
  const searchTermParts: string[] = [];
  
  parts.forEach(part => {
    if (part.startsWith('clip=')) {
      clipOptions.duration = part.substring(5);
    } else if (part.startsWith('start=')) {
      clipOptions.start = part.substring(6);
    } else {
      searchTermParts.push(part);
    }
  });
  
  const result: CommandArgs = {
    command: searchTermParts[0].toLowerCase()
  };
  
  // Add filter string if exists
  if (filterString) {
    result.filterString = filterString;
  }
  
  // Add clip options if any
  if (Object.keys(clipOptions).length > 0) {
    result.clipOptions = clipOptions;
  }
  
  // Add search term if exists
  if (searchTermParts.length > 1) {
    result.searchTerm = searchTermParts.slice(1).join(' ');
  }
  
  // Add multi if exists
  if (multi !== undefined) {
    result.multi = multi;
  }
  
  return result;
};

export const generateRandomUnicodeMask = (text: string): string => {
  return text
    .split(' ')
    .map(word => 
      Array.from(word)
        .map(() => String.fromCodePoint(0x2000 + Math.floor(Math.random() * 1000)))
        .join('')
    )
    .join(' ');
};

export const generateProgressiveHint = (
  answer: string, 
  revealPercentage: number
): string => {
  const words = answer.split(' ');
  
  return words
    .map(word => {
      const charsToReveal = Math.ceil(word.length * (revealPercentage / 100));
      const revealed = word.substring(0, charsToReveal);
      const masked = Array.from(word.substring(charsToReveal))
        .map(() => String.fromCodePoint(0x2000 + Math.floor(Math.random() * 1000)))
        .join('');
      
      return revealed + masked;
    })
    .join(' ');
};

/**
 * Safely send a reply to a message, handling permission errors gracefully
 * @param message The Discord message to reply to
 * @param content The content to send in the reply
 * @returns True if successful, false if failed
 */
export const safeReply = async (message: Message, content: string | MessagePayload | MessageCreateOptions): Promise<boolean> => {
  try {
    await message.reply(content);
    return true;
  } catch (error) {
    const discordError = error as { code?: number };
    if (discordError.code === 50013) { // Discord Missing Permissions error
      console.warn(`Missing permissions to reply in ${message.channel.id}`);
    } else {
      console.error('Error sending reply:', error);
    }
    return false;
  }
};