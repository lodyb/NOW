import { Message } from 'discord.js';
import { processMediaCommand } from './mediaCommand';
import { handleJumblePlayback } from './playback/JumbleHandler';
import { handleDjPlayback } from './playback/DjHandler';
import { safeReply } from '../utils/helpers';

export const handlePlayCommand = async (
  message: Message,
  searchTerm?: string,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string },
  multi?: number
) => {
  try {
    // Check for jumble filter
    if (filterString?.toLowerCase().includes('jumble')) {
      await handleJumblePlayback(message, searchTerm, filterString.replace(/(jumble|{|})/gi, ''), clipOptions);
      return;
    }

    // Check for DJ filter
    if (filterString?.toLowerCase().includes('dj')) {
      await handleDjPlayback(message, clipOptions);
      return;
    }

    // Handle multi parameter for multiple random files
    if (multi && multi > 1) {
      for (let i = 0; i < Math.min(multi, 5); i++) { // Cap at 5 to prevent spam
        await processMediaCommand(message, {
          searchTerm: undefined, // Force random selection
          filterString,
          clipOptions,
          fromReply: false
        });
      }
    } else {
      await processMediaCommand(message, {
        searchTerm,
        filterString,
        clipOptions,
        fromReply: false
      });
    }
  } catch (error) {
    console.error('Error handling play command:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
};