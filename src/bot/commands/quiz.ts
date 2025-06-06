import { Message, VoiceBasedChannel, TextBasedChannel } from 'discord.js';
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
import { processMedia, parseFilterString, normalizeMedia } from '../../media/processor';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { generateProgressiveHint, generateRandomUnicodeMask } from '../utils/helpers';
import { logger } from '../../utils/logger';
import { EmbedBuilder } from 'discord.js';

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
  filterString?: string;
  clipOptions?: { duration?: string; start?: string };
  roundLocked: boolean; // Prevents multiple answers for the same round
}

const activeSessions = new Map<string, QuizSession>();

// Function to check if a quiz is active in a guild
export const isQuizActiveInGuild = (guildId: string): boolean => {
  return activeSessions.has(guildId) && activeSessions.get(guildId)!.isActive;
};

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
    logger.error('Error starting quiz', error);
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
  
  await message.reply('Quiz stopped.');
  endQuizSession(session, message.channel);
};

export const handleQuizAnswer = async (message: Message): Promise<boolean> => {
  if (!message.guild || !activeSessions.has(message.guild.id)) {
    return false;
  }
  
  const session = activeSessions.get(message.guild.id)!;
  if (!session.isActive || session.channelId !== message.channelId) {
    return false;
  }
  
  // Get the lowercase content for comparison
  const answer = message.content.toLowerCase().trim();
  
  logger.debug(`Quiz answer check: "${answer}" against ${session.correctAnswers.length} valid answers`);
  
  // First check exact match (case insensitive)
  if (session.correctAnswers.some(a => a.toLowerCase() === answer)) {
    await awardPoint(message, session);
    return true;
  }
  
  // Check if answer is reasonable length (at least 30% of shortest correct answer)
  const minRequiredLength = Math.min(...session.correctAnswers.map(a => a.length)) * 0.3;
  if (answer.length < minRequiredLength) {
    return false; // Answer too short, likely not a real attempt
  }
  
  // Check each correct answer with strict character-level distance
  const correctMatch = session.correctAnswers.find(correctAnswer => {
    const correctLower = correctAnswer.toLowerCase();
    
    // Calculate Levenshtein distance
    const distance = calculateLevenshteinDistance(answer, correctLower);
    const maxAllowedDistance = Math.min(2, Math.floor(correctLower.length * 0.1)); // Max 2 chars or 10% of length
    
    return distance <= maxAllowedDistance;
  });
  
  if (correctMatch) {
    await awardPoint(message, session);
    return true;
  }
  
  return false;
};

