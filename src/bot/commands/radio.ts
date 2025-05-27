import { Message, VoiceBasedChannel } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus,
  VoiceConnection,
  DiscordGatewayAdapterCreator
} from '@discordjs/voice';
import { getRandomMedia } from '../../database/db';
import { MediaService } from '../services/MediaService';
import { logger } from '../../utils/logger';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

interface RadioSession {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  queue: any[];
  currentMedia: any;
  nextMedia: any;
  isActive: boolean;
  audioPlayer: any;
  currentFilters: string[];
  nextFilters: string[];
  isProcessingNext: boolean;
  effectQueue: EffectRender[];
}

interface EffectRender {
  type: 'rewind' | 'filter_transition' | 'crossfade';
  filePath: string;
  duration: number;
  onComplete?: () => void;
}

const activeSessions = new Map<string, RadioSession>();
const TEMP_EFFECTS_DIR = path.join(process.cwd(), 'temp', 'radio_effects');

// Ensure effects directory exists
if (!fs.existsSync(TEMP_EFFECTS_DIR)) {
  fs.mkdirSync(TEMP_EFFECTS_DIR, { recursive: true });
}

export const handleRadioCommand = async (message: Message) => {
  if (!message.guild) {
    await message.reply('This command can only be used in a server');
    return;
  }
  
  const member = message.guild.members.cache.get(message.author.id);
  if (!member?.voice.channel) {
    await message.reply('You need to join a voice channel first!');
    return;
  }
  
  const voiceChannel = member.voice.channel;
  
  if (activeSessions.has(message.guild.id)) {
    await message.reply('Radio is already running in this server. Type `NOW stop` to end it.');
    return;
  }
  
  try {
    await startRadioSession(message, voiceChannel);
  } catch (error) {
    logger.error('Error starting radio', error);
    await message.reply(`Failed to start radio: ${(error as Error).message}`);
  }
};

export const handleRewindCommand = async (message: Message) => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    await message.reply('No radio session active');
    return;
  }

  const session = activeSessions.get(message.guild.id)!;
  if (!session.currentMedia) {
    await message.reply('Nothing currently playing');
    return;
  }

  await message.reply('⏪ Rewinding...');
  await queueRewindEffect(session);
};

export const handleFilterCommand = async (message: Message, filterString: string) => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    await message.reply('No radio session active');
    return;
  }

  const session = activeSessions.get(message.guild.id)!;
  const filters = parseFilters(filterString);
  
  session.nextFilters = filters;
  await message.reply(`🎛️ Filter "${filterString}" will apply to next track`);
  
  // Pre-render next track with filters
  if (!session.isProcessingNext) {
    prepareNextTrack(session);
  }
};

export const handleSkipCommand = async (message: Message) => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    await message.reply('No radio session active');
    return;
  }

  const session = activeSessions.get(message.guild.id)!;
  await message.reply('⏭️ Skipping...');
  
  // Force next track immediately
  session.audioPlayer.stop();
};

export const handleQueueCommand = async (message: Message, searchTerm?: string) => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    await message.reply('No radio session active. Start one with `NOW radio`');
    return;
  }
  
  const session = activeSessions.get(message.guild.id)!;
  
  // Show current queue if no search term
  if (!searchTerm) {
    if (session.queue.length === 0) {
      await message.reply('📻 Queue is empty - playing random tracks');
      return;
    }
    
    const queueList = session.queue
      .slice(0, 10) // Show first 10 items
      .map((media, index) => {
        const title = media.answers?.[0] || media.title;
        return `${index + 1}. ${title}`;
      })
      .join('\n');
    
    const remaining = session.queue.length > 10 ? `\n... and ${session.queue.length - 10} more` : '';
    await message.reply(`📻 **Queue (${session.queue.length} tracks):**\n\`\`\`\n${queueList}${remaining}\n\`\`\``);
    return;
  }
  
  // Add to queue if search term provided
  try {
    const mediaItems = await MediaService.findMedia(searchTerm, false, 1);
    
    if (mediaItems.length === 0) {
      await message.reply(`No media found for "${searchTerm}"`);
      return;
    }
    
    const media = mediaItems[0];
    session.queue.push(media);
    
    const primaryAnswer = media.answers && media.answers.length > 0 
      ? media.answers[0] 
      : media.title;
    
    await message.reply(`🎵 Added "${primaryAnswer}" to queue (position ${session.queue.length})`);
  } catch (error) {
    logger.error('Error queuing media', error);
    await message.reply('Failed to queue media');
  }
};

