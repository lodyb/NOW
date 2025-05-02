import { Message } from 'discord.js';

export interface CommandArgs {
  command: string;
  searchTerm?: string;
  filterString?: string;
  clipOptions?: {
    duration?: string;
    start?: string;
  };
}

export const parseCommand = (message: Message): CommandArgs | null => {
  // Check if message starts with NOW prefix
  if (!message.content.startsWith('NOW ')) {
    return null;
  }

  const parts = message.content.substring(4).trim().split(' ');
  const command = parts[0].toLowerCase();
  
  // Handle basic commands without search term
  if (['upload', 'quiz', 'stop'].includes(command)) {
    return { command };
  }
  
  // Handle play or image command
  if (command === 'play' || command === 'image') {
    let args: CommandArgs = { command };
    let filterStringIndex = -1;
    
    // Find filter string in curly braces
    parts.slice(1).forEach((part, index) => {
      if (part.startsWith('{') && part.endsWith('}')) {
        args.filterString = part;
        filterStringIndex = index + 1;
      }
    });
    
    // Extract search term excluding filter string
    const searchTermParts = parts.slice(1).filter((_, i) => i + 1 !== filterStringIndex);
    if (searchTermParts.length > 0) {
      args.searchTerm = searchTermParts.join(' ');
    }
    
    return args;
  }
  
  // Handle clip command or quiz with options
  if (parts.some(p => p.startsWith('clip=')) || parts.some(p => p.startsWith('start='))) {
    const clipOptions: { duration?: string; start?: string } = {};
    const otherParts: string[] = [];
    
    parts.forEach(part => {
      if (part.startsWith('clip=')) {
        clipOptions.duration = part.substring(5);
      } else if (part.startsWith('start=')) {
        clipOptions.start = part.substring(6);
      } else if (part.startsWith('{') && part.endsWith('}')) {
        otherParts.push(part);
      } else {
        otherParts.push(part);
      }
    });
    
    const args: CommandArgs = {
      command: otherParts[0].toLowerCase(),
      clipOptions
    };
    
    // Extract filter string if it exists
    const filterString = otherParts.find(p => p.startsWith('{') && p.endsWith('}'));
    if (filterString) {
      args.filterString = filterString;
      otherParts.splice(otherParts.indexOf(filterString), 1);
    }
    
    // Extract search term if applicable
    if (otherParts.length > 1) {
      args.searchTerm = otherParts.slice(1).join(' ');
    }
    
    return args;
  }
  
  // Default case - treat as play command with search term
  return {
    command: 'play',
    searchTerm: message.content.substring(4).trim()
  };
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
export const safeReply = async (message: Message, content: string | { files: any[] }): Promise<boolean> => {
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