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
import { VoiceAnnouncementService } from '../services/VoiceAnnouncementService';

interface QueueItem {
  type: 'media' | 'announcement';
  id: string;
  // For media items
  media?: any;
  filters?: string[];
  // For announcement items
  text?: string;
  // Processing state
  processedPath?: string;
  duration?: number;
  isProcessed?: boolean;
}

interface RadioSession {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  queue: QueueItem[];
  currentItem: QueueItem | null;
  nextItem: QueueItem | null;
  isActive: boolean;
  audioPlayer: any;
  isProcessingNext: boolean;
  playbackStartTime: number;
  voiceAnnouncementsEnabled: boolean;
  introPlayed: boolean;
}

// Remove EffectRender interface - no longer needed

const activeSessions = new Map<string, RadioSession>();
const TEMP_EFFECTS_DIR = path.join(process.cwd(), 'temp', 'radio_effects');
const NORMALIZED_CACHE_DIR = path.join(process.cwd(), 'temp', 'radio_normalized');

// Ensure directories exist
if (!fs.existsSync(TEMP_EFFECTS_DIR)) {
  fs.mkdirSync(TEMP_EFFECTS_DIR, { recursive: true });
}
if (!fs.existsSync(NORMALIZED_CACHE_DIR)) {
  fs.mkdirSync(NORMALIZED_CACHE_DIR, { recursive: true });
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
  if (!session.currentItem) {
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
    if (session.nextItem) {
      session.nextItem = { ...session.nextItem, filters: [] };
    }
    await message.reply('🎛️ Filters cleared - next track will play without effects');
    return;
  }
  
  const filters = parseFilters(filterString);
  
  if (session.nextItem) {
    session.nextItem = { ...session.nextItem, filters };
  }
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
  
  // Generate skip announcement if voice announcements are enabled
  if (session.voiceAnnouncementsEnabled && session.nextItem?.type === 'media') {
    try {
      const currentTitle = session.currentItem?.media?.answers?.[0] || session.currentItem?.media?.title || 'current track';
      const nextTitle = session.nextItem.media?.answers?.[0] || session.nextItem.media?.title || 'next track';
      
      const skipText = await VoiceAnnouncementService.generateSkipAnnouncement(currentTitle, nextTitle);
      if (skipText) {
        const ttsResult = await VoiceAnnouncementService.generateTTSAudio(skipText);
        if (ttsResult) {
          // Insert skip announcement before the next track
          const skipAnnouncement: QueueItem = {
            type: 'announcement',
            id: `skip_${Date.now()}`,
            text: skipText,
            processedPath: ttsResult.path,
            duration: ttsResult.duration,
            isProcessed: true
          };
          session.queue.unshift(skipAnnouncement);
        }
      }
    } catch (error) {
      logger.debug('Failed to generate skip announcement');
    }
  }
  
  await message.reply('⏭️ Skipping...');
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
      .map((item, index) => {
        const title = item.media?.answers?.[0] || item.media?.title || item.text;
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
    // Check if it's a supported video URL (YouTube, Twitch, etc.)
    else if (isSupportedVideoUrl(searchTerm)) {
      // Delete the original message to prevent URL embed
      try {
        await message.delete();
      } catch (error) {
        // Ignore if we can't delete (permissions, etc.)
      }
      
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

    session.queue.push({
      type: 'media',
      id: (mediaItem as any).id || crypto.randomBytes(16).toString('hex'),
      media: mediaItem,
      filters: [],
      isProcessed: false
    });
    
    const primaryAnswer = mediaItem.answers && mediaItem.answers.length > 0 
      ? (typeof mediaItem.answers[0] === 'string' ? mediaItem.answers[0] : mediaItem.answers[0].answer)
      : mediaItem.title;
    
    // Generate queue request announcement
    if (session.voiceAnnouncementsEnabled) {
      try {
        const username = message.author.username || message.author.displayName || 'Someone';
        const trackTitle = primaryAnswer;
        
        const queueText = await VoiceAnnouncementService.generateQueueAnnouncement(username, trackTitle);
        if (queueText) {
          const ttsResult = await VoiceAnnouncementService.generateTTSAudio(queueText);
          if (ttsResult) {
            // Insert queue announcement before the requested track
            const queueAnnouncement: QueueItem = {
              type: 'announcement',
              id: `queue_${Date.now()}`,
              text: queueText,
              processedPath: ttsResult.path,
              duration: ttsResult.duration,
              isProcessed: true
            };
            // Insert announcement before the media item
            session.queue.splice(session.queue.length - 1, 0, queueAnnouncement);
          }
        }
      } catch (error) {
        logger.debug('Failed to generate queue announcement');
      }
    }
    
    // Clear any prepared random track so queued items play next
    if (session.nextItem && (!session.queue.length || session.nextItem.media !== session.queue[0].media)) {
      session.nextItem = null;
    }
    
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
  
  if (!session.currentItem) {
    await message.reply('📻 Nothing currently playing');
    return;
  }
  
  const primaryAnswer = session.currentItem.media?.answers?.[0] || session.currentItem.media?.title;
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
    currentItem: null,
    nextItem: null,
    isActive: true,
    audioPlayer,
    isProcessingNext: false,
    playbackStartTime: 0,
    voiceAnnouncementsEnabled: true,
    introPlayed: false, // Track if intro has been played
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
  // Only progress to next track if we're not already processing
  if (!session.isProcessingNext) {
    playNext(session, channel);
  }
};

const playNext = async (session: RadioSession, channel: any) => {
  try {
    // Prevent multiple concurrent calls
    if (session.isProcessingNext) {
      return;
    }
    
    // Play intro first if not played yet (while preparing first track)
    if (!session.introPlayed) {
      session.introPlayed = true;
      
      try {
        const introText = await VoiceAnnouncementService.generateRadioIntro();
        if (introText) {
          const ttsResult = await VoiceAnnouncementService.generateTTSAudio(introText);
          if (ttsResult) {
            logger.debug('Playing radio intro while preparing first track');
            await updateBotNickname(session, null, '🗣️Radio Intro');
            const resource = createAudioResource(ttsResult.path);
            session.audioPlayer.play(resource);
            
            // Start preparing first track in parallel while intro plays
            setTimeout(() => prepareFirstTrack(session, channel), 100);
            
            // Start next track after intro completes with small buffer
            setTimeout(() => {
              if (session.nextItem?.processedPath) {
                playNextTrack(session);
              }
            }, ttsResult.duration + 500);
            return;
          }
        }
      } catch (error) {
        logger.debug('Failed to generate radio intro, continuing with first track');
      }
      
      // If intro TTS failed, start first track immediately
      prepareFirstTrack(session, channel);
    }
    
    let nextItem = session.nextItem;
    let filePath = session.nextItem?.processedPath;
    
    // If we have a pre-processed item ready, use it
    if (nextItem && filePath && fs.existsSync(filePath)) {
      logger.debug(`Using pre-processed item: ${filePath}`);
      
      // Remove from queue if it came from there
      if (session.queue.length > 0 && session.queue[0].id === nextItem.id) {
        session.queue.shift();
      }
    } else {
      // Select next item from queue or random
      if (session.queue.length > 0) {
        nextItem = session.queue.shift()!;
      } else {
        // Create random media item
        const randomMedia = await getRandomMedia(1);
        if (randomMedia.length === 0) {
          await channel.send('No media available');
          return;
        }
        nextItem = {
          type: 'media',
          id: `random_${Date.now()}`,
          media: randomMedia[0],
          filters: session.nextItem?.filters || [],
          isProcessed: false
        };
      }
      
      // Process the item
      if (nextItem.type === 'announcement') {
        if (!nextItem.processedPath) {
          const ttsResult = await VoiceAnnouncementService.generateTTSAudio(nextItem.text!);
          if (ttsResult) {
            nextItem.processedPath = ttsResult.path;
            nextItem.duration = ttsResult.duration;
          }
        }
        filePath = nextItem.processedPath;
      } else {
        // Media item processing
        if (nextItem.filters && nextItem.filters.length > 0) {
          filePath = await getOrCreateFilteredVersion(nextItem.media, nextItem.filters);
        } else {
          filePath = await getNormalizedAudioPath(nextItem.media);
        }
      }
    }
    
    // Generate voice announcement if enabled and previous track was media
    if (session.voiceAnnouncementsEnabled && 
        session.currentItem?.type === 'media' && 
        nextItem.type === 'media' && 
        !nextItem.isProcessed) {
      try {
        const announcementText = await VoiceAnnouncementService.generateRadioAnnouncement(
          session.currentItem.media,
          nextItem.media,
          session.currentItem.filters && session.currentItem.filters.length > 0 ? `Filters: ${session.currentItem.filters.join(', ')}` : undefined
        );
        
        if (announcementText) {
          const ttsResult = await VoiceAnnouncementService.generateTTSAudio(announcementText);
          
          if (ttsResult) {
            logger.debug('Playing announcement while next track may still be processing');
            await updateBotNickname(session, null, '🗣️Radio Announcement');
            const resource = createAudioResource(ttsResult.path);
            session.audioPlayer.play(resource);
            
            // Store next track info and start it after announcement
            session.nextItem = { ...nextItem, isProcessed: true };
            session.nextItem.processedPath = filePath;
            
            // Use actual TTS duration instead of hardcoded timeout
            setTimeout(() => playNextTrack(session), ttsResult.duration + 500);
            return;
          }
        }
      } catch (error) {
        logger.debug('Failed to generate voice announcement');
      }
    }
    
    // Reset skip flag
    if (session.nextItem) {
      session.nextItem.isProcessed = false;
    }
    
    // No announcement - play item directly
    await playNextTrack(session, nextItem, filePath);
    
  } catch (error) {
    logger.error('Error in playNext', error);
    // Only retry after a delay if not already processing
    if (!session.isProcessingNext) {
      setTimeout(() => playNext(session, channel), 3000);
    }
  }
};

const playNextTrack = async (session: RadioSession, nextItem?: QueueItem, filePath?: string) => {
  try {
    // Use provided item or get from session
    const item = nextItem || session.nextItem;
    const path = filePath || session.nextItem?.processedPath;
    
    if (!item || !path || !fs.existsSync(path)) {
      logger.error('No valid track to play');
      return;
    }
    
    // Update session state
    session.currentItem = item;
    session.nextItem = null;
    session.playbackStartTime = Date.now();
    
    // Get track duration for timing calculations
    item.duration = await getAudioDuration(path);
    
    // Update bot nickname to show current track
    if (item.type === 'announcement') {
      await updateBotNickname(session, null, '🗣️Announcement');
    } else {
      const displayName = item.media?.answers?.[0] || item.media?.title || 'Unknown Track';
      await updateBotNickname(session, null, `📻${displayName}`);
    }
    
    // Play the track
    const resource = createAudioResource(path);
    session.audioPlayer.play(resource);
    
    // Start preparing next track while current plays (after 2 seconds)
    setTimeout(() => {
      if (session.isActive && !session.isProcessingNext) {
        prepareNextTrack(session);
      }
    }, 2000);
    
    const itemName = item.type === 'announcement' ? 'Announcement' : 
                    (item.media?.title || item.media?.answers?.[0] || 'Unknown');
    logger.debug(`Playing ${item.type}: ${itemName}`);
    
  } catch (error) {
    logger.error('Error playing track', error);
  }
};

const prepareNextTrack = async (session: RadioSession) => {
  if (session.isProcessingNext) return;
  
  session.isProcessingNext = true;
  
  try {
    let nextItem: QueueItem;
    
    // Get next item from queue or create random media
    if (session.queue.length > 0) {
      nextItem = session.queue[0]; // Don't shift yet - will be shifted when played
    } else {
      const randomMedia = await getRandomMedia(1);
      if (randomMedia.length === 0) return;
      
      nextItem = {
        type: 'media',
        id: `random_${Date.now()}`,
        media: randomMedia[0],
        filters: [],
        isProcessed: false
      };
    }
    
    // Process the media item
    let processedPath: string;
    
    if (nextItem.type === 'announcement') {
      if (!nextItem.processedPath) {
        const ttsResult = await VoiceAnnouncementService.generateTTSAudio(nextItem.text!);
        if (ttsResult) {
          processedPath = ttsResult.path;
          nextItem.duration = ttsResult.duration;
        } else {
          throw new Error('Failed to generate TTS for announcement');
        }
      } else {
        processedPath = nextItem.processedPath;
      }
    } else {
      // Media item processing
      if (nextItem.filters && nextItem.filters.length > 0) {
        processedPath = await getOrCreateFilteredVersion(nextItem.media, nextItem.filters);
      } else {
        processedPath = await getNormalizedAudioPath(nextItem.media);
      }
    }
    
    // Generate TTS transition announcement for media items
    if (nextItem.type === 'media' && session.currentItem?.type === 'media' && session.voiceAnnouncementsEnabled) {
      try {
        const announcementText = await VoiceAnnouncementService.generateRadioAnnouncement(
          session.currentItem.media,
          nextItem.media,
          nextItem.filters && nextItem.filters.length > 0 ? `Filters: ${nextItem.filters.join(', ')}` : undefined
        );
        
        if (announcementText) {
          const ttsResult = await VoiceAnnouncementService.generateTTSAudio(announcementText);
          if (ttsResult) {
            // Queue TTS first, then media
            const ttsItem: QueueItem = {
              type: 'announcement',
              id: `transition_${Date.now()}`,
              text: announcementText,
              processedPath: ttsResult.path,
              duration: ttsResult.duration,
              isProcessed: true
            };
            
            // Insert TTS before the media item in queue
            if (session.queue.length > 0 && session.queue[0].id === nextItem.id) {
              session.queue.unshift(ttsItem);
            } else {
              // For random media, set up both items
              session.nextItem = ttsItem;
              // Queue the media after TTS
              session.queue.unshift(nextItem);
            }
            
            logger.debug('Prepared TTS transition and queued media');
            return;
          }
        }
      } catch (error) {
        logger.debug('Failed to generate transition TTS, playing media directly');
      }
    }
    
    // Store processed item (no TTS transition)
    session.nextItem = {
      ...nextItem,
      processedPath,
      isProcessed: true
    };
    
    logger.debug(`Next ${nextItem.type} prepared: ${processedPath}`);
    
  } catch (error) {
    logger.error('Error preparing next track', error);
  } finally {
    session.isProcessingNext = false;
  }
};

const prepareFirstTrack = async (session: RadioSession, channel: any) => {
  try {
    let firstItem: QueueItem;
    
    if (session.queue.length > 0) {
      firstItem = session.queue.shift()!;
    } else {
      const randomMedia = await getRandomMedia(1);
      if (randomMedia.length === 0) {
        await channel.send('No media available');
        return;
      }
      
      firstItem = {
        type: 'media',
        id: `random_${Date.now()}`,
        media: randomMedia[0],
        filters: [],
        isProcessed: false
      };
    }
    
    // Process first track
    let filePath: string;
    
    if (firstItem.type === 'announcement') {
      const ttsResult = await VoiceAnnouncementService.generateTTSAudio(firstItem.text!);
      if (ttsResult) {
        filePath = ttsResult.path;
        firstItem.duration = ttsResult.duration;
      } else {
        throw new Error('Failed to generate TTS for first announcement');
      }
    } else {
      if (firstItem.filters && firstItem.filters.length > 0) {
        filePath = await getOrCreateFilteredVersion(firstItem.media, firstItem.filters);
      } else {
        filePath = await getNormalizedAudioPath(firstItem.media);
      }
    }
    
    session.nextItem = {
      ...firstItem,
      processedPath: filePath,
      isProcessed: true
    };
    
    logger.debug('First track prepared while intro was playing');
    
  } catch (error) {
    logger.error('Error preparing first track', error);
  }
};

const getAudioDuration = async (filePath: string): Promise<number> => {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-i', filePath,
      '-show_entries', 'format=duration',
      '-v', 'quiet',
      '-of', 'csv=p=0'
    ]);
    
    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.on('close', () => {
      const duration = parseFloat(output.trim()) || 180; // Default 3 minutes
      resolve(duration);
    });
    
    ffprobe.on('error', () => {
      resolve(180); // Fallback duration
    });
  });
};

