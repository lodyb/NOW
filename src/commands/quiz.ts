import { Message, Client, VoiceBasedChannel, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  VoiceConnection,
  AudioPlayer,
  StreamType,
  DiscordGatewayAdapterCreator
} from '@discordjs/voice';
import { logger } from '../utils/logger';
import path from 'path';
import fs from 'fs';
import Fuse from 'fuse.js';
import { processMedia } from '../services/media/processor';
import { createClip as clipperCreateClip } from '../services/media/clipper';
// Import libsodium-wrappers for voice encryption
import sodium from 'libsodium-wrappers';

// Import our new database repositories
import { Media } from '../database/types';
import { getRandomMedia, getMediaCount } from '../database/repositories/mediaRepository';
import { saveGameSession, updateGameSessionRound, endGameSession } from '../database/repositories/gameSessionRepository';
import { findUserById, saveUser, incrementUserStats } from '../database/repositories/userRepository';

// Map to store active quiz sessions
const activeQuizzes = new Map<string, QuizSession>();

// Interface for quiz settings
interface QuizSettings {
  filters?: Record<string, string>;
  clipDuration?: number;
  startPosition?: number;
}

// Quiz session class to manage a running quiz
class QuizSession {
  readonly channelId: string;
  readonly guildId: string;
  readonly voiceChannel: VoiceBasedChannel;
  private currentRound: number = 0;
  private roundsWithoutGuess: number = 0;
  private currentMedia?: Media;
  private connection: VoiceConnection;
  private player: AudioPlayer;
  private scores: Map<string, number> = new Map();
  private activeHints: string[] = [];
  private guessedUsers: Set<string> = new Set();
  private gameSessionId?: number;
  private readonly settings: QuizSettings;
  private roundTimer?: NodeJS.Timeout;
  private hintTimer?: NodeJS.Timeout;
  private isActive: boolean = false;

  constructor(voiceChannel: VoiceBasedChannel, settings: QuizSettings = {}) {
    this.voiceChannel = voiceChannel;
    this.channelId = voiceChannel.id;
    this.guildId = voiceChannel.guild.id;
    this.settings = settings;
    
    // Create a default connection and player (will be properly initialized in start())
    this.connection = {} as VoiceConnection;
    this.player = {} as AudioPlayer;
  }

  /**
   * Helper function to resolve file path correctly
   */
  private resolveMediaPath(filePath: string): string {
    // If the path is already an absolute path, use it directly
    if (filePath.startsWith('/')) {
      // This is an absolute path, so just return it
      logger.info(`Using absolute path directly: ${filePath}`);
      return filePath;
    }
    
    const normalizedDir = process.env.NORMALIZED_DIR || './normalized';
    
    // Check if the path already includes the normalized directory
    if (filePath.startsWith('normalized/') || filePath.startsWith('./normalized/')) {
      // Path already contains the normalized prefix, just resolve from project root
      const resolvedPath = path.resolve(process.cwd(), filePath);
      logger.info(`Resolved normalized path: ${resolvedPath}`);
      return resolvedPath;
    } else {
      // Path doesn't contain the prefix, join with normalized directory
      const resolvedPath = path.resolve(normalizedDir, filePath);
      logger.info(`Joined with normalized directory: ${resolvedPath}`);
      return resolvedPath;
    }
  }

