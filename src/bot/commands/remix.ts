import { Message } from 'discord.js';
import { processMediaCommand } from './mediaCommand';
import { handleJumbleRemix } from './playback/JumbleHandler';

/**
 * Handle the remix command that processes media from message attachments or embeds
 */
export const handleRemixCommand = async (
  message: Message,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
) => {
  try {
    // Check for jumble filter
    if (filterString?.toLowerCase().includes('jumble')) {
      await handleJumbleRemix(message, filterString.replace(/(jumble|{|})/gi, ''), clipOptions);
      return;
    }

    // Use the unified media command handler for remix functionality
    await processMediaCommand(message, {
      filterString,
      clipOptions,
      fromReply: true
    });
  } catch (error) {
    console.error('Error in handleRemixCommand:', error);
    throw error;
  }
};