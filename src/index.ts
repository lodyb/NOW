import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { initDatabase } from './database/db';
import { parseCommand } from './bot/utils/helpers';
import { handlePlayCommand } from './bot/commands/play';
import { handleQuizCommand, handleStopCommand, handleQuizAnswer } from './bot/commands/quiz';
import { handleUploadCommand } from './bot/commands/upload';
import { handleImageCommand } from './bot/commands/image';
import apiRoutes from './web/api';
import { generateThumbnailsForExistingMedia, scanAndProcessUnprocessedMedia } from './media/processor';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Express middlewares
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'web/public')));
app.use('/thumbnails', express.static(path.join(__dirname, '../thumbnails')));
app.use('/media/normalized', express.static(path.join(__dirname, '../normalized')));
app.use('/media/uploads', express.static(path.join(__dirname, '../uploads')));

// API routes
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

// Message handling
client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;
  
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
            commandArgs.clipOptions
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
          
        default:
          // Unrecognized command
          await message.reply('Unknown command. Type `NOW play`, `NOW quiz`, `NOW image`, or `NOW upload`.');
      }
    } catch (error) {
      console.error('Error handling command:', error);
      await message.reply(`An error occurred: ${(error as Error).message}`);
    }
  } else {
    // Handle potential quiz answers (all non-command messages)
    await handleQuizAnswer(message);
  }
});

// Main initialization function
async function init() {
  try {
    // Initialize database
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