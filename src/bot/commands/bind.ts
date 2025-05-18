import { Message, VoiceBasedChannel, GuildMember } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnection,
  getVoiceConnection
} from '@discordjs/voice';
import fs from 'fs';
import path from 'path';
import { 
  findMediaBySearch, 
  saveEmoteBinding, 
  getEmoteBinding,
  updateEmoteBindingAudioPath,
  updateEmoteBinding
} from '../../database/db';
import { processMedia, parseFilterString } from '../../media/processor';
import { safeReply } from '../utils/helpers';
import { isQuizActiveInGuild } from './quiz';

// Regular expressions for emoji detection
const CUSTOM_EMOJI_REGEX = /<a?:([^:]+):(\d+)>/;
const UNICODE_EMOJI_REGEX = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u;

/**
 * Handle the bind command to connect an emote with media
 */
export async function handleBindCommand(
  message: Message,
  searchTerm?: string,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
): Promise<void> {
  if (!message.guild) {
    await safeReply(message, 'This command can only be used in a server');
    return;
  }

  if (!searchTerm) {
    await safeReply(message, 'Usage: `NOW bind :emote: [search term]` - Binds an emote to media');
    return;
  }

  // Extract emote from the beginning of the search term
  const customEmoteMatch = searchTerm.match(CUSTOM_EMOJI_REGEX);
  const unicodeEmoteMatch = searchTerm.match(UNICODE_EMOJI_REGEX);
  
  let emoteId: string;
  let emoteName: string;
  let actualSearchTerm: string;
  
  if (customEmoteMatch) {
    // Custom Discord emote
    emoteName = customEmoteMatch[1];
    emoteId = customEmoteMatch[2];
    actualSearchTerm = searchTerm.replace(customEmoteMatch[0], '').trim();
  } else if (unicodeEmoteMatch) {
    // Unicode emoji
    emoteName = unicodeEmoteMatch[1];
    emoteId = unicodeEmoteMatch[1]; // Use the emoji itself as the ID for unicode emotes
    actualSearchTerm = searchTerm.replace(unicodeEmoteMatch[1], '').trim();
  } else {
    await safeReply(message, 'Please include an emote at the beginning of your command. Example: `NOW bind 👍 awesome`');
    return;
  }
  
  // Special case: when the search term starts with a filter in {...}
  // In this case, extract the filter, and use the rest as the search term
  if (actualSearchTerm.startsWith('{') && !filterString) {
    const filterEndIndex = actualSearchTerm.indexOf('}') + 1;
    if (filterEndIndex > 0) {
      filterString = actualSearchTerm.substring(0, filterEndIndex);
      actualSearchTerm = actualSearchTerm.substring(filterEndIndex).trim();
      
      // Make sure the filter string is properly formatted
      if (!filterString.startsWith('{') || !filterString.endsWith('}')) {
        filterString = `{${filterString.replace(/[{}]/g, '')}}`;
      }
    }
  }
  
  if (!actualSearchTerm) {
    await safeReply(message, 'Please provide a search term after the emote. Example: `NOW bind 👍 awesome`');
    return;
  }
  
  try {
    console.log(`Binding emote ${emoteName} to search term "${actualSearchTerm}" with filter: ${filterString || 'none'}`);
    
    // Find media matching search term
    const media = await findMediaBySearch(actualSearchTerm, false, 1);
    
    if (!media || media.length === 0) {
      await safeReply(message, `No media found matching "${actualSearchTerm}"`);
      return;
    }
    
    // Check if this emote is already bound
    const existingBinding = await getEmoteBinding(message.guild.id, emoteId);
    
    // Binding data to save/update
    const bindingData = {
      guildId: message.guild.id,
      userId: message.author.id,
      emoteId,
      emoteName,
      searchTerm: actualSearchTerm,
      filterString,
      clipDuration: clipOptions?.duration,
      clipStart: clipOptions?.start
    };
    
    // Validate filter format before saving
    if (bindingData.filterString && (!bindingData.filterString.startsWith('{') || !bindingData.filterString.endsWith('}'))) {
      bindingData.filterString = `{${bindingData.filterString.replace(/[{}]/g, '')}}`;
    }

    // If binding exists, update it instead of creating a new one
    if (existingBinding) {
      // Clear existing audio path to force regeneration with new filters
      await updateEmoteBinding(bindingData);
    } else {
      await saveEmoteBinding(bindingData);
    }
    
    // Create a friendly confirmation message
    const action = existingBinding ? 'updated' : 'bound';
    let confirmMessage = `Emote ${customEmoteMatch ? `<:${emoteName}:${emoteId}>` : emoteName} ${action} to "${media[0].title}"`;
    
    if (filterString) {
      confirmMessage += ` with filter ${filterString}`;
    }
    
    await safeReply(message, confirmMessage);
  } catch (error) {
    console.error('Error handling bind command:', error);
    await safeReply(message, 'There was an error processing your command. Please try again later.');
  }
}

/**
 * Play media bound to an emote
 */
