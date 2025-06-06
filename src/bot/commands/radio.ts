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
  // Add proper synchronization flags
  isTransitioning: boolean;
  pendingTimeouts: NodeJS.Timeout[];
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
  
  // Prevent multiple skip commands
  if (session.isTransitioning) {
    await message.reply('⏭️ Already skipping...');
    return;
  }
  
  await message.reply('⏭️ Skipping...');
  
  // Clear any pending timeouts to prevent race conditions
  session.pendingTimeouts.forEach(clearTimeout);
  session.pendingTimeouts = [];
  
  // If we have a pre-processed next item ready, skip immediately with TTS
  if (session.nextItem?.processedPath && fs.existsSync(session.nextItem.processedPath)) {
    
    // Generate skip announcement if voice announcements are enabled
    if (session.voiceAnnouncementsEnabled && session.nextItem.type === 'media') {
      try {
        const currentTitle = session.currentItem?.media?.answers?.[0] || session.currentItem?.media?.title || 'current track';
        const nextTitle = session.nextItem.media?.answers?.[0] || session.nextItem.media?.title || 'next track';
        
        const skipText = await VoiceAnnouncementService.generateSkipAnnouncement(currentTitle, nextTitle, session.nextItem.media);
        if (skipText) {
          const ttsResult = await VoiceAnnouncementService.generateTTSAudio(skipText);
          if (ttsResult) {
            // Play skip announcement immediately
            session.audioPlayer.stop();
            session.isTransitioning = true;
            
            await updateBotNickname(session, null, '🗣️Skip');
            const resource = createAudioResource(ttsResult.path);
            session.audioPlayer.play(resource);
            
            // Play next track after announcement
            const skipTimeout = setTimeout(() => {
              if (session.nextItem) {
                session.isTransitioning = false;
                playNextTrack(session, session.nextItem, session.nextItem.processedPath);
              }
            }, ttsResult.duration + 300);
            session.pendingTimeouts.push(skipTimeout);
            
            return;
          }
        }
      } catch (error) {
        logger.debug('Failed to generate skip announcement, skipping directly');
      }
    }
    
    // No announcement - skip directly to prepared track
    session.audioPlayer.stop();
    const directSkipTimeout = setTimeout(() => {
      session.isTransitioning = false;
      playNextTrack(session);
    }, 100);
    session.pendingTimeouts.push(directSkipTimeout);
  } else {
    // Next track not ready - stop and let playNext handle it
    session.audioPlayer.stop();
  }
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
    
    // Clear any prepared random track so queued items play next
    if (session.nextItem && (!session.queue.length || session.nextItem.media !== session.queue[0].media)) {
      session.nextItem = null;
    }
    
    const primaryAnswer = mediaItem.answers && mediaItem.answers.length > 0 
      ? (typeof mediaItem.answers[0] === 'string' ? mediaItem.answers[0] : mediaItem.answers[0].answer)
      : mediaItem.title;
    
    await statusMessage.edit(`🎵 Added "${primaryAnswer}" to queue (position ${session.queue.length})`);
    
    // Generate queue request announcement
    if (session.voiceAnnouncementsEnabled) {
      try {
        const username = message.author.username || message.author.displayName || 'Someone';
        
        const queueText = await VoiceAnnouncementService.generateQueueAnnouncement(username, primaryAnswer, mediaItem);
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
    isTransitioning: false, // Initialize transitioning flag
    pendingTimeouts: [] // Initialize pending timeouts array
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
  // Only progress to next track if we're not already processing and not transitioning
  if (!session.isProcessingNext && !session.isTransitioning) {
    logger.debug('Track ended, starting playNext');
    playNext(session, channel);
  } else {
    logger.debug('Track ended but already processing/transitioning, skipping playNext');
    
    // Add safety timeout to prevent permanent stuck state
    const recoveryTimeout = setTimeout(() => {
      if (session.isActive && session.isTransitioning) {
        logger.debug('Recovery timeout: forcing transition reset');
        session.isTransitioning = false;
        session.isProcessingNext = false;
        playNext(session, channel);
      }
    }, 10000); // 10 second recovery timeout
    
    session.pendingTimeouts.push(recoveryTimeout);
  }
};

const playNext = async (session: RadioSession, channel: any) => {
  try {
    // Prevent multiple concurrent calls and transitions
    if (session.isProcessingNext || session.isTransitioning) {
      logger.debug('playNext blocked - already processing or transitioning');
      return;
    }
    
    session.isTransitioning = true;
    logger.debug('Starting playNext transition');
    
    // Clear any pending timeouts to prevent race conditions
    session.pendingTimeouts.forEach(clearTimeout);
    session.pendingTimeouts = [];
    
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
            const prepareTimeout = setTimeout(() => prepareFirstTrack(session, channel), 100);
            session.pendingTimeouts.push(prepareTimeout);
            
            // Start next track after intro completes with small buffer
            const playTimeout = setTimeout(() => {
              if (session.nextItem?.processedPath && session.isActive) {
                session.isTransitioning = false;
                playNextTrack(session);
              } else {
                // If first track isn't ready yet, wait a bit more
                const retryTimeout = setTimeout(() => {
                  if (session.nextItem?.processedPath && session.isActive) {
                    session.isTransitioning = false;
                    playNextTrack(session);
                  } else {
                    session.isTransitioning = false;
                    playNext(session, channel); // Fallback to regular flow
                  }
                }, 1000);
                session.pendingTimeouts.push(retryTimeout);
              }
            }, ttsResult.duration + 500);
            session.pendingTimeouts.push(playTimeout);
            return;
          }
        }
      } catch (error) {
        logger.debug('Failed to generate radio intro, continuing with first track');
      }
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
      logger.debug('No pre-processed item, selecting new item');
      // Select next item from queue or random
      if (session.queue.length > 0) {
        nextItem = session.queue.shift()!;
        logger.debug(`Selected item from queue: ${nextItem.type}`);
      } else {
        // Create random media item
        const randomMedia = await getRandomMedia(1);
        if (randomMedia.length === 0) {
          await channel.send('No media available');
          session.isTransitioning = false;
          return;
        }
        nextItem = {
          type: 'media',
          id: `random_${Date.now()}`,
          media: randomMedia[0],
          filters: session.nextItem?.filters || [],
          isProcessed: false
        };
        logger.debug(`Selected random media: ${nextItem.media?.title || 'Unknown'}`);
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
    
    // Generate voice announcement if enabled and both tracks are media
    if (session.voiceAnnouncementsEnabled && 
        nextItem.type === 'media' && 
        session.currentItem?.type === 'media') {
      try {
        // Pass queue requester info if available
        const queuedBy = session.queue.length > 0 && session.queue[0] === nextItem ? 
          undefined : // Don't pass username for random tracks
          undefined;  // We'd need to track this info in QueueItem to implement properly
          
        const announcementText = await VoiceAnnouncementService.generateRadioAnnouncement(
          session.currentItem.media,
          nextItem.media,
          nextItem.filters && nextItem.filters.length > 0 ? `Filters: ${nextItem.filters.join(', ')}` : undefined,
          queuedBy
        );
        
        if (announcementText) {
          const ttsResult = await VoiceAnnouncementService.generateTTSAudio(announcementText);
          
          if (ttsResult) {
            logger.debug('Playing announcement before next track');
            await updateBotNickname(session, null, '🗣️Radio Announcement');
            const resource = createAudioResource(ttsResult.path);
            session.audioPlayer.play(resource);
            
            // Store next track info and start it after announcement
            session.nextItem = { ...nextItem, isProcessed: true };
            session.nextItem.processedPath = filePath;
            
            // Schedule next track after TTS completes
            const nextTrackTimeout = setTimeout(() => {
              if (session.isActive) {
                logger.debug('Transitioning from announcement to next track');
                session.isTransitioning = false;
                playNextTrack(session);
              }
            }, ttsResult.duration + 500);
            session.pendingTimeouts.push(nextTrackTimeout);
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
    logger.debug('Playing item directly without announcement');
    session.isTransitioning = false;
    await playNextTrack(session, nextItem, filePath);
    
  } catch (error) {
    logger.error('Error in playNext', error);
    session.isTransitioning = false;
    // Only retry after a delay if not already processing
    if (!session.isProcessingNext) {
      logger.debug('Scheduling playNext retry after error');
      const retryTimeout = setTimeout(() => playNext(session, channel), 3000);
      session.pendingTimeouts.push(retryTimeout);
    }
  }
};

const playNextTrack = async (session: RadioSession, nextItem?: QueueItem, filePath?: string) => {
  try {
    // Use provided item or get from session
    const item = nextItem || session.nextItem;
    const path = filePath || session.nextItem?.processedPath;
    
    if (!item || !path) {
      logger.error('No valid track to play - missing item or path');
      // Try to recover by preparing next track
      setTimeout(() => {
        if (session.isActive && !session.isProcessingNext) {
          prepareNextTrack(session);
        }
      }, 1000);
      return;
    }
    
    if (!fs.existsSync(path)) {
      logger.error(`Track file does not exist: ${path}`);
      // Try to recover by preparing next track
      setTimeout(() => {
        if (session.isActive && !session.isProcessingNext) {
          prepareNextTrack(session);
        }
      }, 1000);
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
    // Retry after a short delay
    setTimeout(() => {
      if (session.isActive && !session.isProcessingNext) {
        prepareNextTrack(session);
      }
    }, 2000);
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
    
    // DON'T generate intermission announcements here - only in playNext
    // This prevents duplicate announcements during preparation
    
    // Process the item
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
    
    // Store processed item
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
  
  // Clear any pending timeouts to prevent race conditions
  session.pendingTimeouts.forEach(clearTimeout);
  session.pendingTimeouts = [];
  
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

    // Check filesize if available (150MB = 157286400 bytes)
    const filesize = (info as any).filesize || (info as any).filesize_approx;
    if (filesize && filesize > 157286400) {
      throw new Error(`Video too large (${Math.round(filesize / 1024 / 1024)}MB). Maximum allowed: 150MB`);
    }

    // Generate a unique filename
    const id = crypto.randomBytes(8).toString('hex');
    const ext = ('ext' in info && info.ext) ? info.ext : 'mp4';
    const tempFilePath = path.join(TEMP_EFFECTS_DIR, `yt_${id}.${ext}`);
    
    // Download the actual file
    await youtubeDl(url, {
      output: tempFilePath,
      format: 'best[ext=mp4]/best'
    });
    
    return {
      title: info.title as string,
      filePath: tempFilePath
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
    // Use the exact text without AI processing
    const announcementItem: QueueItem = {
      type: 'announcement',
      id: `announce_${Date.now()}`,
      text: announceText,
      isProcessed: false
    };
    
    session.queue.push(announcementItem);
    await message.reply(`📢 Queued announcement: "${announceText}"`);
  } catch (error) {
    logger.error('Error handling announce command');
    await message.reply('❌ Failed to create announcement');
  }
};

export const handleVoiceCommand = async (message: Message, voiceText?: string) => {
  let textToSpeak = voiceText;
  
  // If no text provided, check if replying to a message
  if (!textToSpeak && message.reference?.messageId) {
    try {
      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
      textToSpeak = repliedMessage.content;
    } catch (error) {
      logger.debug('Failed to fetch replied message');
    }
  }
  
  if (!textToSpeak) {
    await message.reply('Please provide text for the voice clip or reply to a message. Example: `NOW voice Hello everyone!`');
    return;
  }

  const statusMessage = await message.reply('🎙️ Generating voice clip...');

  try {
    // Skip AI processing and go directly to TTS
    const ttsResult = await VoiceAnnouncementService.generateTTSAudio(textToSpeak);
    
    if (ttsResult && fs.existsSync(ttsResult.path)) {
      // Send to AI channel using environment variable
      const aiChannelId = process.env.AI_CHANNEL_ID || '1369649491573215262';
      const targetChannel = message.client.channels.cache.get(aiChannelId);
      if (targetChannel && 'send' in targetChannel) {
        await targetChannel.send({
          content: `🎙️ Voice clip: "${textToSpeak}"`,
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