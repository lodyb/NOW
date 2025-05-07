import { Client, Events, GatewayIntentBits, Partials, Message } from 'discord.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import session from 'express-session';
import passport from 'passport';
import cookieParser from 'cookie-parser';
import { initDatabase } from './database/db';
import { parseCommand, safeReply } from './bot/utils/helpers';
import { handlePlayCommand } from './bot/commands/play';
import { handleQuizCommand, handleStopCommand, handleQuizAnswer } from './bot/commands/quiz';
import { handleUploadCommand } from './bot/commands/upload';
import { handleImageCommand } from './bot/commands/image';
import { handleWaveformCommand, handleSpectrogramCommand } from './bot/commands/visualization';
import { handleHelpCommand } from './bot/commands/help';
import { handleMahjongCommand } from './bot/commands/mahjong';
import { handleEffectsCommand } from './bot/commands';
import { handleMention } from './llm/mentionHandler';
import apiRoutes from './web/api';
import authRoutes from './web/auth-routes';
import { setupAuth, isAuthenticated } from './web/auth';
import { generateThumbnailsForExistingMedia, scanAndProcessUnprocessedMedia } from './media/processor';
import fs from 'fs';

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
    console.log(`Loading environment from: ${envPath}`);
    dotenv.config({ path: envPath });
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  console.warn('No .env file found. Falling back to process.env variables.');
}

// Log loaded environment type (without exposing sensitive values)
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`LLM Model: ${process.env.LLM_MODEL_NAME || '(not set)'}`);

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
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
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
      console.error('Error fetching parent message:', error);
      break;
    }
  }
  
  return contextChain;
}

// Message handling
client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;
  
  // Check for replies to the bot's messages
  if (message.reference && message.reference.messageId) {
    try {
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
        
        // Use the LLM handler with the full conversation context
        await handleMention(message, contextPrompt);
        return;
      }
      // Case 2: Reply to someone else's message while mentioning the bot
      else if (message.mentions.has(client.user!)) {
        // User is replying to someone else's message and mentioning the bot
        const contextPrompt = `Source message: "${repliedMessage.content}" from "${repliedMessage.author.displayName}"\n\nMy message: ${message.content.replace(/<@!?\d+>/g, '').trim()}`;
        
        // Use the LLM handler with the replied message as context
        await handleMention(message, contextPrompt);
        return;
      }
    } catch (error) {
      console.error('Error handling reply:', error);
    }
  }
  
  // Check if message is mentioning the bot
  if (message.mentions.has(client.user!)) {
    try {
      await handleMention(message);
      return; // Exit early if it's a mention
    } catch (error) {
      console.error('Error handling mention:', error);
    }
  }
  
  // Parse the command - returns null if not a NOW command
  const commandArgs = parseCommand(message);
  
  // Handle different commands
  if (commandArgs) {
    try {
      console.log(`Command received: ${commandArgs.command}`, commandArgs);
      
      switch (commandArgs.command) {
        case 'play':
          await handlePlayCommand(
            message, 
            commandArgs.searchTerm, 
            commandArgs.filterString, 
            commandArgs.clipOptions,
            commandArgs.multi
          );
          break;
          
        case 'image':
          await handleImageCommand(
            message,
            commandArgs.searchTerm
          );
          break;
          
        case 'quiz':
          await handleQuizCommand(
            message, 
            commandArgs.filterString, 
            commandArgs.clipOptions
          );
          break;
          
        case 'stop':
          await handleStopCommand(message);
          break;
          
        case 'upload':
          await handleUploadCommand(message);
          break;
          
        case 'waveform':
          await handleWaveformCommand(
            message,
            commandArgs.searchTerm
          );
          break;
          
        case 'spectrogram':
          await handleSpectrogramCommand(
            message,
            commandArgs.searchTerm
          );
          break;
          
        case 'help':
          await handleHelpCommand(
            message,
            commandArgs.searchTerm
          );
          break;
          
        case 'mahjong':
          await handleMahjongCommand(
            message,
            commandArgs.searchTerm
          );
          break;
          
        case 'effects':
        case 'filters':
          await handleEffectsCommand(message);
          break;
          
        default:
          // Unrecognized command
          await safeReply(message, 'Unknown command. Type `NOW help` for a list of available commands.');
      }
    } catch (error) {
      console.error('Error handling command:', error);
      // Don't attempt to send another message if we already had an error
      // This prevents the cascade of permission errors
      const discordError = error as { code?: number };
      if (discordError.code !== 50013) {
        try {
          await safeReply(message, `An error occurred: ${(error as Error).message}`);
        } catch (replyError) {
          console.error('Failed to send error reply:', replyError);
        }
      }
    }
  } else {
    // Handle potential quiz answers (all non-command messages)
    try {
      await handleQuizAnswer(message);
    } catch (error) {
      console.error('Error handling quiz answer:', error);
      // Don't log permission errors for quiz answers since they're frequent
      const discordError = error as { code?: number };
      if (discordError.code !== 50013) {
        console.error(error);
      }
    }
  }
});

// Main initialization function
async function init() {
  try {
    await initDatabase();
    console.log('Database initialized');
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`Web server running on port ${PORT}`);
      console.log(`Media manager available at http://localhost:${PORT}/`);
      
      // Scan for media that needs processing (files that exist in DB but not normalized)
      console.log('Starting scan for unprocessed media...');
      scanAndProcessUnprocessedMedia()
        .then(() => console.log('Media processing scan completed'))
        .catch(error => console.error('Error processing media files:', error));
      
      // Generate thumbnails for existing videos without them
      generateThumbnailsForExistingMedia()
        .catch(error => console.error('Error generating thumbnails:', error));
    });
    
    // Log in to Discord
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error('Missing DISCORD_TOKEN environment variable');
    }
    
    await client.login(token);
  } catch (error) {
    console.error('Initialization error:', error);
    process.exit(1);
  }
}

// Start the application
init().catch(console.error);