import { Message } from 'discord.js';
import { safeReply } from '../utils/helpers';
import { getLatestJumbleInfo, JumbleInfo } from '../../database/db';

/**
 * Handle the "what was that" command to show jumble sources
 */
export const handleWhatWasThatCommand = async (message: Message) => {
  try {
    const userId = message.author.id;
    const guildId = message.guildId || '';
    
    // Get the latest jumble info for this user in this guild
    const jumbleInfo = await getLatestJumbleInfo(userId, guildId);
    
    if (!jumbleInfo) {
      await safeReply(message, "You haven't used the jumble command yet. Try using `NOW play {jumble}` first!");
      return;
    }
    
    // Format timestamps nicely
    const formatTimestamp = (seconds: number): string => {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    // Create a nice formatted message
    const responseMessage = [
      "**Last jumble sources:**",
      "",
      `**Video**: ${jumbleInfo.videoTitle}`,
      `Clip: ${formatTimestamp(jumbleInfo.videoStart)} to ${formatTimestamp(jumbleInfo.videoStart + jumbleInfo.videoDuration)}`,
      "",
      `**Audio**: ${jumbleInfo.audioTitle}`,
      `Clip: ${formatTimestamp(jumbleInfo.audioStart)} to ${formatTimestamp(jumbleInfo.audioStart + jumbleInfo.audioDuration)}`
    ].join("\n");
    
    await safeReply(message, responseMessage);
  } catch (error) {
    console.error('Error handling what was that command:', error);
    await safeReply(message, `Error retrieving jumble info: ${(error as Error).message}`);
  }
};