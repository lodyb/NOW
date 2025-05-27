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
import path from 'path';
import fs from 'fs';

interface RadioSession {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  queue: any[];
  currentMedia: any;
  isActive: boolean;
  audioPlayer: any;
}

const activeSessions = new Map<string, RadioSession>();

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

export const handleQueueCommand = async (message: Message, searchTerm: string) => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    await message.reply('No radio session active. Start one with `NOW radio`');
    return;
  }
  
  const session = activeSessions.get(message.guild.id)!;
  
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
    isActive: true,
    audioPlayer
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
      playNext(session, message.channel);
    }
  });
  
  await message.reply(`🎵 Radio started in ${voiceChannel.name}!`);
  playNext(session, message.channel);
};

const playNext = async (session: RadioSession, channel: any) => {
  try {
    let nextMedia;
    
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
    
    session.currentMedia = nextMedia;
    
    let filePath = MediaService.resolveMediaPath(nextMedia);
    if (!MediaService.validateMediaExists(filePath) && nextMedia.filePath) {
      filePath = nextMedia.filePath;
    }
    
    if (!fs.existsSync(filePath)) {
      await channel.send(`Skipping missing file: ${nextMedia.title}`);
      playNext(session, channel);
      return;
    }
    
    const primaryAnswer = nextMedia.answers && nextMedia.answers.length > 0 
      ? nextMedia.answers[0] 
      : nextMedia.title;
    
    await channel.send(`🎵 Now playing: **${primaryAnswer}**`);
    
    const resource = createAudioResource(filePath);
    session.audioPlayer.play(resource);
    
  } catch (error) {
    logger.error('Error playing next track', error);
    setTimeout(() => playNext(session, channel), 3000);
  }
};

const endRadioSession = (session: RadioSession) => {
  session.isActive = false;
  session.queue = [];
  
  try {
    session.connection.destroy();
  } catch (error) {
    logger.error('Error disconnecting radio', error);
  }
  
  activeSessions.delete(session.guildId);
};

export const isRadioActiveInGuild = (guildId: string): boolean => {
  return activeSessions.has(guildId);
};