  /**
   * Starts the quiz
   */
  async start(message: Message<boolean>): Promise<void> {
    try {
      // Ensure sodium is ready before creating voice connection
      await sodium.ready;
      logger.info('Sodium encryption library loaded and ready');
      
      // Join the voice channel
      this.connection = joinVoiceChannel({
        channelId: this.voiceChannel.id,
        guildId: this.voiceChannel.guild.id,
        adapterCreator: this.voiceChannel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
        selfDeaf: false
      });

      // Create an audio player with better fallback behavior
      this.player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play
        }
      });
      
      this.connection.subscribe(this.player);

      // Create a new game session in the database using our repository
      const gameSessionId = await saveGameSession({
        guildId: this.guildId,
        channelId: this.channelId,
        rounds: 0,
        currentRound: 1
      });
      
      this.gameSessionId = gameSessionId;

      // Indicate we're active now
      this.isActive = true;

      // Send welcome message
      const textChannel = message.channel as TextChannel | DMChannel | NewsChannel;
      await textChannel.send({
        embeds: [{
          title: '🎵 Music Quiz Started! 🎵',
          description: 'Get ready to guess song titles! Type your answers in the chat.\n' +
            'The first person to correctly guess the title gets a point.\n' +
            'Type `NOW stop` to end the quiz early.',
          color: 0x3498db,
          fields: [
            {
              name: 'Rules',
              value: 'I\'ll play a song, and you need to guess the title.\n' +
                'Hints will appear if nobody guesses correctly.\n' +
                'The quiz will end after 2 rounds with no correct guesses.'
            }
          ],
          footer: { text: 'Quiz will begin in 5 seconds...' }
        }]
      });

      // Wait 5 seconds, then start the first round
      setTimeout(() => this.nextRound(textChannel), 5000);
    } catch (error) {
      logger.error('Error starting quiz:', error);
      const textChannel = message.channel as TextChannel | DMChannel | NewsChannel;
      textChannel.send('There was an error starting the quiz. Please try again later.');
      this.stop(textChannel);
    }
  }

  /**
   * Stops the quiz and cleans up
   */
  async stop(channel: any): Promise<void> {
    if (!this.isActive) return;
    
    this.isActive = false;
    
    // Clear timers
    if (this.roundTimer) clearTimeout(this.roundTimer);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    
    // Update game session in database using our repository
    if (this.gameSessionId) {
      await endGameSession(this.gameSessionId, this.currentRound);
    }
    
    // Disconnect from voice
    if (this.connection) {
      this.connection.destroy();
    }
    
    // Show final scores
    const sortedScores = [...this.scores.entries()]
      .sort((a, b) => b[1] - a[1]);
    
    let scoreText = 'No points were scored.';
    
    if (sortedScores.length > 0) {
      scoreText = sortedScores
        .map(([userId, score], index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
          return `${medal} <@${userId}>: ${score} point${score === 1 ? '' : 's'}`;
        })
        .join('\n');
    }
    
    // Update user stats in database
    for (const [userId, score] of this.scores.entries()) {
      try {
        // Using our repository to find and update user
        const user = await findUserById(userId);
        
        if (user) {
          // Update existing user
          await incrementUserStats(userId, score, 1);
        } else {
          // Get username from the guild
          const member = await this.voiceChannel.guild.members.fetch(userId);
          const username = member?.displayName || 'Unknown User';
          
          // Create a new user
          await saveUser({
            id: userId,
            username: username,
            correctAnswers: score,
            gamesPlayed: 1
          });
        }
      } catch (error) {
        logger.error(`Error updating stats for user ${userId}:`, error);
      }
    }
    
    // Send final message
    channel.send({
      embeds: [{
        title: '🏁 Quiz Finished! 🏁',
        description: `The quiz has ended after ${this.currentRound} round${this.currentRound === 1 ? '' : 's'}.`,
        color: 0x2ecc71,
        fields: [
          {
            name: 'Final Scores',
            value: scoreText
          }
        ]
      }]
    });
    
    // Remove from active quizzes
    activeQuizzes.delete(this.channelId);
  }

  /**
   * Start the next round
   */
  async nextRound(channel: any): Promise<void> {
    if (!this.isActive) return;
    
    try {
      this.currentRound++;
      this.guessedUsers.clear();
      this.activeHints = [];
      
      logger.info(`Starting quiz round ${this.currentRound}`);
      
      // Update game session in database using our repository
      if (this.gameSessionId) {
        try {
          await updateGameSessionRound(this.gameSessionId, this.currentRound);
          logger.info(`Updated game session ${this.gameSessionId} to round ${this.currentRound}`);
        } catch (dbError) {
          logger.error(`Database error updating game session: ${dbError}`);
          channel.send('There was a database error. The quiz may not function correctly.');
        }
      }
      
      // Get a random media item from the database using our repository
      try {
        const count = await getMediaCount();
        logger.info(`Found ${count} media items in database`);
        
        if (count === 0) {
          channel.send('There are no media files in the database. The quiz cannot continue.');
          this.stop(channel);
          return;
        }
        
        // Get a random media item
        const mediaList = await getRandomMedia(1);
        
        if (!mediaList.length) {
          logger.error('Failed to fetch media item from database');
          channel.send('Failed to fetch a media item. The quiz cannot continue.');
          this.stop(channel);
          return;
        }
        
        logger.info(`Successfully fetched media: ${mediaList[0].title}, ID: ${mediaList[0].id}`);
        this.currentMedia = mediaList[0];
      } catch (mediaError) {
        logger.error(`Error fetching media from database: ${mediaError}`);
        channel.send('There was an error accessing the media database. The quiz cannot continue.');
        this.stop(channel);
        return;
      }
      
      // Try to find the file - prioritize uncompressed path for higher quality quiz audio
      // Fall back to normalized path, then original path if necessary
      let filePath = this.currentMedia.normalizedPath || this.currentMedia.filePath;
      logger.info(`Using media file path: ${filePath}`);
      
      const fullPath = this.resolveMediaPath(filePath);
      logger.info(`Looking for media file at resolved path: ${fullPath}`);
      
      try {
        if (!fs.existsSync(fullPath)) {
          logger.error(`File for media ID ${this.currentMedia.id} not found at ${fullPath}`);
          logger.info('Trying fallback paths...');
          
          // Try fallback paths if the selected path doesn't exist
          const fallbackPaths = [
            this.currentMedia.filePath,
            this.currentMedia.normalizedPath
          ].filter(p => p && p !== filePath);
          
          let fallbackFound = false;
          for (const fbPath of fallbackPaths) {
            if (!fbPath) continue;
            
            const fbFullPath = this.resolveMediaPath(fbPath);
            logger.info(`Trying fallback path: ${fbFullPath}`);
            
            if (fs.existsSync(fbFullPath)) {
              logger.info(`Using fallback path: ${fbFullPath}`);
              filePath = fbPath;
              fallbackFound = true;
              break;
            }
          }
          
          if (!fallbackFound) {
            channel.send('The media file for this round could not be found. Skipping to next round...');
            this.roundTimer = setTimeout(() => this.nextRound(channel), 3000);
            return;
          }
        }
        
        // Check if the file is readable
        const fileToUse = this.resolveMediaPath(filePath);
        try {
          fs.accessSync(fileToUse, fs.constants.R_OK);
          logger.info(`Media file found and is readable: ${fileToUse}`);
        } catch (accessError) {
          logger.error(`File exists but is not readable: ${fileToUse}. Error: ${accessError}`);
          channel.send('The media file exists but cannot be read. Skipping to next round...');
          this.roundTimer = setTimeout(() => this.nextRound(channel), 3000);
          return;
        }
      } catch (fsError) {
        logger.error(`Error checking if file exists: ${fsError}`);
        channel.send('There was an error checking if the media file exists. Skipping to next round...');
        this.roundTimer = setTimeout(() => this.nextRound(channel), 3000);
        return;
      }
      
      // Process file with any filters or clip it if needed
      let fileToPlay = this.resolveMediaPath(filePath);
      
      // Apply both filters and clipping if needed
      if (Object.keys(this.settings.filters || {}).length > 0 || this.settings.clipDuration) {
        channel.send('Processing media for this round...');
        
        try {
          // First apply filters if any
          if (Object.keys(this.settings.filters || {}).length > 0) {
            fileToPlay = await processMedia(fileToPlay, this.settings.filters || {});
            logger.info(`Applied filters to media, new path: ${fileToPlay}`);
          }
          
          // Then clip if needed
          if (this.settings.clipDuration) {
            fileToPlay = await clipperCreateClip(
              fileToPlay, 
              this.settings.clipDuration, 
              this.settings.startPosition
            );
            logger.info(`Clipped media, new path: ${fileToPlay}`);
          }
        } catch (error) {
          logger.error('Error processing media for quiz:', error);
          channel.send('There was an error processing the media for this round. Using the original file instead.');
          fileToPlay = this.resolveMediaPath(filePath);
        }
      }
      
      // Send round message
      channel.send({
        embeds: [{
          title: `Round ${this.currentRound}`,
          description: 'Guess the title of this track!',
          color: 0x3498db
        }]
      });
      
      try {
        logger.info(`Attempting to play audio file: ${fileToPlay}`);
        
        // Check voice connection state
        if (!this.connection || !this.connection.state || this.connection.state.status === VoiceConnectionStatus.Disconnected) {
          logger.error('Voice connection is disconnected or invalid');
          channel.send('Lost connection to the voice channel. Attempting to reconnect...');
          
          try {
            // Ensure sodium is ready before reconnecting
            await sodium.ready;
            logger.info('Sodium encryption library loaded for reconnection');
            
            // Attempt to rejoin the voice channel
            this.connection = joinVoiceChannel({
              channelId: this.voiceChannel.id,
              guildId: this.voiceChannel.guild.id,
              adapterCreator: this.voiceChannel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
              selfDeaf: false
            });
            
            this.connection.subscribe(this.player);
            logger.info('Successfully reconnected to voice channel');
          } catch (reconnectError) {
            logger.error(`Failed to reconnect to voice channel: ${reconnectError}`);
            channel.send('Could not reconnect to the voice channel. The quiz will be stopped.');
            this.stop(channel);
            return;
          }
        }
        
        // Create a resource from the file with proper options for better compatibility
        const resource = createAudioResource(fileToPlay, {
          inlineVolume: true,
          inputType: this.getInputType(fileToPlay)
        });
        
        // Set volume to ensure it's audible
        if (resource.volume) {
          resource.volume.setVolume(1);
        }
      
        // Play the resource
        this.player.play(resource);
        logger.info('Audio resource is now playing');
        
        // Set up a listener for when the audio finishes playing
        this.player.once(AudioPlayerStatus.Idle, () => {
          logger.info('Audio finished playing');
        });
      } catch (error) {
        logger.error(`Error playing audio file: ${error}`);
        channel.send('There was an error playing the media. Continuing with the quiz...');
      }
      
      // Set up a timer for hints
      this.setupHintTimer(channel);
      
      // Set up a timer to move to the next round if no one guesses
      this.roundTimer = setTimeout(() => this.handleRoundEnd(channel), 60000);
      
    } catch (error) {
      logger.error('Error in quiz round:', error);
      channel.send('There was an error in this quiz round. Trying next round...');
      this.roundTimer = setTimeout(() => this.nextRound(channel), 3000);
    }
  }

  // Helper method to determine input type based on file extension
  private getInputType(filePath: string): any {
    const ext = path.extname(filePath).toLowerCase();
    // Check if this is an opus file which needs special handling
    if (ext === '.opus') {
      return 'opus';
    }
    return 'arbitrary';
  }

  /**
   * Setup hint timer to reveal hints gradually
   */
  private setupHintTimer(channel: any): void {
    if (!this.currentMedia || !this.isActive) return;
    
    // Clear existing hint timer
    if (this.hintTimer) clearTimeout(this.hintTimer);
    
    // Schedule the first hint after 15 seconds
    this.hintTimer = setTimeout(() => {
      if (!this.currentMedia || !this.isActive) return;
      
      // Create a partial reveal of the title
      const title = this.currentMedia.title;
      const hint = this.generatePartialTitle(title, 0.3); // Reveal 30% of characters
      
      channel.send({
        embeds: [{
          title: 'Hint!',
          description: `Title: ${hint}`,
          color: 0xe74c3c
        }]
      });
      
      this.activeHints.push(hint);
      
      // Schedule the second hint after another 15 seconds
      this.hintTimer = setTimeout(() => {
        if (!this.currentMedia || !this.isActive) return;
        
        // More revealing hint
        const hint2 = this.generatePartialTitle(title, 0.6); // Reveal 60% of characters
        
        channel.send({
          embeds: [{
            title: 'Another Hint!',
            description: `Title: ${hint2}`,
            color: 0xe74c3c
          }]
        });
        
        this.activeHints.push(hint2);
      }, 15000);
      
    }, 15000);
  }

  /**
   * Generate a partially revealed title
   */
  private generatePartialTitle(title: string, revealPercentage: number): string {
    const masks = ['▒', '░', '█', '▓', '■', '●', '◆', '✖'];
    const mask = masks[Math.floor(Math.random() * masks.length)];

    const charsToReveal = Math.ceil(title.length * revealPercentage);
    const positions = new Set<number>();
    
    // Always reveal spaces
    for (let i = 0; i < title.length; i++) {
      if (title[i] === ' ') positions.add(i);
    }
    
    // Randomly select positions to reveal
    while (positions.size < charsToReveal) {
      const pos = Math.floor(Math.random() * title.length);
      positions.add(pos);
    }
    
    // Build the hint string
    let hint = '';
    for (let i = 0; i < title.length; i++) {
      if (positions.has(i)) {
        hint += title[i];
      } else {
        hint += mask;
      }
    }
    
    return hint;
  }

  /**
   * Handle a user's guess
   */
  handleGuess(message: Message<boolean>): void {
    if (!this.currentMedia || !this.isActive || this.guessedUsers.has(message.author.id)) return;
    
    const guess = message.content.trim();
    
    // Get all possible answers
    const answers = [
      this.currentMedia.title,
      ...(this.currentMedia.answers?.map(a => a.answer) || [])
    ];
    
    // Use fuzzy matching to check if the guess is close enough
    const fuse = new Fuse(answers, {
      includeScore: true,
      threshold: 0.3, // Lower threshold means more exact matching required
      location: 0,
      distance: 100,
      minMatchCharLength: 2
    });
    
    const result = fuse.search(guess);
    
    if (result.length > 0 && result[0].score !== undefined && result[0].score < 0.4) {
      // Correct guess!
      this.handleCorrectGuess(message);
    }
  }

  /**
   * Handle a correct guess
   */
  private async handleCorrectGuess(message: Message): Promise<void> {
    if (!this.currentMedia || !this.isActive) return;
    
    // Mark this user as having guessed
    this.guessedUsers.add(message.author.id);
    
    // Update score for this user
    const currentScore = this.scores.get(message.author.id) || 0;
    this.scores.set(message.author.id, currentScore + 1);
    
    // Stop the player
    this.player.stop();
    
    // Clear timers
    if (this.roundTimer) clearTimeout(this.roundTimer);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    
    // Reset the number of rounds without a guess
    this.roundsWithoutGuess = 0;
    
    // Send correct message
    const channel = message.channel as TextChannel | DMChannel | NewsChannel;
    channel.send({
      embeds: [{
        title: '🎊 Correct! 🎊',
        description: `<@${message.author.id}> guessed correctly!`,
        color: 0x2ecc71,
        fields: [
          {
            name: 'The correct answer was:',
            value: `**${this.currentMedia.title}**`
          },
          {
            name: 'Score',
            value: `<@${message.author.id}>: ${this.scores.get(message.author.id)} point${this.scores.get(message.author.id) === 1 ? '' : 's'}`
          }
        ]
      }]
    });
    
    // Start next round after 5 seconds
    this.roundTimer = setTimeout(() => this.nextRound(channel), 5000);
  }

  /**
   * Handle the end of a round when no one guessed correctly
   */
  private async handleRoundEnd(channel: any): Promise<void> {
    if (!this.currentMedia || !this.isActive) return;
    
    // Increment the counter for rounds without a guess
    this.roundsWithoutGuess++;
    
    // Stop the player
    this.player.stop();
    
    // Clear timers
    if (this.roundTimer) clearTimeout(this.roundTimer);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    
    // Send message about no correct guesses
    channel.send({
      embeds: [{
        title: '⏱️ Time\'s Up!',
        description: 'Nobody guessed the correct answer in time.',
        color: 0xe74c3c,
        fields: [
          {
            name: 'The correct answer was:',
            value: `**${this.currentMedia.title}**`
          }
        ]
      }]
    });
    
    // Check if we should end the quiz
    if (this.roundsWithoutGuess >= 2) {
      channel.send('No correct guesses for 2 rounds in a row. The quiz will now end.');
      this.stop(channel);
      return;
    }
    
    // Start next round after 5 seconds
    this.roundTimer = setTimeout(() => this.nextRound(channel), 5000);
  }
}

