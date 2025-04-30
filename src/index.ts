import { Client, IntentsBitField, GatewayIntentBits, Partials } from 'discord.js';
import * as dotenv from 'dotenv';
import { processCommand } from './commands';
import { logger } from './utils/logger';
import { startWebServer } from './services/web/server';
import { initDB, initDirectories } from './utils/init';
import { db } from './database/connection';

// Load environment variables
dotenv.config();

// Create Discord client with appropriate intents
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildVoiceStates,
    IntentsBitField.Flags.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// Handle bot ready event
client.once('ready', async () => {
  logger.info(`Logged in as ${client.user?.tag}`);
  
  // Initialize directories
  initDirectories();
  
  // Initialize the database if needed
  try {
    await initDB();
    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error(`Database initialization error: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Start the web server for uploads
  const webPort = parseInt(process.env.WEB_PORT || '3000', 10);
  try {
    await startWebServer(webPort);
    logger.info(`Web server started on port ${webPort}`);
  } catch (error) {
    logger.error(`Web server error: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Set bot activity
  client.user?.setActivity('NOW help', { type: 2 }); // 2 = Listening to
});

// Handle message events
client.on('messageCreate', async (message) => {
  try {
    await processCommand(message, client);
  } catch (error) {
    logger.error(`Error processing message: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// Handle voice state updates (for auto-disconnect when alone in voice channel)
client.on('voiceStateUpdate', (oldState, newState) => {
  try {
    // Check if the bot is in a voice channel
    const botMember = newState.guild.members.cache.get(client.user?.id || '');
    if (!botMember?.voice.channel) return;
    
    // Check if the bot is alone in the voice channel
    const voiceChannel = botMember.voice.channel;
    if (voiceChannel.members.size === 1) {
      // Bot is alone, disconnect after a delay
      setTimeout(() => {
        // Double check if still alone
        if (voiceChannel.members.size === 1) {
          botMember.voice.disconnect();
          logger.info(`Disconnected from voice in ${voiceChannel.guild.name} (${voiceChannel.name}) due to being alone`);
        }
      }, 60000); // Wait 1 minute before disconnecting
    }
  } catch (error) {
    logger.error(`Voice state update error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// Handle errors
client.on('error', (error) => {
  logger.error(`Discord client error: ${error.message}`);
});

// Login to Discord
const token = process.env.DISCORD_TOKEN;
if (!token) {
  logger.error('DISCORD_TOKEN not found in environment variables');
  process.exit(1);
}

client.login(token)
  .catch((error) => {
    logger.error(`Failed to login to Discord: ${error.message}`);
    process.exit(1);
  });

// Handle process termination
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

function handleShutdown() {
  logger.info('Shutting down...');
  
  // Close Discord client connection
  client.destroy();
  
  // Close database connection
  db.close((err) => {
    if (err) {
      logger.error(`Error closing database connection: ${err.message}`);
      process.exit(1);
    } else {
      logger.info('Database connection closed');
      process.exit(0);
    }
  });
}