// Helper function to calculate Levenshtein distance (edit distance)
const calculateLevenshteinDistance = (str1: string, str2: string): number => {
  const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
  
  for (let i = 0; i <= str1.length; i++) {
    matrix[0][i] = i;
  }
  
  for (let j = 0; j <= str2.length; j++) {
    matrix[j][0] = j;
  }
  
  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[j][i] = matrix[j - 1][i - 1];
      } else {
        matrix[j][i] = Math.min(
          matrix[j - 1][i] + 1,     // deletion
          matrix[j][i - 1] + 1,     // insertion
          matrix[j - 1][i - 1] + 1  // substitution
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
};

const awardPoint = async (message: Message, session: QuizSession) => {
  // Prevent race condition by checking if round is already locked
  if (session.roundLocked) {
    return;
  }
  
  // Lock the round immediately to prevent multiple answers
  session.roundLocked = true;
  
  const userId = message.author.id;
  const username = message.author.username;
  
  // Add points for the current player
  if (!session.players.has(userId)) {
    // New player
    session.players.set(userId, 1);
  } else {
    // Existing player - increment their score
    session.players.set(userId, session.players.get(userId)! + 1);
  }
  
  // Update user stats in database
  await updateUserStats(userId, username, true);
  
  // Clear the hint timeout
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  
  await message.reply(`🎉 Correct! The answer is "${session.mediaItem.title}". ${username} gets a point!`);
  
  // Reset the missed rounds counter since someone answered correctly
  session.missedRounds = 0;
  
  // Move to next round after a short delay - pass the original filter parameters
  setTimeout(() => nextRound(session, message.channel, session.filterString, session.clipOptions), 3000);
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
  
  // Monitor voice connection state
  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === 'disconnected') {
      const session = activeSessions.get(voiceChannel.guild.id);
      if (session && message.channel.isSendable()) {
        message.channel.send('🔌 Bot disconnected from voice chat. Quiz ended.');
        endQuizSession(session, message.channel);
      }
    }
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
    isActive: true,
    filterString, 
    clipOptions,
    roundLocked: false
  };
  
  activeSessions.set(voiceChannel.guild.id, session);
  
  await message.reply(`Starting quiz in ${voiceChannel.name}! Get ready...`);
  
  // Monitor voice channel for empty state
  const checkVoiceMembers = setInterval(() => {
    const currentSession = activeSessions.get(voiceChannel.guild.id);
    if (!currentSession || !currentSession.isActive) {
      clearInterval(checkVoiceMembers);
      return;
    }
    
    const members = voiceChannel.members.filter(member => !member.user.bot);
    if (members.size === 0 && message.channel.isSendable()) {
      message.channel.send('📭 Everyone left the voice chat. Quiz ended.');
      endQuizSession(currentSession, message.channel);
      clearInterval(checkVoiceMembers);
    }
  }, 5000);
  
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
  
  // Unlock the round for the new round
  session.roundLocked = false;
  
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
    
    // Reset answered state for new round
    session.players.forEach((_, playerId) => {
      session.lastVisualHint = null;
    });
    
    // Get the correct file path - prefer uploads for better audio quality
    let filePath: string;
    if (session.mediaItem.filePath && fs.existsSync(session.mediaItem.filePath)) {
      // Use original upload file for better quality
      filePath = session.mediaItem.filePath;
    } else if (session.mediaItem.normalizedPath) {
      // Fallback to normalized if upload missing
      filePath = path.join(NORMALIZED_DIR, session.mediaItem.normalizedPath);
      filePath = getFixedMediaPath(filePath);
      
      if (!fs.existsSync(filePath)) {
        filePath = await ensureNormalizedFileExists(session.mediaItem);
      }
    } else {
      throw new Error('Media item has no file path');
    }
    
    // Apply filters or clip options if provided
    // We use the parameters passed to this function which persists from the initial quiz setup
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
        logger.error('Error processing media for quiz', error);
        await channel.send(`Error applying filters: ${(error as Error).message}`);
        return;
      }
    }
    
    if (!fs.existsSync(filePath)) {
      await channel.send(`Error: Media file not found at ${filePath}`);
      // Skip to next round when file not found
      setTimeout(() => nextRound(session, channel, filterString, clipOptions), 3000);
      return;
    }
    
    await channel.send(`🎵 **Round ${session.currentRound}**: What is this?`);
    
    // Create initial masked title hint
    const maskedTitle = generateRandomUnicodeMask(session.mediaItem.title);
    await channel.send(`Hint: ${maskedTitle}`);
    
    // Force start hint progression immediately
    // This ensures hints begin regardless of audio player status
    session.timeout = setTimeout(() => {
      session.revealPercentage = 0; // Start from 0%
      const hint = generateProgressiveHint(session.mediaItem.title, session.revealPercentage);
      channel.send(`Hint: ${hint}`).catch(logger.error);
      scheduleHint(session, channel);
    }, 20000); // First progressive hint after 20 seconds
    
    // Play the audio
    const audioPlayer = createAudioPlayer();
    const resource = createAudioResource(filePath);
    
    session.connection.subscribe(audioPlayer);
    audioPlayer.play(resource);
    
    // Calculate clip duration if specified
    let clipDuration = 30; // Default 30 seconds
    if (clipOptions?.duration) {
      // Parse duration like "5s" to seconds
      const durationMatch = clipOptions.duration.match(/^(\d+)s$/);
      if (durationMatch) {
        clipDuration = parseInt(durationMatch[1], 10);
      }
    }
    
    // When the audio ends, wait 10 seconds before moving to the next hint
    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (session.isActive) {
        // Clear any existing hint schedule
        if (session.timeout) {
          clearTimeout(session.timeout);
        }
        
        // Let users know the audio has ended and they have time to answer
        channel.send("🎵 Audio finished! You have 10 seconds to answer...").catch(logger.error);
        
        // Schedule first hint after audio ends (including visual hint)
        session.timeout = setTimeout(() => {
          // Show visual hint after audio finishes
          showVisualHint(session, channel);
          
          // Provide progressive hint
          const hint = generateProgressiveHint(session.mediaItem.title, session.revealPercentage);
          channel.send(`Hint: ${hint}`).catch(logger.error);
          
          // Continue with regular hint scheduling
          scheduleHint(session, channel);
        }, 20000); // 20 seconds wait after audio ends
      }
    });
  } catch (error) {
    logger.error('Error in quiz round', error);
    await channel.send(`An error occurred: ${(error as Error).message}`);
    endQuizSession(session, channel);
  }
};