/**
 * Parse quiz settings from command arguments
 */
function parseQuizSettings(args: string[]): QuizSettings {
  const settings: QuizSettings = {};
  
  // Extract clip duration
  const clipArg = args.find(arg => arg.startsWith('clip='));
  if (clipArg) {
    const durationStr = clipArg.substring(5);
    const durationMatch = durationStr.match(/(\d+)([smh])?/);
    if (durationMatch) {
      let duration = parseInt(durationMatch[1]);
      const unit = durationMatch[2] || 's';
      
      // Convert to seconds based on unit
      if (unit === 'm') duration *= 60;
      if (unit === 'h') duration *= 3600;
      
      settings.clipDuration = duration;
    }
  }
  
  // Extract start position
  const startArg = args.find(arg => arg.startsWith('start='));
  if (startArg) {
    const startStr = startArg.substring(6);
    const startMatch = startStr.match(/(\d+)([smh])?/);
    if (startMatch) {
      let start = parseInt(startMatch[1]);
      const unit = startMatch[2] || 's';
      
      // Convert to seconds based on unit
      if (unit === 'm') start *= 60;
      if (unit === 'h') start *= 3600;
      
      settings.startPosition = start;
    }
  }
  
  // Extract filters
  const filtersArg = args.find(arg => arg.match(/{([^}]+)}/));
  if (filtersArg) {
    const filtersMatch = filtersArg.match(/{([^}]+)}/);
    if (filtersMatch) {
      const filtersStr = filtersMatch[1];
      const filters: Record<string, string> = {};
      
      filtersStr.split(',').forEach(filter => {
        const [key, value] = filter.split('=');
        if (key && value) {
          filters[key.trim()] = value.trim();
        }
      });
      
      if (Object.keys(filters).length > 0) {
        settings.filters = filters;
      }
    }
  }
  
  return settings;
}

