import { Message } from 'discord.js';
import { processMediaCommand } from './mediaCommand';
import { handleJumblePlayback, handleMultiMediaPlayback } from './playback';
import { safeReply } from '../utils/helpers';

export const handlePlayCommand = async (
  message: Message, 
  searchTerm?: string, 
  filterString?: string, 
  clipOptions?: { duration?: string; start?: string },
  multi?: number
) => {
  try {
    if (filterString?.toLowerCase().includes('jumble')) {
      await handleJumblePlayback(message, searchTerm, filterString.replace(/(jumble|{|})/gi, ''), clipOptions);
      return;
    }

    if (multi && multi > 1) {
      await handleMultiMediaPlayback(message, searchTerm, multi, filterString, clipOptions);
      return;
    }

    await processMediaCommand(message, {
      searchTerm,
      filterString,
      clipOptions,
      fromReply: false
    });
  } catch (error) {
    console.error('Error handling play command:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
};