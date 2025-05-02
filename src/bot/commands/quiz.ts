import { Message, VoiceBasedChannel } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus, 
  entersState,
  VoiceConnection,
  getVoiceConnection,
  DiscordGatewayAdapterCreator
} from '@discordjs/voice';
import Fuse from 'fuse.js';
import { getRandomMedia, updateUserStats } from '../../database/db';
import { processMedia, parseFilterString } from '../../media/processor';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { generateProgressiveHint, generateRandomUnicodeMask } from '../utils/helpers';

// Define storage paths
const NORMALIZED_DIR = path.join(process.cwd(), 'normalized');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

interface QuizSession {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  mediaItem: any;
  correctAnswers: string[];
  currentRound: number;
  totalRounds: number;
  missedRounds: number;
  revealPercentage: number;
  players: Map<string, number>;
  timeout?: NodeJS.Timeout;
  isActive: boolean;
  lastVisualHint?: string | null;
}

const activeSessions = new Map<string, QuizSession>();

export const handleQuizCommand = async (
  message: Message, 
  filterString?: string, 
  clipOptions?: { duration?: string; start?: string }
) => {
  if (!message.guild) {
    await message.reply('This command can only be used in a server');
    return;
  }
  
  // Check if user is in a voice channel
  const member = message.guild.members.cache.get(message.author.id);
  if (!member?.voice.channel) {
    await message.reply('You need to join a voice channel first!');
    return;
  }
  
  const voiceChannel = member.voice.channel;
  
  // Check if there's already an active session in this guild
  if (activeSessions.has(message.guild.id)) {
    await message.reply('A quiz is already running in this server. Type `NOW stop` to end it.');
    return;
  }
  
  try {
    await startQuizSession(message, voiceChannel, filterString, clipOptions);
  } catch (error) {
    console.error('Error starting quiz:', error);
    await message.reply(`Failed to start quiz: ${(error as Error).message}`);
  }
};

export const handleStopCommand = async (message: Message) => {
  if (!message.guild) {
    return;
  }
  
  const session = activeSessions.get(message.guild.id);
  if (!session) {
    await message.reply('There is no active quiz to stop.');
    return;
  }
  
  endQuizSession(session);
  await message.reply('Quiz stopped. Final scores:' + formatScores(session));
};

export const handleQuizAnswer = async (message: Message) => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    return;
  }
  
  const session = activeSessions.get(message.guild.id)!;
  if (!session.isActive || session.channelId !== message.channelId) {
    return;
  }
  
  const answer = message.content.toLowerCase().trim();
  
  // First check exact match (case insensitive)
  if (session.correctAnswers.some(a => a.toLowerCase() === answer)) {
    await awardPoint(message, session);
    return;
  }
  
  // Then check fuzzy matching
  const fuse = new Fuse(session.correctAnswers, {
    includeScore: true,
    threshold: 0.5 // More lenient threshold
  });
  
  const result = fuse.search(answer);
  
  if (result.length > 0 && result[0].score! < 0.6) {
    await awardPoint(message, session);
  }
};

// Helper function to award points and move to next round
const awardPoint = async (message: Message, session: QuizSession) => {
  const userId = message.author.id;
  const username = message.author.username;
  
  // Prevent duplicate scoring
  if (!session.players.has(userId)) {
    session.players.set(userId, (session.players.get(userId) || 0) + 1);
    
    // Update user stats in database
    await updateUserStats(userId, username, true);
    
    // Clear the hint timeout
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
    
    await message.reply(`🎉 Correct! The answer is "${session.mediaItem.title}". ${username} gets a point!`);
    
    // Move to next round after a short delay
    setTimeout(() => nextRound(session, message.channel), 3000);
  }
};

const startQuizSession = async (
  message: Message,
  voiceChannel: VoiceBasedChannel,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
) => {
  // Connect to voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
  });
  
  // Create new session
  const session: QuizSession = {
    guildId: voiceChannel.guild.id,
    channelId: message.channelId,
    connection,
    mediaItem: null,
    correctAnswers: [],
    currentRound: 0,
    totalRounds: 0,
    missedRounds: 0,
    revealPercentage: 0,
    players: new Map(),
    isActive: true
  };
  
  activeSessions.set(voiceChannel.guild.id, session);
  
  await message.reply(`Starting quiz in ${voiceChannel.name}! Get ready...`);
  
  // Start first round
  await nextRound(session, message.channel, filterString, clipOptions);
};