const queueRewindEffect = async (session: RadioSession) => {
  try {
    if (!session.currentItem || session.currentItem.type !== 'media') {
      return;
    }
    
    console.log('Creating rewind effect...');
    const rewindPath = await createRewindEffect(session.currentItem.media, session);
    console.log('Rewind effect created:', rewindPath);
    
    // Calculate effect duration based on current playback position
    const currentTime = (Date.now() - session.playbackStartTime) / 1000;
    const duration = session.currentItem.duration || 180;
    const rewindDuration = Math.min(currentTime, duration, 30);
    const rewindSpeed = Math.max(4, Math.min(16, rewindDuration / 2));
    const effectDuration = Math.max(1000, (rewindDuration / rewindSpeed) * 1000); // Convert to ms
    
    console.log(`Rewind stats: currentTime=${currentTime}s, rewindDuration=${rewindDuration}s, speed=${rewindSpeed}x, effectDuration=${effectDuration}ms`);
    
    const rewindEffect: QueueItem = {
      type: 'media',
      id: `rewind_${Date.now()}`,
      media: {
        id: null,
        title: 'Rewind Effect',
        filePath: rewindPath,
        isTemporary: true,
        answers: ['Rewind Effect']
      },
      duration: effectDuration,
      isProcessed: false
    };
    
    session.queue.push(rewindEffect);
    console.log('Rewind effect queued, stopping current playback');
    
    // Stop current playback immediately to trigger the effect
    session.audioPlayer.stop();
  } catch (error) {
    console.error('Error creating rewind effect:', error);
    // Fallback: just restart the track
    if (session.currentItem) {
      session.nextItem = { ...session.currentItem };
      if (session.nextItem) {
        session.nextItem.filters = session.currentItem.filters?.slice() || [];
      }
    }
    session.audioPlayer.stop();
  }
};

