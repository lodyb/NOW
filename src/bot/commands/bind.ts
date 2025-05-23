import { Message, VoiceBasedChannel, GuildMember } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource,
  AudioPlayerStatus
} from '@discordjs/voice';
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
import { MediaService, FileService } from '../services';

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

  const { emoteId, emoteName, actualSearchTerm, filterString: extractedFilter } = parseEmoteFromSearchTerm(searchTerm, filterString);
  
  if (!emoteId || !actualSearchTerm) {
    await safeReply(message, 'Please include an emote at the beginning of your command. Example: `NOW bind 👍 awesome`');
    return;
  }
  
  try {
    const media = await MediaService.findMedia(actualSearchTerm, false, 1);
    
    if (media.length === 0) {
      await safeReply(message, `No media found matching "${actualSearchTerm}"`);
      return;
    }
    
    const existingBinding = await getEmoteBinding(message.guild.id, emoteId);
    const bindingData = {
      guildId: message.guild.id,
      userId: message.author.id,
      emoteId,
      emoteName,
      searchTerm: actualSearchTerm,
      filterString: normalizeFilterString(extractedFilter),
      clipDuration: clipOptions?.duration,
      clipStart: clipOptions?.start
    };

    if (existingBinding) {
      await updateEmoteBinding(bindingData);
    } else {
      await saveEmoteBinding(bindingData);
    }
    
    const action = existingBinding ? 'updated' : 'bound';
    const customEmoteMatch = emoteName !== emoteId;
    let confirmMessage = `Emote ${customEmoteMatch ? `<:${emoteName}:${emoteId}>` : emoteName} ${action} to "${media[0].title}"`;
    
    if (extractedFilter) {
      confirmMessage += ` with filter ${extractedFilter}`;
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
  if (!message.guild || await isQuizActiveInGuild(message.guild.id)) return;
  
  try {
    const customEmotes = message.content.match(new RegExp(CUSTOM_EMOJI_REGEX, 'g'));
    const unicodeEmotes = message.content.match(new RegExp(UNICODE_EMOJI_REGEX, 'g'));
    
    if (customEmotes?.length) {
      const match = customEmotes[0].match(CUSTOM_EMOJI_REGEX);
      if (match?.[2]) {
        await playEmoteMedia(message, match[2]);
        return;
      }
    }
    
    if (unicodeEmotes?.length) {
      await playEmoteMedia(message, unicodeEmotes[0]);
    }
  } catch (error) {
    console.error('Error handling emote playback:', error);
  }
}

/**
 * Play media bound to an emote
 */
async function playEmoteMedia(message: Message, emoteId: string): Promise<void> {
  const binding = await getEmoteBinding(message.guild!.id, emoteId);
  if (!binding) return;
  
  const voiceChannel = (message.member as GuildMember)?.voice.channel as VoiceBasedChannel;
  if (!voiceChannel) return;
  
  try {
    const audioPath = await getOrCreateEmoteAudio(binding);
    if (!audioPath || !MediaService.validateMediaExists(audioPath)) return;
    
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild!.id,
      adapterCreator: message.guild!.voiceAdapterCreator as any,
    });
    
    const player = createAudioPlayer();
    const resource = createAudioResource(audioPath);
    
    connection.subscribe(player);
    player.play(resource);
    
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

async function getOrCreateEmoteAudio(binding: any): Promise<string | null> {
  if (binding.audioPath && MediaService.validateMediaExists(binding.audioPath)) {
    return binding.audioPath;
  }
  
  const mediaResults = await MediaService.findMedia(binding.searchTerm, false, 1);
  if (mediaResults.length === 0) return null;
  
  const mediaPath = MediaService.resolveMediaPath(mediaResults[0]);
  if (!MediaService.validateMediaExists(mediaPath)) return null;
  
  const outputFilename = `emote_${binding.guildId}_${binding.emoteId.replace(/[^a-zA-Z0-9]/g, '')}_${FileService.generateRandomId()}.ogg`;
  const outputPath = `${MediaService.getTempDir()}/${outputFilename}`;
  
  const options: any = { enforceDiscordLimit: true };
  
  // Apply ffmpeg filters if provided
  if (binding.filterString) {
    try {
      const formattedFilterString = binding.filterString.replace(/[{}]/g, '');
      options.filters = parseFilterString(formattedFilterString);
    } catch (error) {
      console.error('Error parsing filter string:', error);
      options.filters = { raw: binding.filterString.replace(/[{}]/g, '') };
    }
  }
  
  if (binding.clipDuration || binding.clipStart) {
    options.clip = {
      duration: binding.clipDuration,
      start: binding.clipStart
    };
  }
  
  try {
    const audioPath = await processMedia(mediaPath, outputFilename, options);
    await updateEmoteBindingAudioPath(binding.guildId, binding.emoteId, audioPath);
    return audioPath;
  } catch (error) {
    console.error('Error processing media:', error);
    return null;
  }
}

function parseEmoteFromSearchTerm(searchTerm: string, filterString?: string) {
  const customEmoteMatch = searchTerm.match(CUSTOM_EMOJI_REGEX);
  const unicodeEmoteMatch = searchTerm.match(UNICODE_EMOJI_REGEX);
  
  let emoteId: string = '';
  let emoteName: string = '';
  let actualSearchTerm: string = '';
  let extractedFilter = filterString;
  
  if (customEmoteMatch) {
    emoteName = customEmoteMatch[1];
    emoteId = customEmoteMatch[2];
    actualSearchTerm = searchTerm.replace(customEmoteMatch[0], '').trim();
  } else if (unicodeEmoteMatch) {
    emoteName = unicodeEmoteMatch[1];
    emoteId = unicodeEmoteMatch[1];
    actualSearchTerm = searchTerm.replace(unicodeEmoteMatch[1], '').trim();
  }
  
  if (actualSearchTerm.startsWith('{') && !filterString) {
    const filterEndIndex = actualSearchTerm.indexOf('}') + 1;
    if (filterEndIndex > 0) {
      extractedFilter = actualSearchTerm.substring(0, filterEndIndex);
      actualSearchTerm = actualSearchTerm.substring(filterEndIndex).trim();
    }
  }
  
  return { emoteId, emoteName, actualSearchTerm, filterString: extractedFilter };
}

function normalizeFilterString(filterString?: string): string | undefined {
  if (!filterString) return undefined;
  
  if (filterString.startsWith('{') && filterString.endsWith('}')) {
    return filterString;
  }
  
  return `{${filterString.replace(/[{}]/g, '')}}`;
}