/**
 * Create a clip from a media file with specified duration and start time
 */
async function createClip(
  filePath: string,
  clipDuration: number,
  startPosition?: number
): Promise<string> {
  // Use the imported createClip function from clipper.ts
  return clipperCreateClip(filePath, clipDuration, startPosition);
}

/**
 * Executes the quiz command to start a music quiz in a voice channel
 */
export async function quiz(args: string[], message: Message<boolean>, client: Client): Promise<void> {
  try {
    // Initialize sodium first before doing anything with voice
    try {
      await sodium.ready;
      logger.info('Sodium encryption library initialized for quiz command');
    } catch (sodiumError) {
      logger.error('Failed to initialize sodium:', sodiumError);
      message.reply('Could not initialize voice encryption. Make sure libsodium-wrappers is properly installed.');
      return;
    }
    
    // Check if user is in a voice channel
    const member = message.guild?.members.cache.get(message.author.id);
    const voiceChannel = member?.voice.channel;
    
    if (!voiceChannel) {
      message.reply('You must be in a voice channel to start a quiz!');
      return;
    }
    
    // Check if a quiz is already running in this channel
    if (activeQuizzes.has(voiceChannel.id)) {
      message.reply('A quiz is already running in this voice channel!');
      return;
    }
    
    // Parse quiz settings from arguments
    const settings = parseQuizSettings(args);
    
    // Create a new quiz session
    const quizSession = new QuizSession(voiceChannel, settings);
    activeQuizzes.set(voiceChannel.id, quizSession);
    
    // Start the quiz
    await quizSession.start(message);
    
    logger.info(`Quiz started in ${voiceChannel.name} (${voiceChannel.guild.name}) by ${message.author.tag}`);
  } catch (error) {
    logger.error('Error starting quiz:', error);
    message.reply('There was an error starting the quiz. Please try again later.');
  }
}

