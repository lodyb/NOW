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
      { name: 'NOW what was that', description: 'Show the sources used in the last jumble' },
      { name: 'NOW !!', description: 'Repeat your last command' },
      { name: 'NOW bind [:emote:] [search]', description: 'Bind media to an emote for voice chat' },
      { name: 'NOW quiz', description: 'Start a quiz game in your voice channel' },
      { name: 'NOW quiz {filter=value}', description: 'Start a quiz with filtered audio' },
      { name: 'NOW quiz clip=5s start=2s', description: 'Start a quiz with shorter clips' },
      { name: 'NOW stop', description: 'Stop an active quiz' },
      { name: 'NOW upload', description: 'Get a link to upload new media via web interface' },
      { name: 'NOW upload <url> "answer1" "answer2"', description: 'Upload media directly from YouTube or URL' },
      { name: 'NOW upload "answer text"', description: 'Upload media from a replied message' },
      { name: 'NOW px', description: 'Start a pixel guessing game from random video frames' },
      { name: 'NOW image [search]', description: 'Show a thumbnail from a video' },
      { name: 'NOW waveform [search]', description: 'Show audio waveform visualization' },
      { name: 'NOW spectrogram [search]', description: 'Show audio spectrogram visualization' },
      { name: 'NOW mahjong [tiles]', description: 'Analyze a Riichi Mahjong hand' },
      { name: '@NOW [message]', description: 'Talk to the AI assistant' },
      { name: 'NOW help [topic]', description: 'Show help for a specific topic' },
      { name: 'NOW radio', description: 'Start continuous music playback in voice channel' },
      { name: 'NOW queue [search]', description: 'Add media to the radio queue' }
    ],
    footer: 'Type `NOW help [topic]` for more details on a topic.\nAvailable topics: filters, quiz, play, radio, mahjong, ai, bind, upload'
  },
  
  filters: {
    title: '🎛️ Filter Commands',
    description: 'Apply these filters to media or quiz commands:',
    commands: [
      { name: 'NOW play imperial march {speed=0.5}', description: 'Play media at half speed' },
      { name: 'NOW play star wars {reverse=1}', description: 'Play media in reverse' },
      { name: 'NOW play jedi {amplify=2,eq=contrast=2:saturation=3}', description: 'Amplify and enhance colors' },
      { name: 'NOW play vader {atempo=0.8}', description: 'Slow down audio only' },
      { name: 'NOW play matrix {datamosh=3}', description: 'Apply digital glitch/corruption effect' },
      { name: 'NOW play futuristic {noise=color}', description: 'Generate colorful visual noise' },
      { name: 'NOW play retro {macroblock=2}', description: 'Create macroblock/compression artifacts' },
      { name: 'NOW play static {geq=random(1)*255:128:128;aevalsrc=-2+random(0)}', description: 'Raw noise generator' },
      { name: 'NOW quiz {speed=1.5}', description: 'Quiz with sped up audio' },
      { name: 'NOW quiz {bass=5,treble=2}', description: 'Quiz with enhanced bass and treble' },
      { name: 'NOW quiz {reverse=1,pitch=0.8}', description: 'Quiz with reversed and pitched audio' }
    ],
    footer: 'You can combine multiple filters with commas: {filter1=value,filter2=value}\nUse {datamosh=1} to {datamosh=10} for varying glitch intensity (higher = more intense).'
  },
  
  play: {
    title: '▶️ Media Playback Commands',
    description: 'Commands for media playback:',
    commands: [
      { name: 'NOW play [search term]', description: 'Play media matching search term' },
      { name: 'NOW play', description: 'Play a random media file' },
      { name: 'NOW play {multi=3}', description: 'Create a 3-video grid layout' },
      { name: 'NOW play star wars {multi=4}', description: 'Create a grid with 4 matching videos' },
      { name: 'NOW play concat', description: 'Create a montage of random clips' },
      { name: 'NOW play concat {count=5}', description: 'Concat 5 random short clips' },
      { name: 'NOW play [search] {filter=value}', description: 'Play with filters applied' },
      { name: 'NOW clip=5s [search]', description: 'Play only the first 5 seconds' },
      { name: 'NOW start=10s [search]', description: 'Start playing from 10 seconds in' },
      { name: 'NOW clip=5s start=10s [search]', description: '5 second clip starting at 10 seconds' },
      { name: 'NOW image [search]', description: 'Show a thumbnail image' },
      { name: 'NOW waveform [search]', description: 'Show audio waveform visualization' },
      { name: 'NOW spectrogram [search]', description: 'Show audio frequency visualization' },
      { name: 'NOW what was that', description: 'Show sources used in the last jumble command' }
    ],
    footer: 'Use precise search terms for better results. You can combine the multi parameter with filters or clip options.'
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
  },
  
  mahjong: {
    title: '🀄 Riichi Mahjong Analyzer',
    description: 'Analyze Mahjong hands and get insights:',
    commands: [
      { name: 'NOW mahjong 1s1s2s3s4p4p4p5p6p7m7m7mrr', description: 'Analyze a full 14-tile hand' },
      { name: 'NOW mahjong 1s2s3s4p4p4p5p6p7m7m7mrr', description: 'Analyze an incomplete hand and get suggestions' },
      { name: 'NOW mahjong 7m7m7m1p1p1prrrggg3s3s3s', description: 'Analyze a hand with triplets and pairs' },
      { name: 'NOW mahjong 1m2m3mro4p5p6peo7s8s9sno', description: 'Analyze a hand with open (called) tiles' }
    ],
    footer: 'Tile notation:\n• Number tiles: 1-9 followed by m (man), p (pin), or s (sou)\n• Honor tiles: r (red dragon), g (green dragon), w (white dragon)\n• Wind tiles: e (east), s (south), x (west), n (north)\n• Open tiles: Add "o" after a tile (e.g., 1so = 1 sou open)\n\nExample: 1s2s3s = 1,2,3 of sou; rr = pair of red dragons'
  },
  
  ai: {
    title: '🤖 AI Assistant',
    description: 'Interact with NOW\'s AI assistant:',
    commands: [
      { name: '@NOW [your message]', description: 'Talk to the AI assistant by mentioning the bot' },
      { name: '@NOW help me find a specific song', description: 'Ask about media in the collection' },
      { name: '@NOW explain how the quiz works', description: 'Get help with bot features' },
      { name: '@NOW suggest some filter combinations', description: 'Get creative suggestions' }
    ],
    footer: 'The AI assistant uses a language model to provide helpful responses. Just mention the bot with @NOW and ask your question!'
  },
  
  bind: {
    title: '🔊 Emote Binding Commands',
    description: 'Bind media to emotes for quick playback in voice channels:',
    commands: [
      { name: 'NOW bind :emote: [search term]', description: 'Bind media to an emote or sticker' },
      { name: 'NOW bind :emote: [search term] {filter=value}', description: 'Bind with filters applied' },
      { name: 'NOW bind :emote: [search] clip=3s', description: 'Bind a short clip of media' },
      { name: 'NOW bind :emote: [search] clip=3s start=5s', description: 'Bind specific section of media' },
      { name: 'NOW bind :emote: [search] {reverse,bass=10}', description: 'Bind with multiple filters' }
    ],
    footer: 'After binding, simply post the emote in a message while in a voice channel to play the sound!\nThis works with both custom server emotes and Discord stickers.\nBindings are server-specific and will only work in the server where they were created.\nEmote bindings won\'t trigger during quiz games.'
  },
  
  upload: {
    title: '📤 Upload Commands',
    description: 'Commands for uploading media to the NOW collection:',
    commands: [
      { name: 'NOW upload', description: 'Get a web interface link for batch uploading files' },
      { name: 'NOW upload https://www.youtube.com/watch?v=dQw4w9WgXcQ "Rick Roll"', description: 'Upload from YouTube with custom answer' },
      { name: 'NOW upload https://example.com/video.mp4 "Title" "Alt Title"', description: 'Upload direct media URL with multiple answers' },
      { name: 'NOW upload "Custom Answer"', description: 'Reply to a message with media to upload it' },
      { name: 'NOW upload https://youtu.be/dQw4w9WgXcQ', description: 'Upload YouTube video using its title as the answer' }
    ],
    footer: 'YouTube URLs are automatically detected and downloaded with video titles.\nDirect media URLs (.mp4, .mp3, etc.) are also supported.\nAnswers in quotes become searchable terms for the quiz and play commands.\nIf no answers are provided, the filename or YouTube title is used automatically.\nUploaded media is automatically processed for Discord compatibility.'
  },
  
  radio: {
    title: '📻 Radio Commands',
    description: 'Continuous music playback in voice channels:',
    commands: [
      { name: 'NOW radio', description: 'Start continuous music playback in your voice channel' },
      { name: 'NOW queue [search]', description: 'Add media to the radio queue' },
      { name: 'NOW stop', description: 'Stop the radio and clear the queue' }
    ],
    footer: 'Radio plays random media continuously when the queue is empty. Use queue to add specific songs next!'
  },
};

