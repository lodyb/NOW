import { Message } from 'discord.js';
import { safeReply } from '../utils/helpers';

// Define a type for help content structure
type HelpCategory = {
  title: string;
  description: string;
  commands: Array<{ name: string; description: string }>;
  footer: string;
};

type HelpContent = {
  [key: string]: HelpCategory;
};

// Help content organized by categories
const helpContent: HelpContent = {
  general: {
    title: '📚 NOW Bot Commands',
    description: 'Here are the available commands:',
    commands: [
      { name: 'NOW play [search]', description: 'Play media matching your search' },
      { name: 'NOW play [search] {filter=value}', description: 'Play media with filters applied' },
      { name: 'NOW clip=5s start=10s [search]', description: 'Play a specific clip from media' },
      { name: 'NOW quiz', description: 'Start a quiz game in your voice channel' },
      { name: 'NOW quiz {filter=value}', description: 'Start a quiz with filtered audio' },
      { name: 'NOW quiz clip=5s start=2s', description: 'Start a quiz with shorter clips' },
      { name: 'NOW stop', description: 'Stop an active quiz' },
      { name: 'NOW upload', description: 'Get a link to upload new media' },
      { name: 'NOW image [search]', description: 'Show a thumbnail from a video' },
      { name: 'NOW waveform [search]', description: 'Show audio waveform visualization' },
      { name: 'NOW spectrogram [search]', description: 'Show audio spectrogram visualization' },
      { name: 'NOW help [topic]', description: 'Show help for a specific topic' }
    ],
    footer: 'Type `NOW help [topic]` for more details on a topic.\nAvailable topics: filters, quiz, play'
  },
  
  filters: {
    title: '🎛️ Filter Commands',
    description: 'Apply these filters to media or quiz commands:',
    commands: [
      { name: 'NOW play imperial march {speed=0.5}', description: 'Play media at half speed' },
      { name: 'NOW play star wars {reverse=1}', description: 'Play media in reverse' },
      { name: 'NOW play jedi {amplify=2,eq=contrast=2:saturation=3}', description: 'Amplify and enhance colors' },
      { name: 'NOW play vader {atempo=0.8}', description: 'Slow down audio only' },
      { name: 'NOW quiz {speed=1.5}', description: 'Quiz with sped up audio' },
      { name: 'NOW quiz {bass=5,treble=2}', description: 'Quiz with enhanced bass and treble' },
      { name: 'NOW quiz {reverse=1,pitch=0.8}', description: 'Quiz with reversed and pitched audio' }
    ],
    footer: 'You can combine multiple filters with commas: {filter1=value,filter2=value}'
  },
  
  play: {
    title: '▶️ Media Playback Commands',
    description: 'Commands for media playback:',
    commands: [
      { name: 'NOW play [search term]', description: 'Play media matching search term' },
      { name: 'NOW play', description: 'Play a random media file' },
      { name: 'NOW play [search] {filter=value}', description: 'Play with filters applied' },
      { name: 'NOW clip=5s [search]', description: 'Play only the first 5 seconds' },
      { name: 'NOW start=10s [search]', description: 'Start playing from 10 seconds in' },
      { name: 'NOW clip=5s start=10s [search]', description: '5 second clip starting at 10 seconds' },
      { name: 'NOW image [search]', description: 'Show a thumbnail image' },
      { name: 'NOW waveform [search]', description: 'Show audio waveform visualization' },
      { name: 'NOW spectrogram [search]', description: 'Show audio frequency visualization' }
    ],
    footer: 'Use precise search terms for better results. Clips and filters can be combined.'
  },
  
  quiz: {
    title: '🎮 Quiz Game Commands',
    description: 'Commands for the quiz game:',
    commands: [
      { name: 'NOW quiz', description: 'Start a quiz in your voice channel' },
      { name: 'NOW stop', description: 'End the current quiz and show scores' },
      { name: 'NOW quiz {filter=value}', description: 'Start a quiz with audio filters' },
      { name: 'NOW quiz clip=3s', description: 'Quiz with 3-second clips' },
      { name: 'NOW quiz start=5s', description: 'Quiz with clips starting 5 seconds in' },
      { name: 'NOW quiz clip=3s start=5s', description: '3-second clips starting at 5 seconds' },
      { name: 'NOW quiz {speed=0.75} clip=5s', description: 'Combine filters and clip options' }
    ],
    footer: 'During a quiz, just type the name of the media to answer. First correct answer wins the point!'
  }
};

export const handleHelpCommand = async (message: Message, helpTopic?: string) => {
  try {
    // Convert to lowercase for case-insensitive matching
    const topic = helpTopic?.toLowerCase() || 'general';
    
    // Check if the topic exists
    if (!Object.prototype.hasOwnProperty.call(helpContent, topic)) {
      await safeReply(
        message, 
        `Unknown help topic: "${topic}". Available topics: general, filters, quiz, play`
      );
      return;
    }
    
    // Build help message
    const content = helpContent[topic];
    let helpMessage = `**${content.title}**\n${content.description}\n\n`;
    
    // Add commands
    for (const cmd of content.commands) {
      helpMessage += `• \`${cmd.name}\` - ${cmd.description}\n`;
    }
    
    // Add footer if exists
    if (content.footer) {
      helpMessage += `\n${content.footer}`;
    }
    
    await safeReply(message, helpMessage);
  } catch (error) {
    console.error('Error handling help command:', error);
    await safeReply(message, `Error displaying help: ${(error as Error).message}`);
  }
};