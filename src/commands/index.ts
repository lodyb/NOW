import { Message, Client, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { clipCommand } from './clip';
import { uploadCommand } from './upload';
import { playCommand } from './play';
import { quiz, stopQuiz, processQuizMessage } from './quiz';
import { logger } from '../utils/logger';

// Command prefix
const PREFIX = 'NOW';

/**
 * Process a Discord message and execute the appropriate command
 * @param message The Discord message
 * @param client The Discord client
 */
export async function processCommand(message: Message<boolean>, client: Client): Promise<void> {
  // Ignore messages from bots
  if (message.author.bot) return;
  
  // Process quiz message (for guesses)
  processQuizMessage(message);
  
  // Check if message starts with the command prefix
  if (!message.content.startsWith(PREFIX)) return;
  
  // Parse command and arguments
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  
  // Log command usage
  logger.info(`Command received: ${command} from ${message.author.tag} in ${message.guild?.name || 'DM'}`);
  
  try {
    // Execute the appropriate command
    switch (command) {
      case 'play':
        await playCommand(message);
        break;
        
      case 'clip':
      case 'clip=':
        await clipCommand(message);
        break;
        
      case 'quiz':
        await quiz(args, message, client);
        break;
        
      case 'stop':
        await stopQuiz(message);
        break;
        
      case 'upload':
        await uploadCommand(message, client);
        break;
        
      case 'help':
        sendHelpMessage(message);
        break;
        
      default:
        // If message only contains PREFIX, send help message
        if (message.content.trim() === PREFIX) {
          sendHelpMessage(message);
        }
        break;
    }
  } catch (error) {
    logger.error(`Error executing command ${command}: ${error instanceof Error ? error.message : String(error)}`);
    message.reply('An error occurred while processing your command. Please try again later.');
  }
}

/**
 * Send a help message with available commands
 * @param message The Discord message
 */
function sendHelpMessage(message: Message<boolean>): void {
  const channel = message.channel as TextChannel | DMChannel | NewsChannel;
  channel.send({
    embeds: [{
      title: '🎵 Otoq Bot Commands 🎵',
      description: 'All commands start with the prefix `NOW`',
      color: 0x3498db,
      fields: [
        {
          name: 'Media Playback',
          value: [
            '`NOW play [search term]` - Search and play media',
            '`NOW play [search term] {amplify=2,reverse=1}` - Play with effects',
            '`NOW clip=[duration] [search term]` - Create a clip from media',
            '`NOW clip=[duration] start=[position] [search term]` - Create a clip with custom start'
          ].join('\n')
        },
        {
          name: 'Quiz Games',
          value: [
            '`NOW quiz` - Start a quiz in your voice channel',
            '`NOW quiz {reverse=1}` - Quiz with custom effects',
            '`NOW quiz clip=4s` - Quiz with shorter clips',
            '`NOW stop` - Stop a running quiz'
          ].join('\n')
        },
        {
          name: 'Management',
          value: [
            '`NOW upload` - Get link to upload media files',
            '`NOW help` - Show this help message'
          ].join('\n')
        }
      ],
      footer: {
        text: 'Type any media title as your answer during a quiz!'
      }
    }]
  });
}