export const handleHelpCommand = async (message: Message, helpTopic?: string) => {
  try {
    // Convert to lowercase for case-insensitive matching
    const topic = helpTopic?.toLowerCase() || 'general';
    
    // Check if the topic exists
    if (!Object.prototype.hasOwnProperty.call(helpContent, topic)) {
      await safeReply(
        message, 
        `Unknown help topic: "${topic}". Available topics: general, filters, quiz, play, radio, mahjong, ai`
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

// New help command file for filter chaining capabilities
export const handleFilterHelpCommand = async (message: Message, topic?: string) => {
  try {
    if (topic) {
      switch (topic.toLowerCase()) {
        case 'play':
          await sendPlayHelp(message);
          break;
        case 'remix':
          await sendRemixHelp(message);
          break;
        case 'filters':
          await sendFilterHelp(message);
          break;
        case 'special':
          await sendSpecialModesHelp(message);
          break;
        default:
          await sendGeneralHelp(message);
      }
    } else {
      await sendGeneralHelp(message);
    }
  } catch (error) {
    console.error('Error in help command:', error);
    await safeReply(message, 'An error occurred while displaying help');
  }
};

const sendGeneralHelp = async (message: Message) => {
  const helpText = `
**NOW Bot Help**

**Basic Commands:**
• \`NOW play [search term]\` - Play media from the database
• \`NOW remix\` - Process media from a message or reply with filters
• \`NOW quiz\` - Start a quiz game in your voice channel

**Detailed Help:**
• \`NOW help play\` - Show detailed play command help
• \`NOW help remix\` - Show detailed remix command help
• \`NOW help filters\` - Show available filters and effects
• \`NOW help special\` - Show special playback modes

Need more help? Use \`NOW help [topic]\` for specific information.
`;
  await safeReply(message, helpText);
};

const sendPlayHelp = async (message: Message) => {
  const helpText = `
**NOW Play Command Help**

**Basic Usage:**
• \`NOW play [search term]\` - Play media matching the search term
• \`NOW play\` - Play random media from database

**With Filters:**
• \`NOW play [search] {filter1=value1,filter2=value2}\` - Apply filters to media
• \`NOW play [search] {reverse,bass=10,volume=2}\` - Chain multiple filters
• \`NOW play imperial march {chipmunk+reverb}\` - Apply effect combinations

**With Clipping:**
• \`NOW play [search] clip=5s\` - Play a 5-second clip
• \`NOW play [search] start=10s clip=5s\` - Play a 5-second clip starting at 10s
• \`NOW play [search] start=1:30 clip=10s\` - Start at 1 minute, 30 seconds

**Special Modes:**
• \`NOW play concat\` - Combine random clips
• \`NOW play [search] {stereo}\` - Create stereo split with two media sources
• \`NOW play [search] {jumble}\` - Mix video from one source with audio from another
• \`NOW play [search] multi=4\` - Create a grid of multiple videos

You can combine clip options with filters: \`NOW play theme clip=10s {reverse}\`
`;
  await safeReply(message, helpText);
};

const sendRemixHelp = async (message: Message) => {
  const helpText = `
**NOW Remix Command Help**

The remix command processes media from messages or replies.

**Usage:**
• Reply to a message with media and type \`NOW remix\` - Basic processing
• Reply and add filters: \`NOW remix {bass=10,reverse}\` - Chain multiple filters
• Include clip options: \`NOW remix clip=5s start=10s\` - Create a specific clip
• Combine both: \`NOW remix clip=5s {bass=10,reverse}\` - Clip with filters

**Works With:**
• Message attachments (video, audio, gifs)
• Embedded media in messages
• Direct links to media files (.mp4, .mp3, .ogg, etc.)

**Example Filter Chains:**
• \`NOW remix {bass=10,volume=2}\` - Boost bass and volume
• \`NOW remix {reverse,echo}\` - Reverse audio and add echo effect
• \`NOW remix {chipmunk+reverb}\` - Apply chipmunk and reverb effects together
• \`NOW remix {vhs,huerotate=2}\` - Add VHS effect and rotating hue

Use \`NOW help filters\` to see all available filters and effects.
`;
  await safeReply(message, helpText);
};

const sendFilterHelp = async (message: Message) => {
  const helpText = `
**NOW Filter Help**

Filters can be chained together with commas. Example: \`{reverse,bass=10,volume=2}\`
Effect combinations can be created with plus signs. Example: \`{chipmunk+reverb}\`

**Basic Audio Filters:**
• \`volume=2\` - Change volume (0.1 to 5)
• \`bass=10\` - Boost bass (1 to 20)
• \`treble=5\` - Boost treble (1 to 20)
• \`speed=0.5\` - Change speed (0.5 = slower, 2 = faster)
• \`reverse\` - Reverse audio/video

**Audio Effects:**
• \`echo\` or \`aecho\` - Add echo
• \`reverb\` - Add reverb effect
• \`chipmunk\` - High-pitched voice
• \`demon\` - Low-pitched voice
• \`robot\` or \`robotize\` - Robot voice
• \`telephone\` - Old phone effect
• \`bitcrush\` - Lo-fi effect
• \`phaser\`, \`flanger\`, \`tremolo\`, \`chorus\` - Audio effects
• \`bassboosted\`, \`earrape\`, \`nuked\` - Extreme audio

**Video Effects:**
• \`huerotate\` - Rainbow color cycle effect
• \`pixelize\` - Pixelate the video
• \`vhs\` - Old VHS tape look
• \`oldfilm\` - Vintage film effect
• \`kaleidoscope\` - Mirror effect
• \`dreameffect\` - Dreamy blur look
• \`hmirror\` - Horizontal mirror
• \`vmirror\` - Vertical mirror

**Special Combinations:**
• \`destroy8bit+chipmunk\` - 8-bit destruction with chipmunk voice
• \`vhs+reverse\` - Reversed VHS tape look
• \`vaporwave\` - Vaporwave aesthetic effect
• \`phonk\` - Phonk music style effect

There are 50+ filters available! Experiment with combinations.
`;
  await safeReply(message, helpText);
};

const sendSpecialModesHelp = async (message: Message) => {
  const helpText = `
**NOW Special Playback Modes Help**

**Multi-Media Grid:**
• \`NOW play [search] multi=4\` - Create 2x2 grid with 4 videos
• \`NOW play [search] multi=9\` - Create 3x3 grid with 9 videos
• With advanced options:
  - \`NOW play [search] multi=4 {mdelay=500}\` - 500ms delay between videos
  - \`NOW play [search] multi=4 {mspeed=1.2}\` - Speed progression between videos
  - \`NOW play [search] multi=4 {msync}\` - Sync all videos to same duration

**Concat (Clip Montage):**
• \`NOW play concat\` - Create montage of random clips
• \`NOW play concat {count=6}\` - Specify number of clips (2-10)
• \`NOW play concat clip=3s\` - Set duration for each clip

**Stereo Split:**
• \`NOW play [search] {stereo}\` or \`NOW play [search] {split}\` - Separate audio channels
  Creates a side-by-side video with different media in left/right audio channels

**Jumble:**
• \`NOW play [search] {jumble}\` - Mix video from one source with audio from another
  Creates unpredictable combinations, often with funny results

**DJ Mode:**
• \`NOW play [search] {dj}\` - Apply one random audio filter and one random video filter
  Automatically selects and combines random effects for unique results

You can add other filters to these special modes too!
\`NOW play [search] multi=4 {vhs,msync}\` - Create a synced VHS-style grid
`;
  await safeReply(message, helpText);
};