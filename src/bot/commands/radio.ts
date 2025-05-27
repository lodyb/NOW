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
import { audioEffects, videoEffects } from '../../media/processor';
// @ts-ignore
import youtubeDl from 'youtube-dl-exec';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { Stream } from 'stream';
import { promisify } from 'util';

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
  playbackStartTime: number;
  currentTrackDuration: number;
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
  
  // Check for clear/reset commands
  const cleanFilter = filterString.replace(/[{}]/g, '').trim().toLowerCase();
  if (cleanFilter === 'clear' || cleanFilter === 'reset' || cleanFilter === 'none') {
    session.nextFilters = [];
    await message.reply('🎛️ Filters cleared - next track will play without effects');
    return;
  }
  
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

  const statusMessage = await message.reply('Processing... ⏳');

  try {
    let mediaItem;

    // Check for attachments in current message first
    if (message.attachments.size > 0) {
      const downloadedMedia = await extractMediaFromAttachment(message.attachments.first()!);
      if (downloadedMedia) {
        mediaItem = downloadedMedia;
      }
    }
    // Check if it's a YouTube URL
    else if (isYouTubeUrl(searchTerm)) {
      const downloadedMedia = await downloadYouTubeVideo(searchTerm);
      if (downloadedMedia) {
        mediaItem = {
          id: null,
          title: downloadedMedia.title,
          filePath: downloadedMedia.filePath,
          isTemporary: true,
          answers: [downloadedMedia.title]
        };
      }
    }
    // Check if it's a direct media URL
    else if (isDirectMediaUrl(searchTerm)) {
      const downloadedMedia = await downloadDirectMedia(searchTerm);
      if (downloadedMedia) {
        mediaItem = downloadedMedia;
      }
    }
    // Check for attachments in replied message
    else if (message.reference?.messageId) {
      const downloadedMedia = await extractMediaFromReply(message);
      if (downloadedMedia) {
        mediaItem = downloadedMedia;
      }
    }
    // Fall back to database search
    else {
      const mediaItems = await MediaService.findMedia(searchTerm, false, 1);
      if (mediaItems.length > 0) {
        mediaItem = mediaItems[0];
      }
    }

    // If no database match, try music library
    if (!mediaItem) {
      const musicResults = await MediaService.searchMusicLibrary(searchTerm, 1);
      if (musicResults.length > 0) {
        mediaItem = musicResults[0];
      }
    }

    if (!mediaItem) {
      await statusMessage.edit(`❌ No media found for "${searchTerm}"`);
      return;
    }

    session.queue.push(mediaItem);
    
    const primaryAnswer = mediaItem.answers && mediaItem.answers.length > 0 
      ? (typeof mediaItem.answers[0] === 'string' ? mediaItem.answers[0] : mediaItem.answers[0].answer)
      : mediaItem.title;
    
    await statusMessage.edit(`🎵 Added "${primaryAnswer}" to queue (position ${session.queue.length})`);
  } catch (error) {
    logger.error('Error queuing media', error);
    await statusMessage.edit(`❌ Failed to queue media: ${(error as Error).message}`);
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
    effectQueue: [],
    playbackStartTime: 0,
    currentTrackDuration: 0,
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
    let isFromQueue = false;
    
    if (!nextMedia) {
      if (session.queue.length > 0) {
        nextMedia = session.queue.shift();
        isFromQueue = true;
      } else {
        const randomMedia = await getRandomMedia(1);
        if (randomMedia.length === 0) {
          await channel.send('No media available');
          return;
        }
        nextMedia = randomMedia[0];
      }
    } else {
      // If we're using a prepared nextMedia, we need to remove it from queue if it came from there
      if (session.queue.length > 0 && 
          ((session.queue[0].id && nextMedia.id && session.queue[0].id === nextMedia.id) ||
           (session.queue[0].title === nextMedia.title && session.queue[0].filePath === nextMedia.filePath))) {
        session.queue.shift();
        isFromQueue = true;
      }
    }
    
    session.currentMedia = nextMedia;
    session.currentFilters = session.nextFilters.slice();
    session.nextMedia = null;
    session.nextFilters = [];
    
    let filePath: string;
    
    if (session.currentFilters.length > 0) {
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

    // Get track duration and set playback timing
    try {
      const { getMediaInfo } = await import('../../media/processor');
      const mediaInfo = await getMediaInfo(filePath);
      session.currentTrackDuration = mediaInfo.duration;
      session.playbackStartTime = Date.now();
    } catch (error) {
      console.error('Error getting media duration:', error);
      session.currentTrackDuration = 0;
      session.playbackStartTime = Date.now();
    }
    
    const resource = createAudioResource(filePath);
    session.audioPlayer.play(resource);
    
    // Update bot nickname with currently playing media
    await updateBotNickname(session, nextMedia);
    
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
  try {
    console.log('Creating rewind effect...');
    const rewindPath = await createRewindEffect(session.currentMedia, session);
    console.log('Rewind effect created:', rewindPath);
    
    // Calculate effect duration based on current playback position
    const currentTime = (Date.now() - session.playbackStartTime) / 1000;
    const rewindDuration = Math.min(currentTime, session.currentTrackDuration, 30);
    const rewindSpeed = Math.max(4, Math.min(16, rewindDuration / 2));
    const effectDuration = Math.max(1000, (rewindDuration / rewindSpeed) * 1000); // Convert to ms
    
    console.log(`Rewind stats: currentTime=${currentTime}s, rewindDuration=${rewindDuration}s, speed=${rewindSpeed}x, effectDuration=${effectDuration}ms`);
    
    const rewindEffect: EffectRender = {
      type: 'rewind',
      filePath: rewindPath,
      duration: effectDuration,
      onComplete: () => {
        console.log('Rewind effect completed, restarting track');
        // Restart current track from beginning
        session.nextMedia = session.currentMedia;
        session.nextFilters = session.currentFilters.slice();
      }
    };
    
    session.effectQueue.push(rewindEffect);
    console.log('Rewind effect queued, stopping current playback');
    
    // Stop current playback immediately to trigger the effect
    session.audioPlayer.stop();
  } catch (error) {
    console.error('Error creating rewind effect:', error);
    // Fallback: just restart the track
    session.nextMedia = session.currentMedia;
    session.nextFilters = session.currentFilters.slice();
    session.audioPlayer.stop();
  }
};

const createRewindEffect = async (media: any, session: RadioSession): Promise<string> => {
  const outputPath = path.join(TEMP_EFFECTS_DIR, `rewind_${Date.now()}.ogg`);
  const inputPath = MediaService.resolveMediaPath(media);
  
  // Calculate current playback position
  const currentTime = (Date.now() - session.playbackStartTime) / 1000;
  const rewindDuration = Math.min(currentTime, session.currentTrackDuration, 15); // Reduced cap for reliability
  
  if (rewindDuration < 0.5) {
    // Very early in track - simple short reverse
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputPath,
        '-af', 'areverse,aecho=0.3:0.3:100:0.2',
        '-t', '0.8',
        '-f', 'ogg',
        '-y',
        outputPath
      ]);
      
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve(outputPath);
        else reject(new Error(`Simple rewind failed: ${code}`));
      });
      
      ffmpeg.on('error', reject);
    });
  }
  
  // Extract the segment we want to rewind, then reverse it
  const startTime = Math.max(0, currentTime - rewindDuration);
  
  return new Promise((resolve, reject) => {
    // First pass: extract segment and reverse
    const tempReversed = path.join(TEMP_EFFECTS_DIR, `temp_reversed_${Date.now()}.ogg`);
    
    const extractAndReverse = spawn('ffmpeg', [
      '-i', inputPath,
      '-ss', startTime.toString(),
      '-t', rewindDuration.toString(),
      '-af', 'areverse',
      '-f', 'ogg',
      '-y',
      tempReversed
    ]);
    
    extractAndReverse.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Segment extraction failed: ${code}`));
        return;
      }
      
      // Second pass: speed up with simpler approach
      const speedMultiplier = Math.min(8, Math.max(2, rewindDuration / 2)); // Cap at 8x
      
      const speedUp = spawn('ffmpeg', [
        '-i', tempReversed,
        '-af', `asetrate=44100*${speedMultiplier},aresample=44100,aecho=0.2:0.2:80:0.15,volume=1.1`,
        '-f', 'ogg',
        '-y',
        outputPath
      ]);
      
      speedUp.on('close', (speedCode) => {
        // Clean up temp file
        fs.unlink(tempReversed, () => {});
        
        if (speedCode === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`Speed adjustment failed: ${speedCode}`));
        }
      });
      
      speedUp.on('error', reject);
    });
    
    extractAndReverse.on('error', reject);
  });
};

const playEffect = async (session: RadioSession, effect: EffectRender) => {
  console.log(`Playing effect: ${effect.type} from ${effect.filePath}`);
  
  if (!fs.existsSync(effect.filePath)) {
    console.error(`Effect file not found: ${effect.filePath}`);
    if (effect.onComplete) {
      effect.onComplete();
    }
    return;
  }
  
  const resource = createAudioResource(effect.filePath);
  session.audioPlayer.play(resource);
  console.log(`Effect started, duration: ${effect.duration}ms`);
  
  // Clean up effect file after playing
  setTimeout(() => {
    console.log(`Cleaning up effect file: ${effect.filePath}`);
    fs.unlink(effect.filePath, () => {});
  }, effect.duration + 1000);
  
  if (effect.onComplete) {
    console.log('Triggering effect onComplete callback');
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
      
      // Check if it's a known audio effect with the value
      if (key in audioEffects) {
        // For bass, treble, etc. that accept values
        switch (key) {
          case 'bass':
            const bassGain = Number(value);
            if (!isNaN(bassGain) && bassGain >= -20 && bassGain <= 20) {
              args.push('-af', `bass=g=${bassGain}`);
            }
            break;
          case 'treble':
            const trebleGain = Number(value);
            if (!isNaN(trebleGain) && trebleGain >= -20 && trebleGain <= 20) {
              args.push('-af', `treble=g=${trebleGain}`);
            }
            break;
          case 'volume':
          case 'vol':
          case 'amplify':
            const vol = Number(value);
            if (!isNaN(vol) && vol > 0 && vol <= 5) {
              args.push('-af', `volume=${vol}`);
            }
            break;
          case 'speed':
          case 'tempo':
            const speed = Number(value);
            if (!isNaN(speed) && speed > 0.5 && speed < 2.0) {
              args.push('-af', `atempo=${speed}`);
            }
            break;
          default:
            // Pass through other key=value filters
            args.push('-af', `${key}=${value}`);
        }
      } else {
        // Pass through unknown key=value filters
        args.push('-af', `${key}=${value}`);
      }
    } else {
      // Check if it's a known audio effect
      if (filter in audioEffects) {
        args.push('-af', audioEffects[filter]);
      } else if (filter in videoEffects) {
        args.push('-vf', videoEffects[filter]);
      } else {
        // Fallback for unknown filters
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
        }
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
  
  // Reset bot nickname
  resetBotNickname(session);
  
  activeSessions.delete(session.guildId);
};

export const isRadioActiveInGuild = (guildId: string): boolean => {
  return activeSessions.has(guildId);
};

const updateBotNickname = async (session: RadioSession, media: any) => {
  try {
    const guild = session.connection.joinConfig?.guildId;
    if (!guild) return;
    
    const bot = await import('../../index');
    const client = bot.client;
    const guildObj = client.guilds.cache.get(guild);
    
    if (!guildObj || !guildObj.members.me) return;
    
    // Get the first answer or use title
    const displayName = media.answers?.[0]?.answer || media.title || 'Unknown';
    const nickname = `📻${displayName}`;
    
    // Discord nickname limit is 32 characters
    const truncatedNickname = nickname.length > 32 ? nickname.substring(0, 29) + '...' : nickname;
    
    await guildObj.members.me.setNickname(truncatedNickname);
    console.log(`Updated bot nickname to: ${truncatedNickname}`);
  } catch (error) {
    console.error('Failed to update bot nickname:', error);
  }
};

const resetBotNickname = async (session: RadioSession) => {
  try {
    const guild = session.connection.joinConfig?.guildId;
    if (!guild) return;
    
    const bot = await import('../../index');
    const client = bot.client;
    const guildObj = client.guilds.cache.get(guild);
    
    if (!guildObj || !guildObj.members.me) return;
    
    await guildObj.members.me.setNickname('froget');
    console.log('Reset bot nickname to: froget');
  } catch (error) {
    console.error('Failed to reset bot nickname:', error);
  }
};

// Helper function to check if a string is a YouTube URL
const isYouTubeUrl = (url: string): boolean => {
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
  return youtubeRegex.test(url);
};

// Helper function to download and extract video info from YouTube URL
const downloadYouTubeVideo = async (url: string): Promise<{ title: string; filePath: string } | null> => {
  try {
    const output = await youtubeDl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      defaultSearch: 'ytsearch',
      format: 'best[ext=mp4]/best'
    });

    // Type guard to check if output has the expected properties
    if (output && typeof output === 'object' && 'title' in output && output.title) {
      // Generate a unique filename
      const id = crypto.randomBytes(8).toString('hex');
      const ext = ('ext' in output && output.ext) ? output.ext : 'mp4';
      const tempFilePath = path.join(TEMP_EFFECTS_DIR, `yt_${id}.${ext}`);
      
      // Download the actual file
      await youtubeDl(url, {
        output: tempFilePath,
        format: 'best[ext=mp4]/best'
      });
      
      return {
        title: output.title as string,
        filePath: tempFilePath
      };
    }
    return null;
  } catch (error) {
    logger.error('YouTube download failed:', error);
    return null;
  }
};

// Helper function to check if a string is a direct media URL
const isDirectMediaUrl = (url: string): boolean => {
  const mediaExtensions = /\.(mp3|wav|ogg|m4a|flac|aac|wma|webm|mp4|avi|mov|mkv|flv|wmv|mpg|mpeg|3gp|3g2|ra|ram|aiff|aif|dsf|dff|cda|midi|mid|kar|opus|alac|vqf|wv|tak|ape|mac|mmf|spx|ogg2|oga|ogx|opus2|mka|m4b|aac2|aiff2|dsf2|dff2|wv2|tak2|ape2|mac2|mmf2|spx2)$/i;
  return mediaExtensions.test(url);
};

// Helper function to download media from a direct URL
const downloadDirectMedia = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
  
  const buffer = await response.buffer();
  const title = path.basename(url);
  
  // Generate a unique ID for the media item
  const id = crypto.randomBytes(16).toString('hex');
  
  // Save the file temporarily
  const tempFilePath = path.join(TEMP_EFFECTS_DIR, `${id}_${title}`);
  fs.writeFileSync(tempFilePath, buffer);
  
  return {
    id,
    title,
    filePath: tempFilePath,
    isTemporary: true,
    answers: [{ answer: title }]
  };
};

// Helper function to extract media from a replied message
const extractMediaFromReply = async (message: Message) => {
  if (!message.reference?.messageId) return null;
  
  const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
  
  if (repliedMessage.attachments.size > 0) {
    const attachment = repliedMessage.attachments.first();
    if (attachment) {
      return await extractMediaFromAttachment(attachment);
    }
  }
  
  return null;
};

// Helper function to extract media from a direct message attachment
const extractMediaFromAttachment = async (attachment: any) => {
  const response = await fetch(attachment.url);
  const buffer = await response.buffer();
  const title = attachment.name || 'downloaded_media';
  
  // Generate a unique ID for the media item
  const id = crypto.randomBytes(16).toString('hex');
  
  // Save the file temporarily
  const tempFilePath = path.join(TEMP_EFFECTS_DIR, `${id}_${title}`);
  fs.writeFileSync(tempFilePath, buffer);
  
  return {
    id,
    title,
    filePath: tempFilePath,
    isTemporary: true,
    answers: [{ answer: title }]
  };
};