import { Message } from 'discord.js';
import { safeReply } from '../utils/helpers';
import { getLatestJumbleInfo, getLatestDjInfo, JumbleInfo, DjInfo } from '../../database/db';

/**
 * Handle the "what was that" command to show jumble and DJ sources
 */
export const handleWhatWasThatCommand = async (message: Message) => {
  try {
    const userId = message.author.id;
    const guildId = message.guildId || '';
    
    // Get the latest jumble and DJ info for this user in this guild
    const [jumbleInfo, djInfo] = await Promise.all([
      getLatestJumbleInfo(userId, guildId),
      getLatestDjInfo(userId, guildId)
    ]);
    
    if (!jumbleInfo && !djInfo) {
      await safeReply(message, "You haven't used jumble or DJ mode yet. Try using `NOW play {jumble}` or `NOW play {dj}` first!");
      return;
    }
    
    // Format timestamps nicely
    const formatTimestamp = (seconds: number): string => {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    // Determine which info to show (most recent)
    let showJumble = false;
    let showDj = false;
    
    if (jumbleInfo && djInfo) {
      // Show whichever is more recent
      if (jumbleInfo.timestamp > djInfo.timestamp) {
        showJumble = true;
      } else {
        showDj = true;
      }
    } else if (jumbleInfo) {
      showJumble = true;
    } else if (djInfo) {
      showDj = true;
    }
    
    let responseMessage = '';
    
    if (showJumble && jumbleInfo) {
      responseMessage = [
        "**Last jumble sources:**",
        "",
        `**Video**: ${jumbleInfo.videoTitle}`,
        `Clip: ${formatTimestamp(jumbleInfo.videoStart)} to ${formatTimestamp(jumbleInfo.videoStart + jumbleInfo.videoDuration)}`,
        "",
        `**Audio**: ${jumbleInfo.audioTitle}`,
        `Clip: ${formatTimestamp(jumbleInfo.audioStart)} to ${formatTimestamp(jumbleInfo.audioStart + jumbleInfo.audioDuration)}`
      ].join("\n");
    } else if (showDj && djInfo) {
      responseMessage = [
        "**Last DJ mix:**",
        "",
        `**Video**: ${djInfo.videoTitle}`,
        `Clip: ${formatTimestamp(djInfo.videoStart)} to ${formatTimestamp(djInfo.videoStart + djInfo.videoDuration)}`,
        "",
        `**Audio**: ${djInfo.audioTitle}`,
        `Clip: ${formatTimestamp(djInfo.audioStart)} to ${formatTimestamp(djInfo.audioStart + djInfo.audioDuration)}`
      ].join("\n");
      
      if (djInfo.appliedFilters && djInfo.appliedFilters.length > 0) {
        responseMessage += `\n\n**Filters applied**: ${djInfo.appliedFilters.join(', ')}`;
      }
    }
    
    await safeReply(message, responseMessage);
  } catch (error) {
    console.error('Error handling what was that command:', error);
    await safeReply(message, `Error retrieving mix info: ${(error as Error).message}`);
  }
};