const nextRound = async (
  session: QuizSession, 
  channel: any, 
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
) => {
  // Increment round counter
  session.currentRound++;
  session.totalRounds++;
  session.revealPercentage = 0;
  
  try {
    // Get random media
    const mediaItems = await getRandomMedia(1);
    if (mediaItems.length === 0) {
      throw new Error('No media found in database');
    }
    
    session.mediaItem = mediaItems[0];
    session.correctAnswers = [session.mediaItem.title.toLowerCase()];
    
    // Add alternate answers if available
    if (session.mediaItem.answers) {
      // Handle both string and array formats for answers
      if (typeof session.mediaItem.answers === 'string') {
        // Legacy string format with comma separator
        const altAnswers = session.mediaItem.answers.split(',').map((a: string) => a.toLowerCase());
        session.correctAnswers = [...session.correctAnswers, ...altAnswers];
      } else if (Array.isArray(session.mediaItem.answers)) {
        // New array format - could be array of strings or objects with answer property
        const altAnswers = session.mediaItem.answers.map((a: any) => {
          const answerText = typeof a === 'string' ? a : a.answer;
          return answerText.toLowerCase();
        });
        session.correctAnswers = [...session.correctAnswers, ...altAnswers];
      }
    }
    
    // Get the correct file path, considering normalized vs original path
    let filePath: string;
    if (session.mediaItem.normalizedPath) {
      // normalizedPath is just the filename
      filePath = path.join(NORMALIZED_DIR, session.mediaItem.normalizedPath);
    } else if (session.mediaItem.filePath) {
      // filePath is already the full path
      filePath = session.mediaItem.filePath;
    } else {
      throw new Error('Media item has no file path');
    }
    
    // Apply filters or clip options if provided
    if (filterString || (clipOptions && Object.keys(clipOptions).length > 0)) {
      try {
        const randomId = crypto.randomBytes(4).toString('hex');
        const outputFilename = `temp_${randomId}_${path.basename(filePath)}`;
        const options: any = {};
        
        if (filterString) {
          options.filters = parseFilterString(filterString);
        }
        
        if (clipOptions) {
          options.clip = clipOptions;
        }
        
        filePath = await processMedia(filePath, outputFilename, options);
      } catch (error) {
        console.error('Error processing media:', error);
        await channel.send(`Error applying filters: ${(error as Error).message}`);
        return;
      }
    }
    
    if (!fs.existsSync(filePath)) {
      await channel.send(`Error: Media file not found at ${filePath}`);
      return;
    }
    
    await channel.send(`🎵 **Round ${session.currentRound}**: What is this?`);
    
    // Create initial masked title hint
    const maskedTitle = generateRandomUnicodeMask(session.mediaItem.title);
    await channel.send(`Hint: ${maskedTitle}`);
    
    // Play the audio
    const audioPlayer = createAudioPlayer();
    const resource = createAudioResource(filePath);
    
    session.connection.subscribe(audioPlayer);
    audioPlayer.play(resource);
    
    // When the audio ends, wait 10 seconds before moving to the next hint
    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (session.isActive) {
        // Clear any existing hint schedule
        if (session.timeout) {
          clearTimeout(session.timeout);
        }
        
        // Let users know the audio has ended and they have time to answer
        channel.send("🎵 Audio finished! You have 10 seconds to answer...").catch(console.error);
        
        // Schedule first hint after 10 seconds
        session.timeout = setTimeout(() => {
          // Provide progressive hint
          const hint = generateProgressiveHint(session.mediaItem.title, session.revealPercentage);
          channel.send(`Hint: ${hint}`).catch(console.error);
          
          // Continue with regular hint scheduling
          scheduleHint(session, channel);
        }, 10000); // 10 seconds wait after audio ends
      }
    });
  } catch (error) {
    console.error('Error in quiz round:', error);
    await channel.send(`An error occurred: ${(error as Error).message}`);
    endQuizSession(session);
  }
};

