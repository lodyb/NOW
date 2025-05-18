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
  updateEmoteBindingAudioPath
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
    
    // Save the binding to the database
    await saveEmoteBinding({
      guildId: message.guild.id,
      userId: message.author.id,
      emoteId,
      emoteName,
      searchTerm: actualSearchTerm,
      filterString,
      clipDuration: clipOptions?.duration,
      clipStart: clipOptions?.start
    });
    
    // Create a friendly confirmation message
    let confirmMessage = `Emote ${customEmoteMatch ? `<:${emoteName}:${emoteId}>` : emoteName} bound to "${media[0].title}"`;
    
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
 * Handle emote detection in messages and play corresponding audio
 */
export async function handleEmotePlayback(message: Message): Promise<void> {
  if (!message.guild) return;
  
  // Don't process if a quiz is active in this guild
  if (isQuizActiveInGuild(message.guild.id)) {
    return;
  }
  
  // Don't process if not in a voice channel
  const member = message.guild.members.cache.get(message.author.id);
  if (!member?.voice?.channel) {
    return;
  }

  // Extract emotes from message
  const customEmotes = [...message.content.matchAll(new RegExp(CUSTOM_EMOJI_REGEX, 'g'))];
  const unicodeEmotes = [...message.content.matchAll(new RegExp(UNICODE_EMOJI_REGEX, 'g'))];
  
  // Process the first matching emote (priority: custom emotes, then unicode)
  let emoteId: string | undefined;
  
  if (customEmotes.length > 0) {
    emoteId = customEmotes[0][2]; // Extract ID from custom emote
  } else if (unicodeEmotes.length > 0) {
    emoteId = unicodeEmotes[0][1]; // Use the emoji itself for unicode
  }
  
  if (!emoteId) return; // No emotes found
  
  try {
    // Look up the emote binding
    const binding = await getEmoteBinding(message.guild.id, emoteId);
    if (!binding) return; // No binding for this emote
    
    // Process and play the audio
    await playEmoteAudio(message, member, binding);
  } catch (error) {
    console.error('Error playing emote audio:', error);
  }
}

/**
 * Process and play audio for an emote binding
 */
async function playEmoteAudio(
  message: Message, 
  member: GuildMember, 
  binding: any
): Promise<void> {
  try {
    // Check if we have a pre-processed audio file
    if (binding.audioPath && fs.existsSync(binding.audioPath)) {
      await playAudio(member.voice.channel!, binding.audioPath);
      return;
    }
    
    // If not, find the media and process it
    const media = await findMediaBySearch(binding.searchTerm, false, 1);
    
    if (!media || media.length === 0) {
      console.error(`No media found for emote binding: ${binding.emoteName}`);
      return;
    }
    
    // Process the media with filters if needed
    const filters = binding.filterString ? parseFilterString(binding.filterString) : {};
    const clipOptions = {
      duration: binding.clipDuration,
      start: binding.clipStart
    };
    
    // Get the file path from the media object
    const mediaPath = media[0].normalizedPath ? 
      path.join(process.cwd(), 'normalized', path.basename(media[0].normalizedPath)) : 
      path.join(process.cwd(), 'uploads', path.basename(media[0].filePath));

    // Generate a unique output filename
    const outputFilename = `emote_${binding.guildId}_${binding.emoteId}_${Date.now()}.${media[0].normalizedPath?.endsWith('.mp4') ? 'mp4' : 'ogg'}`;
    
    // Use the processMedia function with proper parameters
    const outputPath = await processMedia(mediaPath, outputFilename, { filters, clip: clipOptions });
    
    // Save the processed path for future use
    await updateEmoteBindingAudioPath(binding.guildId, binding.emoteId, outputPath);
    
    // Play the processed audio
    await playAudio(member.voice.channel!, outputPath);
  } catch (error) {
    console.error('Error processing emote audio:', error);
  }
}

/**
 * Play audio in a voice channel
 */
async function playAudio(voiceChannel: VoiceBasedChannel, filePath: string): Promise<void> {
  // Get or create a voice connection
  let connection = getVoiceConnection(voiceChannel.guild.id);
  
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator as any
    });
  }
  
  // Create an audio player and resource
  const player = createAudioPlayer();
  const resource = createAudioResource(filePath);
  
  // Play the audio
  player.play(resource);
  connection.subscribe(player);
  
  // Cleanup when done
  player.on(AudioPlayerStatus.Idle, () => {
    // We don't disconnect here to avoid rapid connect/disconnect
    // Voice timeouts will handle disconnects after inactivity
  });
  
  player.on('error', (error) => {
    console.error('Error playing audio:', error);
  });
}