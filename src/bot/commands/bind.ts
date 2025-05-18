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
  
  if (!actualSearchTerm) {
    await safeReply(message, 'Please provide a search term after the emote. Example: `NOW bind 👍 awesome`');
    return;
  }
  
  try {
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

    // If binding exists, update it instead of creating a new one
    if (existingBinding) {
      await updateEmoteBinding(bindingData);
    } else {
      await saveEmoteBinding(bindingData);
    }
    
    // Create a friendly confirmation message
    const action = existingBinding ? 'updated' : 'bound';
    let confirmMessage = `Emote ${customEmoteMatch ? `<:${emoteName}:${emoteId}>` : emoteName} ${action} to "${media[0].title}"`;
    
    if (filterString) {
      confirmMessage += ` with filters: ${filterString}`;
    }
    
    if (clipOptions?.duration || clipOptions?.start) {
      const clipDetails = [];
      if (clipOptions.duration) clipDetails.push(`duration: ${clipOptions.duration}`);
      if (clipOptions.start) clipDetails.push(`start: ${clipOptions.start}`);
      confirmMessage += ` (${clipDetails.join(', ')})`;
    }
    
    await safeReply(message, confirmMessage);
  } catch (error) {
    console.error('Error binding emote:', error);
    await safeReply(message, `Error binding emote: ${(error as Error).message}`);
  }
}

/**
 * Handle emote playback when a message contains bound emotes
 */
export async function handleEmotePlayback(message: Message): Promise<void> {
  if (!message.guild) return;
  
  // Skip if user is not in a voice channel
  const member = message.member as GuildMember;
  if (!member?.voice.channel) return;
  
  // Don't play emotes during an active quiz
  if (await isQuizActiveInGuild(message.guild.id)) return;
  
  // Extract all custom Discord emotes from the message
  const customEmotes = [...message.content.matchAll(new RegExp(CUSTOM_EMOJI_REGEX, 'g'))];
  
  // Extract all unicode emojis from the message
  const unicodeEmotes = [...message.content.matchAll(new RegExp(UNICODE_EMOJI_REGEX, 'g'))];
  
  // No emotes found
  if (customEmotes.length === 0 && unicodeEmotes.length === 0) return;
  
  // Process all found emotes
  const allEmotes = [
    ...customEmotes.map(match => ({ name: match[1], id: match[2] })),
    ...unicodeEmotes.map(match => ({ name: match[1], id: match[1] }))
  ];
  
  // Only process the first emote found to prevent spamming
  if (allEmotes.length > 0) {
    const emote = allEmotes[0];
    await playEmoteMedia(message, emote.id);
  }
}

/**
 * Play media bound to an emote
 */
async function playEmoteMedia(message: Message, emoteId: string): Promise<void> {
  try {
    const binding = await getEmoteBinding(message.guild!.id, emoteId);
    if (!binding) return; // No binding found
    
    // Get user's voice channel
    const voiceChannel = (message.member as GuildMember)?.voice.channel as VoiceBasedChannel;
    if (!voiceChannel) return;
    
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    const NORMALIZED_DIR = path.join(process.cwd(), 'normalized');
    
    // Check if we already have a processed audio path for this binding
    let audioPath = binding.audioPath;
    
    // If no pre-processed audio, or the file doesn't exist, generate it
    if (!audioPath || !fs.existsSync(audioPath)) {
      // Find the media matching the search term
      const mediaResults = await findMediaBySearch(binding.searchTerm, false, 1);
      
      if (!mediaResults || mediaResults.length === 0) return;
      
      const media = mediaResults[0];
      
      // Fix for TS2345: Add null check for normalizedPath
      if (!media.normalizedPath) return;
      
      const mediaPath = path.join(NORMALIZED_DIR, path.basename(media.normalizedPath));
      
      if (!fs.existsSync(mediaPath)) return;
      
      // Generate a unique filename for the processed audio
      const randomId = Math.floor(Math.random() * 1000000000).toString();
      const outputFilename = `emote_${binding.guildId}_${binding.emoteId.replace(/[^a-zA-Z0-9]/g, '')}_${randomId}.ogg`;
      const outputPath = path.join(TEMP_DIR, outputFilename);
      
      // Process the media with any filters or clip options
      const options: any = {
        enforceDiscordLimit: true
      };
      
      if (binding.filterString) {
        options.filters = parseFilterString(binding.filterString);
      }
      
      if (binding.clipDuration || binding.clipStart) {
        options.clip = {
          duration: binding.clipDuration,
          start: binding.clipStart
        };
      }
      
      // Process the media
      audioPath = await processMedia(mediaPath, outputFilename, options);
      
      // Save the audio path to the binding for future use
      await updateEmoteBindingAudioPath(binding.guildId, binding.emoteId, audioPath);
    }
    
    // Check if the processed audio file exists
    if (!fs.existsSync(audioPath)) return;
    
    // Play the audio in the voice channel
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild!.id,
      // Fix for TS2322: Cast the adapter creator to the expected type
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