const createRewindEffect = async (media: any, session: RadioSession): Promise<string> => {
  const outputPath = path.join(TEMP_EFFECTS_DIR, `rewind_${Date.now()}.ogg`);
  const inputPath = MediaService.resolveMediaPath(media);
  
  // Calculate current playback position
  const currentTime = (Date.now() - session.playbackStartTime) / 1000;
  const trackDuration = session.currentItem?.duration || 180;
  const rewindDuration = Math.min(currentTime, trackDuration, 15); // Reduced cap for reliability
  
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

const getOrCreateFilteredVersion = async (media: any, filters: string[]): Promise<string> => {
  const filterHash = filters.join('_').replace(/[^a-zA-Z0-9]/g, '_');
  const outputPath = path.join(TEMP_EFFECTS_DIR, `filtered_${media.id}_${filterHash}.ogg`);
  
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }
  
  const inputPath = MediaService.resolveMediaPath(media);
  const filterArgs = buildFilterArgs(filters);
  
  // Create filtered version first
  const tempFilteredPath = path.join(TEMP_EFFECTS_DIR, `temp_filtered_${Date.now()}.ogg`);
  
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      ...filterArgs,
      '-f', 'ogg',
      '-y',
      tempFilteredPath
    ]);
    
    ffmpeg.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Filter processing failed with code ${code}`));
        return;
      }
      
      try {
        // Apply loudness normalization to filtered audio
        await normalizeAudioLoudness(tempFilteredPath, outputPath);
        
        // Clean up temp file
        fs.unlink(tempFilteredPath, () => {});
        
        resolve(outputPath);
      } catch (error) {
        // Clean up temp file on error
        fs.unlink(tempFilteredPath, () => {});
        reject(error);
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
  session.queue.forEach(item => {
    if (item.type === 'media' && item.media?.filePath) {
      fs.unlink(item.media.filePath, () => {});
    }
  });
  
  // Reset bot nickname
  resetBotNickname(session);
  
  activeSessions.delete(session.guildId);
};

const updateBotNickname = async (session: RadioSession, media?: any, customText?: string) => {
  try {
    const guild = session.connection.joinConfig?.guildId;
    if (!guild) return;
    
    const bot = await import('../../index');
    const client = bot.client;
    const guildObj = client.guilds.cache.get(guild);
    
    if (!guildObj || !guildObj.members.me) return;
    
    let nickname: string;
    
    if (customText) {
      // Use custom text (for announcements)
      nickname = customText;
    } else if (media) {
      // Use media title
      const displayName = media.answers?.[0]?.answer || media.title || 'Unknown';
      nickname = `📻${displayName}`;
    } else {
      // Default radio state
      nickname = '📻Radio';
    }
    
    const truncatedNickname = nickname.length > 32 ? nickname.substring(0, 29) + '...' : nickname;
    
    await guildObj.members.me.setNickname(truncatedNickname);
    logger.debug(`Updated bot nickname to: ${truncatedNickname}`);
  } catch (error) {
    logger.debug('Failed to update bot nickname');
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
  } catch (error) {
    console.error('Failed to reset bot nickname:', error);
  }
};

const getNormalizedAudioPath = async (media: any): Promise<string> => {
  const mediaId = media.id || crypto.createHash('md5').update(media.filePath).digest('hex');
  const normalizedPath = path.join(NORMALIZED_CACHE_DIR, `normalized_${mediaId}.ogg`);
  
  if (fs.existsSync(normalizedPath)) {
    return normalizedPath;
  }
  
  const inputPath = MediaService.resolveMediaPath(media);
  if (!fs.existsSync(inputPath) && media.filePath) {
    return media.filePath;
  }
  
  try {
    await normalizeAudioLoudness(inputPath, normalizedPath);
    return normalizedPath;
  } catch (error) {
    logger.error('Failed to normalize audio', error);
    return inputPath;
  }
};

const normalizeAudioFast = async (inputPath: string, outputPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    logger.debug(`Fast volume normalization for: ${inputPath}`);
    
    // Single-pass normalization using volume filter with peak detection
    // This is much faster than two-pass loudnorm but still effective for radio
    const normalizeProcess = spawn('ffmpeg', [
      '-i', inputPath,
      '-af', 'volume=0.8,loudnorm=I=-18:dual_mono=true:linear=true',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-ar', '48000',
      '-f', 'ogg',
      '-y',
      outputPath
    ]);
    
    let errorOutput = '';
    normalizeProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    normalizeProcess.on('close', (code) => {
      if (code === 0) {
        logger.debug(`Fast normalization completed: ${outputPath}`);
        resolve();
      } else {
        logger.error(`Fast normalization failed with code ${code}. Error: ${errorOutput}`);
        reject(new Error(`Fast normalization failed with code ${code}`));
      }
    });
    
    normalizeProcess.on('error', (error) => {
      logger.error(`Fast normalization process error: ${error}`);
      reject(error);
    });
  });
};

const normalizeAudioLoudness = async (inputPath: string, outputPath: string): Promise<void> => {
  // Try fast normalization first for radio use
  try {
    await normalizeAudioFast(inputPath, outputPath);
    return;
  } catch (error) {
    logger.debug('Fast normalization failed, falling back to full loudnorm');
  }
  
  return new Promise((resolve, reject) => {
    logger.debug(`Starting loudness analysis for: ${inputPath}`);
    
    // First pass: analyze loudness (using -16 LUFS which is more standard)
    const analyzeProcess = spawn('ffmpeg', [
      '-i', inputPath,
      '-af', 'loudnorm=I=-16:TP=-1:LRA=7:print_format=json',
      '-f', 'null',
      '-'
    ]);
    
    let analysisOutput = '';
    let errorOutput = '';
    
    analyzeProcess.stderr.on('data', (data) => {
      const output = data.toString();
      analysisOutput += output;
      errorOutput += output;
    });
    
    analyzeProcess.on('close', (code) => {
      if (code !== 0) {
        logger.error(`Loudness analysis failed with code ${code}. Error: ${errorOutput}`);
        reject(new Error(`Loudness analysis failed with code ${code}`));
        return;
      }
      
      try {
        // Extract loudness stats from JSON output
        const jsonMatch = analysisOutput.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.error(`No loudness stats found. Output: ${analysisOutput}`);
          throw new Error('No loudness stats found in analysis');
        }
        
        const stats = JSON.parse(jsonMatch[0]);
        logger.debug(`Loudness stats: ${JSON.stringify(stats)}`);
        
        // Second pass: apply normalization to -16 LUFS (good for music)
        const normalizeProcess = spawn('ffmpeg', [
          '-i', inputPath,
          '-af', `loudnorm=I=-16:TP=-1:LRA=7:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`,
          '-c:a', 'libopus',
          '-b:a', '128k',
          '-f', 'ogg',
          '-y',
          outputPath
        ]);
        
        let normalizeError = '';
        normalizeProcess.stderr.on('data', (data) => {
          normalizeError += data.toString();
        });
        
        normalizeProcess.on('close', (normalizeCode) => {
          if (normalizeCode === 0) {
            logger.debug(`Loudness normalization completed: ${outputPath}`);
            resolve();
          } else {
            logger.error(`Loudness normalization failed with code ${normalizeCode}. Error: ${normalizeError}`);
            reject(new Error(`Loudness normalization failed with code ${normalizeCode}`));
          }
        });
        
        normalizeProcess.on('error', (error) => {
          logger.error(`Normalization process error: ${error}`);
          reject(error);
        });
        
      } catch (error) {
        logger.error(`Failed to parse loudness stats: ${error}. Output: ${analysisOutput}`);
        reject(new Error(`Failed to parse loudness stats: ${error}`));
      }
    });
    
    analyzeProcess.on('error', (error) => {
      logger.error(`Analysis process error: ${error}`);
      reject(error);
    });
  });
};

export const isRadioActiveInGuild = (guildId: string): boolean => {
  return activeSessions.has(guildId);
};

// Helper function to check if a string is a YouTube URL
const isYouTubeUrl = (url: string): boolean => {
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
  return youtubeRegex.test(url);
};

// Helper function to check if a string is a supported video URL (YouTube, Twitch, etc.)
const isSupportedVideoUrl = (url: string): boolean => {
  const supportedRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be|twitch\.tv)\/.+$/;
  return supportedRegex.test(url);
};

// Helper function to download and extract video info from YouTube URL
const downloadYouTubeVideo = async (url: string): Promise<{ title: string; filePath: string } | null> => {
  try {
    // First, get video info without downloading
    const info = await youtubeDl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      defaultSearch: 'ytsearch'
    });

    if (!info || typeof info !== 'object' || !('title' in info) || !info.title) {
      return null;
    }

    // Check duration (20 minutes = 1200 seconds)
    const duration = info.duration as number;
    if (duration && duration > 1200) {
      throw new Error(`Video too long (${Math.round(duration / 60)} minutes). Maximum allowed: 20 minutes`);
    }

    // Generate a unique filename
    const id = crypto.randomBytes(8).toString('hex');
    const tempFilePath = path.join(TEMP_EFFECTS_DIR, `yt_${id}.%(ext)s`);
    
    // Download audio-only for better bandwidth efficiency
    await youtubeDl(url, {
      output: tempFilePath,
      format: 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/worst[height<=360]',
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 96
    });
    
    // Find the actual downloaded file
    const downloadedFiles = fs.readdirSync(TEMP_EFFECTS_DIR).filter(f => f.startsWith(`yt_${id}`));
    const actualFile = downloadedFiles[0];
    
    if (!actualFile) {
      throw new Error('Downloaded file not found');
    }
    
    return {
      title: info.title as string,
      filePath: path.join(TEMP_EFFECTS_DIR, actualFile)
    };
  } catch (error) {
    logger.error('YouTube download failed:', error);
    throw error;
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

export const handleAnnouncementsCommand = async (message: Message, action?: string) => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    await message.reply('No radio session active. Start one with `NOW radio`');
    return;
  }
  
  const session = activeSessions.get(message.guild.id)!;
  
  if (!action || action === 'status') {
    const status = session.voiceAnnouncementsEnabled ? 'enabled' : 'disabled';
    await message.reply(`📢 Voice announcements are currently **${status}**`);
    return;
  }
  
  if (action === 'on' || action === 'enable') {
    session.voiceAnnouncementsEnabled = true;
    await message.reply('📢 Voice announcements enabled! AI will now generate quirky radio host clips between tracks');
  } else if (action === 'off' || action === 'disable') {
    session.voiceAnnouncementsEnabled = false;
    await message.reply('📢 Voice announcements disabled');
  } else {
    await message.reply('Use `NOW announcements on/off` to toggle voice announcements');
  }
  
  // Clean up TTS cache when toggling
  VoiceAnnouncementService.cleanupTTSCache();
};

export const handleAnnounceCommand = async (message: Message, announceText?: string) => {
  if (!announceText) {
    await message.reply('Please provide text for the announcement. Example: `NOW announce Welcome to our show!`');
    return;
  }

  if (!message.guild || !activeSessions.has(message.guild.id)) {
    await message.reply('No radio session active. Start one with `NOW radio`');
    return;
  }

  const session = activeSessions.get(message.guild.id)!;

  try {
    const announcementText = await VoiceAnnouncementService.generateCustomAnnouncement(announceText);
    
    if (announcementText) {
      const announcementItem: QueueItem = {
        type: 'announcement',
        id: `announce_${Date.now()}`,
        text: announcementText,
        isProcessed: false
      };
      
      session.queue.push(announcementItem);
      await message.reply(`📢 Queued announcement: "${announcementText}"`);
    } else {
      await message.reply('❌ Failed to process announcement text');
    }
  } catch (error) {
    logger.error('Error handling announce command');
    await message.reply('❌ Failed to create announcement');
  }
};

export const handleVoiceCommand = async (message: Message, voiceText?: string) => {
  if (!voiceText) {
    await message.reply('Please provide text for the voice clip. Example: `NOW voice Hello everyone!`');
    return;
  }

  const statusMessage = await message.reply('🎙️ Generating voice clip...');

  try {
    const processedText = await VoiceAnnouncementService.generateCustomAnnouncement(voiceText);
    const ttsResult = await VoiceAnnouncementService.generateTTSAudio(processedText || voiceText);
    
    if (ttsResult && fs.existsSync(ttsResult.path)) {
      if ('send' in message.channel) {
        await message.channel.send({
          content: `🎙️ Voice clip: "${processedText || voiceText}"`,
          files: [{ attachment: ttsResult.path, name: 'voice_clip.wav' }]
        });
      }
      await statusMessage.delete();
    } else {
      await statusMessage.edit('❌ Failed to generate voice clip');
    }
  } catch (error) {
    logger.error('Error handling voice command');
    await statusMessage.edit('❌ Failed to create voice clip');
  }
};