// Helper function to normalize file paths and handle duplicated paths
const getFixedMediaPath = (mediaPath: string): string => {
  // Fix duplicated paths (like /media/enka/NOW/normalized/media/enka/NOW/normalized/...)
  const normalizedDir = NORMALIZED_DIR.replace(/\\/g, '/');
  const pattern = new RegExp(`(${normalizedDir.replace(/\//g, '\\/').replace(/\\/g, '\\\\')})\\/+${normalizedDir.replace(/\//g, '\\/').replace(/\\/g, '\\\\')}`, 'gi');
  
  // Replace duplicated paths with a single path
  return mediaPath.replace(pattern, normalizedDir);
};

// Helper function to regenerate normalized file if missing
const ensureNormalizedFileExists = async (mediaItem: any): Promise<string> => {
  if (!mediaItem.normalizedPath) return '';
  
  const normalizedPath = path.join(NORMALIZED_DIR, mediaItem.normalizedPath);
  
  // Check if file exists
  if (!fs.existsSync(normalizedPath) && mediaItem.filePath) {
    // Original file path
    const origPath = path.join(UPLOADS_DIR, path.basename(mediaItem.filePath));
    
    if (fs.existsSync(origPath)) {
      logger.info(`Regenerating missing normalized file: ${normalizedPath}`);
      try {
        // Regenerate the normalized file
        return await normalizeMedia(origPath);
      } catch (error) {
        logger.error(`Failed to regenerate normalized file`, error);
      }
    }
  }
  
  return normalizedPath;
};

const scheduleHint = (session: QuizSession, channel: any) => {
  // Clear existing timeout
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  
  // Schedule new hint
  session.timeout = setTimeout(async () => {
    try {
      // Increment reveal percentage - increased from 15% to 25% for faster hints
      session.revealPercentage += 25;
      
      if (session.revealPercentage >= 90) {
        // No one got it, move to next round
        await channel.send(`Time's up! The answer was "${session.mediaItem.title}"`);
        session.missedRounds++;
        
        if (session.missedRounds >= 2) {
          // End game after 2 consecutive rounds of inactivity
          await channel.send('Game over! No one has responded for 2 rounds in a row.');
          endQuizSession(session, channel);
        } else {
          setTimeout(() => nextRound(session, channel), 3000);
        }
      } else {
        // Provide progressive hint
        const hint = generateProgressiveHint(session.mediaItem.title, session.revealPercentage);
        await channel.send(`Hint: ${hint}`);
        
        logger.debug(`Sent progressive hint with reveal percentage: ${session.revealPercentage}%`);
        
        // 25% chance to show a visual hint during hint cycle (in addition to round start)
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
            logger.error('Error providing visual hint', error);
          }
        } else if (Math.random() < 0.25 && session.lastVisualHint) {
          // Reset the lastVisualHint so we can show another one next time
          session.lastVisualHint = null;
        }
        
        // Always schedule next hint as long as we haven't reached 90%
        scheduleHint(session, channel);
      }
    } catch (error) {
      logger.error("Error in scheduleHint", error);
      // Try to recover by scheduling the next hint anyway
      if (session.isActive && session.revealPercentage < 90) {
        scheduleHint(session, channel);
      }
    }
  }, 20000); // 20 seconds between hints
};

const endQuizSession = async (session: QuizSession, channel?: any) => {
  session.isActive = false;
  
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  
  // Show final scores if channel is provided
  if (channel && session.players.size > 0) {
    const embed = createScoreEmbed(session);
    await channel.send({ embeds: [embed] });
  }
  
  try {
    session.connection.destroy();
  } catch (error) {
    logger.error('Error disconnecting from voice', error);
  }
  
  activeSessions.delete(session.guildId);
};

const createScoreEmbed = (session: QuizSession): EmbedBuilder => {
  const embed = new EmbedBuilder()
    .setTitle('🏆 Quiz Final Scores')
    .setColor(0x00AE86)
    .setTimestamp();

  if (session.players.size === 0) {
    embed.setDescription('No one scored any points.');
    return embed;
  }

  const sortedPlayers = [...session.players.entries()]
    .sort((a, b) => b[1] - a[1]);

  // Add fields for each player
  sortedPlayers.forEach(([userId, score], index) => {
    const position = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    embed.addFields({
      name: `${position} Player`,
      value: `<@${userId}>\n**${score}** point${score !== 1 ? 's' : ''}`,
      inline: true
    });
  });

  embed.setFooter({ text: `Total rounds: ${session.currentRound}` });
  
  return embed;
};

// Helper function to show visual hints
const showVisualHint = async (session: QuizSession, channel: any) => {
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
    logger.error('Error providing visual hint', error);
  }
};