export const handlePlayingCommand = async (message: Message) => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    await message.reply('No radio session active. Start one with `NOW radio`');
    return;
  }
  
  const session = activeSessions.get(message.guild.id)!;
  
  if (!session.currentMedia) {
    await message.reply('📻 Nothing currently playing');
    return;
  }
  
  const primaryAnswer = session.currentMedia.answers?.[0] || session.currentMedia.title;
  await message.reply(`🎵 Now playing: **${primaryAnswer}**`);
};

export const handleRadioStop = async (message: Message) => {
  if (!message.guild) return;
  
  const session = activeSessions.get(message.guild.id);
  if (!session) {
    await message.reply('No radio session active');
    return;
  }
  
  await message.reply('Radio stopped');
  endRadioSession(session);
};

const startRadioSession = async (message: Message, voiceChannel: VoiceBasedChannel) => {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
  });
  
  const audioPlayer = createAudioPlayer();
  
  const session: RadioSession = {
    guildId: voiceChannel.guild.id,
    channelId: message.channelId,
    connection,
    queue: [],
    currentMedia: null,
    nextMedia: null,
    isActive: true,
    audioPlayer,
    currentFilters: [],
    nextFilters: [],
    isProcessingNext: false,
    effectQueue: []
  };
  
  activeSessions.set(voiceChannel.guild.id, session);
  connection.subscribe(audioPlayer);
  
  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === 'disconnected') {
      endRadioSession(session);
    }
  });
  
  audioPlayer.on(AudioPlayerStatus.Idle, () => {
    if (session.isActive) {
      handleTrackEnd(session, message.channel);
    }
  });
  
  await message.reply(`🎵 Radio started in ${voiceChannel.name}!`);
  playNext(session, message.channel);
};

const handleTrackEnd = async (session: RadioSession, channel: any) => {
  // Check if we have effects queued
  if (session.effectQueue.length > 0) {
    const effect = session.effectQueue.shift()!;
    await playEffect(session, effect);
    return;
  }
  
  // Normal track progression
  playNext(session, channel);
};

const playNext = async (session: RadioSession, channel: any) => {
  try {
    let nextMedia = session.nextMedia;
    
    if (!nextMedia) {
      if (session.queue.length > 0) {
        nextMedia = session.queue.shift();
      } else {
        const randomMedia = await getRandomMedia(1);
        if (randomMedia.length === 0) {
          await channel.send('No media available');
          return;
        }
        nextMedia = randomMedia[0];
      }
    }
    
    session.currentMedia = nextMedia;
    session.currentFilters = session.nextFilters.slice();
    session.nextMedia = null;
    session.nextFilters = [];
    
    let filePath: string;
    
    if (session.currentFilters.length > 0) {
      // Use pre-rendered filtered version
      filePath = await getOrCreateFilteredVersion(nextMedia, session.currentFilters);
    } else {
      filePath = MediaService.resolveMediaPath(nextMedia);
      if (!MediaService.validateMediaExists(filePath) && nextMedia.filePath) {
        filePath = nextMedia.filePath;
      }
    }
    
    if (!fs.existsSync(filePath)) {
      playNext(session, channel);
      return;
    }
    
    const resource = createAudioResource(filePath);
    session.audioPlayer.play(resource);
    
    // Start preparing next track in background
    prepareNextTrack(session);
    
  } catch (error) {
    logger.error('Error playing next track', error);
    setTimeout(() => playNext(session, channel), 3000);
  }
};