/**
 * Handle the stop command to end a quiz
 */
export async function stopQuiz(message: Message<boolean>): Promise<boolean> {
  try {
    // Check if user is in a voice channel
    const member = message.guild?.members.cache.get(message.author.id);
    const voiceChannel = member?.voice.channel;
    
    if (!voiceChannel) {
      message.reply('You must be in the same voice channel as the quiz to stop it!');
      return false;
    }
    
    // Check if a quiz is running in this channel
    const quizSession = activeQuizzes.get(voiceChannel.id);
    if (!quizSession) {
      message.reply('There is no quiz running in your voice channel!');
      return false;
    }
    
    // Stop the quiz
    await quizSession.stop(message.channel);
    message.reply('The quiz has been stopped.');
    return true;
  } catch (error) {
    logger.error('Error stopping quiz:', error);
    message.reply('There was an error stopping the quiz.');
    return false;
  }
}

/**
 * Process a message to check for quiz answers
 */
export function processQuizMessage(message: Message<boolean>): void {
  if (message.author.bot) return;
  
  try {
    // Check if user is in a voice channel
    const member = message.guild?.members.cache.get(message.author.id);
    const voiceChannel = member?.voice.channel;
    
    if (!voiceChannel) return;
    
    // Check if a quiz is running in this channel
    const quizSession = activeQuizzes.get(voiceChannel.id);
    if (!quizSession) return;
    
    // Process the guess
    quizSession.handleGuess(message);
  } catch (error) {
    logger.error('Error processing quiz message:', error);
  }
}