export async function handleEmotePlayback(message: Message): Promise<void> {
  try {
    if (!message.guild) return;
    
    // Check if quiz is active in this guild
    if (await isQuizActiveInGuild(message.guild.id)) {
      return; // Don't trigger emotes during a quiz
    }
    
    // Extract emotes from the message content
    const customEmotes = message.content.match(new RegExp(CUSTOM_EMOJI_REGEX, 'g'));
    const unicodeEmotes = message.content.match(new RegExp(UNICODE_EMOJI_REGEX, 'g'));
    
    // Process custom Discord emotes
    if (customEmotes && customEmotes.length > 0) {
      for (const emote of customEmotes) {
        const match = emote.match(CUSTOM_EMOJI_REGEX);
        if (match && match[2]) {
          await playEmoteMedia(message, match[2]);
          return; // Only play the first matching emote
        }
      }
    }
    
    // Process Unicode emojis
    if (unicodeEmotes && unicodeEmotes.length > 0) {
      for (const emote of unicodeEmotes) {
        await playEmoteMedia(message, emote);
        return; // Only play the first matching emote
      }
    }
  } catch (error) {
    console.error('Error handling emote playback:', error);
  }
}

/**
 * Play media bound to an emote
 */
async function playEmoteMedia(message: Message, emoteId: string): Promise<void> {
  try {
    const binding = await getEmoteBinding(message.guild!.id, emoteId);
    if (!binding) return; // No binding found
    
    console.log(`Processing emote binding for ${binding.emoteName} with search term "${binding.searchTerm}"`);
    if (binding.filterString) {
      console.log(`Filter string detected: ${binding.filterString}`);
    }
    
    // Get user's voice channel
    const voiceChannel = (message.member as GuildMember)?.voice.channel as VoiceBasedChannel;
    if (!voiceChannel) return;
    
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    const NORMALIZED_DIR = path.join(process.cwd(), 'normalized');
    
    // Check if we already have a processed audio path for this binding
    let audioPath = binding.audioPath;
    
    // If no pre-processed audio, or the file doesn't exist, generate it
    if (!audioPath || !fs.existsSync(audioPath)) {
      console.log(`No cached audio found, generating new audio for emote ${binding.emoteName}`);
      
      // Find the media matching the search term
      const mediaResults = await findMediaBySearch(binding.searchTerm, false, 1);
      
      if (!mediaResults || mediaResults.length === 0) {
        console.error(`No media found matching "${binding.searchTerm}"`);
        return;
      }
      
      const media = mediaResults[0];
      
      if (!media.normalizedPath) {
        console.error(`No normalized path found for media matching "${binding.searchTerm}"`);
        return;
      }
      
      const mediaPath = path.join(NORMALIZED_DIR, path.basename(media.normalizedPath));
      
      if (!fs.existsSync(mediaPath)) {
        console.error(`Media file not found at ${mediaPath}`);
        return;
      }
      
      // Generate a unique filename for the processed audio
      const randomId = Math.floor(Math.random() * 1000000000).toString();
      const outputFilename = `emote_${binding.guildId}_${binding.emoteId.replace(/[^a-zA-Z0-9]/g, '')}_${randomId}.ogg`;
      const outputPath = path.join(TEMP_DIR, outputFilename);
      
      // Process the media with any filters or clip options
      const options: any = {
        enforceDiscordLimit: true
      };
      
      // Handle filter string parsing
      if (binding.filterString) {
        try {
          console.log(`Parsing filter string: ${binding.filterString}`);
          // Make sure filter string is properly formatted with braces
          const formattedFilterString = binding.filterString.startsWith('{') && binding.filterString.endsWith('}')
            ? binding.filterString
            : `{${binding.filterString.replace(/[{}]/g, '')}}`;
            
          options.filters = parseFilterString(formattedFilterString);
          console.log(`Parsed filters:`, options.filters);
        } catch (error) {
          console.error(`Error parsing filter string: ${error}`);
          // If filter parsing fails, try to create a simple filter object
          options.filters = { raw: binding.filterString.replace(/[{}]/g, '') };
        }
      }
      
      if (binding.clipDuration || binding.clipStart) {
        options.clip = {
          duration: binding.clipDuration,
          start: binding.clipStart
        };
        console.log(`Applying clip options:`, options.clip);
      }
      
      // Process the media
      try {
        console.log(`Processing media with options:`, options);
        audioPath = await processMedia(mediaPath, outputFilename, options);
        console.log(`Media processed successfully: ${audioPath}`);
        
        // Save the audio path to the binding for future use
        await updateEmoteBindingAudioPath(binding.guildId, binding.emoteId, audioPath);
        console.log(`Updated audio path in database`);
      } catch (error) {
        console.error(`Error processing media: ${error}`);
        return;
      }
    } else {
      console.log(`Using cached audio: ${audioPath}`);
    }
    
    // Check if the processed audio file exists
    if (!fs.existsSync(audioPath)) {
      console.error(`Processed audio file not found at ${audioPath}`);
      return;
    }
    
    // Play the audio in the voice channel
    console.log(`Playing audio in voice channel ${voiceChannel.name}`);
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild!.id,
      adapterCreator: message.guild!.voiceAdapterCreator as any,
    });
    
    const player = createAudioPlayer();
    const resource = createAudioResource(audioPath);
    
    connection.subscribe(player);
    player.play(resource);
    
    // Clean up when audio finishes playing
    player.on(AudioPlayerStatus.Idle, () => {
      try {
        connection.destroy();
      } catch (error) {
        console.error('Error destroying voice connection:', error);
      }
    });
    
  } catch (error) {
    console.error('Error playing emote media:', error);
  }
}