const prepareNextTrack = async (session: RadioSession) => {
  if (session.isProcessingNext) return;
  
  session.isProcessingNext = true;
  
  try {
    let nextMedia;
    
    if (session.queue.length > 0) {
      nextMedia = session.queue[0]; // Don't shift yet
    } else {
      const randomMedia = await getRandomMedia(1);
      if (randomMedia.length === 0) return;
      nextMedia = randomMedia[0];
    }
    
    session.nextMedia = nextMedia;
    
    // Pre-render with filters if needed
    if (session.nextFilters.length > 0) {
      await getOrCreateFilteredVersion(nextMedia, session.nextFilters);
    }
  } catch (error) {
    logger.error('Error preparing next track', error);
  } finally {
    session.isProcessingNext = false;
  }
};

const queueRewindEffect = async (session: RadioSession) => {
  const rewindPath = await createRewindEffect(session.currentMedia);
  
  const rewindEffect: EffectRender = {
    type: 'rewind',
    filePath: rewindPath,
    duration: 2000, // 2 seconds
    onComplete: () => {
      // Restart current track from beginning
      session.nextMedia = session.currentMedia;
      session.nextFilters = session.currentFilters.slice();
    }
  };
  
  session.effectQueue.push(rewindEffect);
  
  // If nothing playing, start effect immediately
  if (session.audioPlayer.state.status === AudioPlayerStatus.Idle) {
    const effect = session.effectQueue.shift()!;
    await playEffect(session, effect);
  }
};

const createRewindEffect = async (media: any): Promise<string> => {
  const outputPath = path.join(TEMP_EFFECTS_DIR, `rewind_${Date.now()}.ogg`);
  const inputPath = MediaService.resolveMediaPath(media);
  
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      '-af', 'areverse,atempo=8,aecho=0.5:0.5:500:0.3,afade=t=out:st=1.5:d=0.5',
      '-t', '2',
      '-f', 'ogg',
      '-y',
      outputPath
    ]);
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`Rewind effect creation failed with code ${code}`));
      }
    });
    
    ffmpeg.on('error', reject);
  });
};

const playEffect = async (session: RadioSession, effect: EffectRender) => {
  const resource = createAudioResource(effect.filePath);
  session.audioPlayer.play(resource);
  
  // Clean up effect file after playing
  setTimeout(() => {
    fs.unlink(effect.filePath, () => {});
  }, effect.duration + 1000);
  
  if (effect.onComplete) {
    effect.onComplete();
  }
};

const getOrCreateFilteredVersion = async (media: any, filters: string[]): Promise<string> => {
  const filterHash = filters.join('_').replace(/[^a-zA-Z0-9]/g, '_');
  const outputPath = path.join(TEMP_EFFECTS_DIR, `filtered_${media.id}_${filterHash}.ogg`);
  
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }
  
  const inputPath = MediaService.resolveMediaPath(media);
  const filterArgs = buildFilterArgs(filters);
  
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      ...filterArgs,
      '-f', 'ogg',
      '-y',
      outputPath
    ]);
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`Filter processing failed with code ${code}`));
      }
    });
    
    ffmpeg.on('error', reject);
  });
};

const parseFilters = (filterString: string): string[] => {
  return filterString.replace(/[{}]/g, '').split(',').map(f => f.trim());
};

const buildFilterArgs = (filters: string[]): string[] => {
  // Convert filter strings to FFmpeg arguments
  const args: string[] = [];
  
  for (const filter of filters) {
    if (filter.includes('=')) {
      const [key, value] = filter.split('=');
      args.push('-af', `${key}=${value}`);
    } else {
      // Predefined effects
      switch (filter) {
        case 'reverse':
          args.push('-af', 'areverse');
          break;
        case 'echo':
          args.push('-af', 'aecho=0.6:0.3:1000:0.5');
          break;
        case 'chipmunk':
          args.push('-af', 'asetrate=44100*1.5,aresample=44100');
          break;
        // Add more predefined effects as needed
      }
    }
  }
  
  return args;
};

const endRadioSession = (session: RadioSession) => {
  session.isActive = false;
  session.queue = [];
  
  try {
    session.connection.destroy();
  } catch (error) {
    logger.error('Error disconnecting radio', error);
  }
  
  // Clean up any pending effect files
  session.effectQueue.forEach(effect => {
    fs.unlink(effect.filePath, () => {});
  });
  
  activeSessions.delete(session.guildId);
};

export const isRadioActiveInGuild = (guildId: string): boolean => {
  return activeSessions.has(guildId);
};