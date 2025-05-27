import { Client, Events, GatewayIntentBits, Partials, Message } from 'discord.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import session from 'express-session';
import passport from 'passport';
import cookieParser from 'cookie-parser';
import { initDatabase, saveUserLastCommand, getUserLastCommand, initializeJumbleTable, initializeDjTable } from './database/db';
import { parseCommand, safeReply } from './bot/utils/helpers';
import { handlePlayCommand } from './bot/commands/play';
import { handleQuizCommand, handleStopCommand, handleQuizAnswer } from './bot/commands/quiz';
import { handleUploadCommand } from './bot/commands/upload';
import { handleImageCommand } from './bot/commands/image';
import { handleWaveformCommand, handleSpectrogramCommand } from './bot/commands/visualization';
import { handleHelpCommand } from './bot/commands/help';
import { handleMahjongCommand } from './bot/commands/mahjong';
import { handleWhatWasThatCommand } from './bot/commands/whatWasThat';
import { handleEffectsCommand } from './bot/commands';
import { handleRemixCommand } from './bot/commands/remix';
import { handleFilterTestCommand } from './bot/commands/filtertest';
import { handlePxCommand, handlePxGuess } from './bot/commands/px';
import { handleMention } from './llm/mentionHandler';
import { handleGalleryCommand, handleGalleryReaction, handleGalleryReactionRemove } from './bot/commands/gallery';
import { handleBindCommand, handleEmotePlayback } from './bot/commands/bind';
import apiRoutes from './web/api';
import authRoutes from './web/auth-routes';
import { setupAuth, isAuthenticated } from './web/auth';
import { generateThumbnailsForExistingMedia, scanAndProcessUnprocessedMedia } from './media/processor';
import fs from 'fs';
import { logger } from './utils/logger';
import { handleRadioCommand, handleQueueCommand, handleRadioStop, isRadioActiveInGuild } from './bot/commands/radio';

// Load environment variables, handle both development and production paths
const envPaths = [
  '.env',                           // Current directory
  '../.env',                        // Parent directory
  path.resolve(process.cwd(), '.env'),  // Absolute path from current working directory
  path.join(__dirname, '../.env')   // Relative to __dirname
];

let envLoaded = false;

// Try each path until we find one that works
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    logger.info(`Loading environment from: ${envPath}`);
    dotenv.config({ path: envPath });
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  logger.error('No .env file found. Falling back to process.env variables.');
}

// Log loaded environment type (without exposing sensitive values)
logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
logger.info(`LLM Model: ${process.env.LLM_MODEL_NAME || '(not set)'}`);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Express middlewares
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(cookieParser());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport and session management
app.use(passport.initialize());
app.use(passport.session());
setupAuth();

// Auth routes before protected routes
app.use('/', authRoutes);

// Static files
app.use(express.static(path.join(__dirname, 'web/public')));
app.use('/thumbnails', express.static(path.join(__dirname, '../thumbnails')));
app.use('/media/normalized', express.static(path.join(__dirname, '../normalized')));
app.use('/media/uploads', express.static(path.join(__dirname, '../uploads')));

// Protected API routes - apply auth middleware
app.use('/api', isAuthenticated);
app.use('/', apiRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create a new Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Bot is ready event
client.once(Events.ClientReady, (readyClient) => {
  logger.info(`Discord bot ready! Logged in as ${readyClient.user.tag}`);
});

// Helper function to recursively collect context from reply chains
async function getReplyChainContext(message: Message, maxDepth: number = 5): Promise<string[]> {
  const contextChain: string[] = [];
  let currentMessage = message;
  let depth = 0;
  
  // Recursively trace back through the reply chain
  while (currentMessage.reference && currentMessage.reference.messageId && depth < maxDepth) {
    try {
      // Fetch the parent message
      const parentMessage = await currentMessage.channel.messages.fetch(currentMessage.reference.messageId);
      
      // Only include bot messages and user messages (skip other bot messages)
      if (parentMessage.author.id === currentMessage.client.user!.id || !parentMessage.author.bot) {
        // Add to the beginning of the array to maintain chronological order
        const authorPrefix = parentMessage.author.id === currentMessage.client.user!.id ? "Bot" : "User";
        contextChain.unshift(`${authorPrefix}: ${parentMessage.content}`);
      }
      
      // Move to the next parent message
      currentMessage = parentMessage;
      depth++;
    } catch (error) {
      logger.error('Error fetching parent message:', error);
      break;
    }
  }
  
  return contextChain;
}

// Add interaction handler for buttons
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  
  try {
    if (interaction.customId === 'px_replay') {
      // Handle px replay button
      await interaction.deferReply();
      
      // Create a fake message object for the px command
      const fakeMessage = {
        ...interaction.message,
        author: interaction.user,
        guild: interaction.guild,
        channel: interaction.channel,
        reply: async (content: any) => {
          return await interaction.followUp(content);
        }
      } as any;
      
      await handlePxCommand(fakeMessage);
    }
  } catch (error) {
    console.error('Error handling button interaction:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
    } else {
      await interaction.followUp({ content: 'An error occurred while processing your request.', ephemeral: true });
    }
  }
});