const scheduleHint = (session: QuizSession, channel: any) => {
  // Clear existing timeout
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  
  // Schedule new hint
  session.timeout = setTimeout(async () => {
    // Increment reveal percentage
    session.revealPercentage += 15;
    
    if (session.revealPercentage >= 90) {
      // No one got it, move to next round
      await channel.send(`Time's up! The answer was "${session.mediaItem.title}"`);
      session.missedRounds++;
      
      if (session.missedRounds >= 2) {
        // End game after 2 consecutive rounds of inactivity
        await channel.send('Game over! No one has responded for 2 rounds in a row.');
        await channel.send('Final scores:' + formatScores(session));
        endQuizSession(session);
      } else {
        setTimeout(() => nextRound(session, channel), 3000);
      }
    } else {
      // Provide progressive hint
      const hint = generateProgressiveHint(session.mediaItem.title, session.revealPercentage);
      await channel.send(`Hint: ${hint}`);
      
      // 25% chance to show a visual hint (thumbnail, waveform, or spectrogram)
      if (Math.random() < 0.25 && !session.lastVisualHint) {
        try {
          // Get the correct base filename, not the full path
          const baseFilename = session.mediaItem.normalizedPath ? 
            path.basename(session.mediaItem.normalizedPath) : 
            path.basename(session.mediaItem.filePath);
          
          // Determine the type of media and available visual hints
          const isVideo = baseFilename.endsWith('.mp4');
          const hintOptions = [];
          
          if (isVideo) {
            // Generate and check full paths to thumbnail files
            const baseNameWithoutExt = baseFilename.replace('.mp4', '');
            const thumb0Path = path.join(process.cwd(), 'thumbnails', `${baseNameWithoutExt}_thumb0.jpg`);
            const thumb1Path = path.join(process.cwd(), 'thumbnails', `${baseNameWithoutExt}_thumb1.jpg`);
            
            if (fs.existsSync(thumb0Path)) hintOptions.push(thumb0Path);
            if (fs.existsSync(thumb1Path)) hintOptions.push(thumb1Path);
          } else {
            // Audio file - check for waveform/spectrogram
            const baseNameWithoutExt = baseFilename.replace('.ogg', '');
            const waveformPath = path.join(process.cwd(), 'thumbnails', `${baseNameWithoutExt}_waveform.png`);
            const spectrogramPath = path.join(process.cwd(), 'thumbnails', `${baseNameWithoutExt}_spectrogram.png`);
            
            if (fs.existsSync(waveformPath)) hintOptions.push(waveformPath);
            if (fs.existsSync(spectrogramPath)) hintOptions.push(spectrogramPath);
          }
          
          if (hintOptions.length > 0) {
            // Randomly select one of the available hints
            const selectedHint = hintOptions[Math.floor(Math.random() * hintOptions.length)];
            await channel.send({ content: 'Here\'s a visual hint:', files: [selectedHint] });
            session.lastVisualHint = selectedHint;
          }
        } catch (error) {
          console.error('Error providing visual hint:', error);
        }
      } else if (Math.random() < 0.25 && session.lastVisualHint) {
        // Reset the lastVisualHint so we can show another one next time
        session.lastVisualHint = null;
      }
      
      // Schedule next hint
      scheduleHint(session, channel);
    }
  }, 10000); // 10 seconds between hints
};

const endQuizSession = (session: QuizSession) => {
  session.isActive = false;
  
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  
  try {
    session.connection.destroy();
  } catch (error) {
    console.error('Error disconnecting from voice:', error);
  }
  
  activeSessions.delete(session.guildId);
};

const formatScores = (session: QuizSession): string => {
  if (session.players.size === 0) {
    return ' No one scored any points.';
  }
  
  const sortedPlayers = [...session.players.entries()]
    .sort((a, b) => b[1] - a[1]);
  
  return '\n' + sortedPlayers
    .map(([id, score], index) => `${index + 1}. <@${id}>: ${score} point${score !== 1 ? 's' : ''}`)
    .join('\n');
};