// Message handling
client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;
  
  // Check for replies to the bot's messages
  if (message.reference && message.reference.messageId) {
    try {
      // First check if this is a NOW command - if so, skip the reply handling
      const commandArgs = parseCommand(message);
      if (commandArgs) {
        logger.debug(`Command in reply detected: ${commandArgs.command}, skipping reply handler`);
        // Skip the rest of this conditional block but DO NOT RETURN
        // So we'll continue to the main command processing below
      } else {
        // Not a command, process as a reply
        const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
        
        // Case 1: Reply to the bot's message - get full conversation context
        if (repliedMessage.author.id === client.user!.id) {
          // This is a reply to the bot's message
          // Get the full context chain from all parent messages
          const contextChain = await getReplyChainContext(message);
          
          // Add the current message to the context
          contextChain.push(`User: ${message.content}`);
          
          // Format the conversation history for the model
          const conversationHistory = contextChain.join('\n');
          const contextPrompt = `Here's our conversation history:\n${conversationHistory}\n\nPlease respond to my latest message.`;
          
          logger.debug(`Processing reply to bot with context chain of ${contextChain.length} messages`);
          
          // Use the LLM handler with the full conversation context
          // Only return early if it's not a NOW command
          const isNowCommand = await handleMention(message, contextPrompt, true);
          if (!isNowCommand) {
            return; // Only exit early for AI responses, not commands
          }
        }
        // Case 2: Reply to someone else's message while mentioning the bot
        else if (message.mentions.has(client.user!)) {
          logger.debug(`Processing reply to message from ${repliedMessage.author.username} with content: ${repliedMessage.content.substring(0, 50)}...`);
          
          // User is replying to someone else's message and mentioning the bot
          const contextPrompt = `Source message: "${repliedMessage.content}" from "${repliedMessage.author.displayName}"\n\nMy message: ${message.content.replace(/<@!?\d+>/g, '').trim()}`;
          
          // Use the LLM handler with the replied message as context
          // Only return early if it's not a NOW command
          const isNowCommand = await handleMention(message, contextPrompt);
          if (!isNowCommand) {
            return; // Only return for AI processing
          }
        }
      }
    } catch (error) {
      logger.error('Error handling reply', error);
    }
  }
  
  // Handle bot mentions
  if (message.mentions.has(client.user!) && !message.author.bot) {
    try {
      await handleMention(message);
    } catch (error) {
      logger.error('Error handling mention', error);
    }
  }
  
  // Parse the command - returns null if not a NOW command
  const commandArgs = parseCommand(message);
  
  // Only log when we actually have a command to process
  if (commandArgs) {
    logger.debug(`Command detected: ${commandArgs.command}`);
  
    try {
      // Register gallery-related commands in the command switch statement
      switch (commandArgs.command) {
        case 'play':
          await handlePlayCommand(
            message, 
            commandArgs.searchTerm, 
            commandArgs.filterString, 
            commandArgs.clipOptions,
            commandArgs.multi
          );
          // Save this command to the database
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'bind':
          await handleBindCommand(
            message,
            commandArgs.searchTerm,
            commandArgs.filterString,
            commandArgs.clipOptions
          );
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'gallery':
          // Check if a user was mentioned
          let targetUser = message.mentions.users.first();
          await handleGalleryCommand(message, targetUser);
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'what was that':
        case 'whatwasthat':
          await handleWhatWasThatCommand(message);
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'image':
          await handleImageCommand(
            message,
            commandArgs.searchTerm
          );
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'quiz':
          await handleQuizCommand(
            message, 
            commandArgs.filterString, 
            commandArgs.clipOptions
          );
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'radio':
          await handleRadioCommand(message);
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'queue':
          await handleQueueCommand(message, commandArgs.searchTerm || '');
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'stop':
          // Check if radio is active first, then quiz
          if (isRadioActiveInGuild(message.guild?.id || '')) {
            await handleRadioStop(message);
          } else {
            await handleStopCommand(message);
          }
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'upload':
          await handleUploadCommand(message);
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'waveform':
          await handleWaveformCommand(
            message,
            commandArgs.searchTerm
          );
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'spectrogram':
          await handleSpectrogramCommand(
            message,
            commandArgs.searchTerm
          );
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'help':
          await handleHelpCommand(
            message,
            commandArgs.searchTerm
          );
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'mahjong':
          await handleMahjongCommand(
            message,
            commandArgs.searchTerm
          );
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'effects':
        case 'filters':
          await handleEffectsCommand(message);
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'remix':
          logger.debug(`Processing remix command with filterString: ${commandArgs.filterString || 'none'}`);
          await handleRemixCommand(
            message,
            commandArgs.filterString,
            commandArgs.clipOptions
          );
          logger.debug(`Remix command processing completed`);
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'filtertest':
          await handleFilterTestCommand(message, commandArgs.searchTerm ? commandArgs.searchTerm.split(' ') : []);
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'px':
          await handlePxCommand(message);
          await saveUserLastCommand(message.author.id, message.author.username, message.content);
          break;
          
        case 'repeat':
          // Handle the repeat command
          try {
            // Get the last command from the database
            const lastCommand = await getUserLastCommand(message.author.id);
            
            if (lastCommand) {
              // Show the user what command we're repeating
              await message.channel.send(`Repeating your last command: \`${lastCommand}\``);
              
              // Instead of creating a new Message object, manually parse and execute
              // the last command directly
              const args = parseCommand({ 
                content: lastCommand, 
                author: message.author,
                channel: message.channel,
                guild: message.guild,
                reply: message.reply.bind(message)
              } as Message);
              
              if (args) {
                // Execute the appropriate command based on parsed arguments
                switch (args.command) {
                  case 'play':
                    await handlePlayCommand(message, args.searchTerm, args.filterString, args.clipOptions, args.multi);
                    break;
                  case 'remix':
                    await handleRemixCommand(message, args.filterString, args.clipOptions);
                    break;
                  case 'quiz':
                    await handleQuizCommand(message, args.filterString, args.clipOptions);
                    break;
                  case 'image':
                    await handleImageCommand(message, args.searchTerm);
                    break;
                  case 'stop':
                    await handleStopCommand(message);
                    break;
                  case 'upload':
                    await handleUploadCommand(message);
                    break;
                  case 'what was that':
                  case 'whatwasthat':
                    await handleWhatWasThatCommand(message);
                    break;
                  case 'waveform':
                    await handleWaveformCommand(message, args.searchTerm);
                    break;
                  case 'spectrogram':
                    await handleSpectrogramCommand(message, args.searchTerm);
                    break;
                  case 'help':
                    await handleHelpCommand(message, args.searchTerm);
                    break;
                  case 'mahjong':
                    await handleMahjongCommand(message, args.searchTerm);
                    break;
                  case 'effects':
                  case 'filters':
                    await handleEffectsCommand(message);
                    break;
                  case 'px':
                    await handlePxCommand(message);
                    break;
                  default:
                    await safeReply(message, `Cannot repeat command: ${args.command}`);
                }
              } else {
                await safeReply(message, `Error: Cannot parse the previous command: ${lastCommand}`);
              }
            } else {
              await safeReply(message, 'No previous command found to repeat.');
            }
          } catch (error) {
            logger.error('Error handling repeat command', error);
            await safeReply(message, `Error: ${(error as Error).message}`);
          }
          break;
          
        default:
          // Unrecognized command
          await safeReply(message, 'Unknown command. Type `NOW help` for a list of available commands.');
      }
    } catch (error) {
      logger.error('Error handling command', error);
      // Don't attempt to send another message if we already had an error
      // This prevents the cascade of permission errors
      const discordError = error as { code?: number };
      if (discordError.code !== 50013) {
        try {
          await safeReply(message, `An error occurred: ${(error as Error).message}`);
        } catch (replyError) {
          logger.error('Failed to send error reply', replyError);
        }
      }
    }
  } else {
    // Handle potential quiz answers (all non-command messages)
    try {
      const quizAnswerHandled = await handleQuizAnswer(message);
      
      // If not a quiz answer, check for px game guesses
      if (!quizAnswerHandled) {
        const pxGuessHandled = await handlePxGuess(message);
        
        // If not a px guess, check for emotes to trigger audio playback
        if (!pxGuessHandled) {
          await handleEmotePlayback(message);
        }
      }
    } catch (error) {
      logger.error('Error handling non-command message', error);
      // Don't log permission errors for quiz answers since they're frequent
      const discordError = error as { code?: number };
      if (discordError.code !== 50013) {
        logger.error('Non-permission error in message handling', error);
      }
    }
  }
});

// Main initialization function
async function init() {
  try {
    logger.info('Initializing application...');
    
    // Initialize database
    await initDatabase();
    logger.info('Database initialized');
    
    // Initialize additional tables
    await initializeJumbleTable();
    logger.info('Jumble table initialized');
    
    await initializeDjTable();
    logger.info('DJ table initialized');
    
    // Start the web server
    app.listen(PORT, () => {
      logger.info(`Web server running on port ${PORT}`);
    });
    
    // Setup Discord event handlers
    client.on(Events.MessageReactionAdd, async (reaction, user) => {
      // Ensure the reaction emoji is a frog 🐸
      if (reaction.emoji.name === '🐸') {
        await handleGalleryReaction(reaction, user);
      }
    });
    
    client.on(Events.MessageReactionRemove, async (reaction, user) => {
      // Ensure the reaction emoji is a frog 🐸
      if (reaction.emoji.name === '🐸') {
        await handleGalleryReactionRemove(reaction, user);
      }
    });
    
    // Log in to Discord
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error('Missing DISCORD_TOKEN environment variable');
    }
    
    await client.login(token);
  } catch (error) {
    logger.error('Initialization error', error);
    process.exit(1);
  }
}

// Start the application
init().catch(console.error);