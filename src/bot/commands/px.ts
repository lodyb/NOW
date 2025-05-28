import { Message, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { MediaService, MediaFile } from '../services/MediaService';
import { generateRandomFrame } from '../../media/frameExtractor';
import { safeReply } from '../utils/helpers';

interface PxGameSession {
  channelId: string;
  messageId?: string;
  currentMedia: MediaFile;
  isActive: boolean;
  startTime: number;
  hintsGiven: number;
  timeoutId?: NodeJS.Timeout;
}

const activeSessions = new Map<string, PxGameSession>();

export const handlePxCommand = async (message: Message): Promise<void> => {
  try {
    const channelId = message.channel.id;
    
    // Check if there's already an active session - if so, ignore the request
    if (activeSessions.has(channelId)) {
      const existingSession = activeSessions.get(channelId);
      if (existingSession?.isActive) {
        await safeReply(message, '🎯 A pixel game is already active in this channel! Finish the current game first.');
        return;
      }
      // If session exists but isn't active, clean it up
      if (existingSession?.timeoutId) {
        clearTimeout(existingSession.timeoutId);
      }
      activeSessions.delete(channelId);
    }

    // Get a random video from the database (requireVideo = true)
    const mediaItems = await MediaService.findMedia(undefined, true, 10);
    
    if (!mediaItems || mediaItems.length === 0) {
      await safeReply(message, '❌ No video media found in the database.');
      return;
    }

    // Try multiple videos until we find one that works
    let selectedMedia = null;
    let frameBuffer = null;
    
    for (const media of mediaItems) {
      frameBuffer = await generateRandomFrame(MediaService.resolveMediaPath(media));
      if (frameBuffer) {
        selectedMedia = media;
        break;
      }
    }
    
    if (!selectedMedia || !frameBuffer) {
      await safeReply(message, '❌ Failed to extract frame from any video.');
      return;
    }

    // Create game session
    const session: PxGameSession = {
      channelId,
      currentMedia: selectedMedia,
      isActive: true,
      startTime: Date.now(),
      hintsGiven: 0
    };

    // Send the frame image
    const gameMessage = await safeReply(message, {
      content: '🎯 **Pixel Game!** Can you guess what video this frame is from?\n\n*Type your guess in chat. Type `give up` to reveal the answer.*',
      files: [{
        attachment: frameBuffer,
        name: 'frame.png'
      }]
    });

    if (gameMessage) {
      // Store the session
      activeSessions.set(channelId, session);

      // Set up automatic timeout after 1 minute
      const timeoutId = setTimeout(async () => {
        if (activeSessions.has(channelId)) {
          const timeoutSession = activeSessions.get(channelId);
          if (timeoutSession?.isActive) {
            try {
              const replayRow = createReplayButton();
              const primaryAnswer = timeoutSession.currentMedia.answers && timeoutSession.currentMedia.answers.length > 0 
                ? timeoutSession.currentMedia.answers[0] 
                : timeoutSession.currentMedia.title;
              await safeReply(message, {
                content: `⏰ **Time's up!** The answer was: **${primaryAnswer}**`,
                components: [replayRow]
              });
            } catch (error) {
              console.error('Error sending timeout message:', error);
            }
          }
          activeSessions.delete(channelId);
        }
      }, 60 * 1000); // 1 minute timeout

      // Update session with timeout ID
      session.timeoutId = timeoutId;
    }

  } catch (error) {
    console.error('Error in px command:', error);
    await safeReply(message, '❌ An error occurred while starting the pixel game.');
  }
};

// Function to create replay button
const createReplayButton = () => {
  const replayButton = new ButtonBuilder()
    .setCustomId('px_replay')
    .setLabel('🔄 Play Again')
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(replayButton);
};

// Function to handle guesses (called from main message handler)
export const handlePxGuess = async (message: Message): Promise<boolean> => {
  const channelId = message.channel.id;
  const session = activeSessions.get(channelId);
  
  if (!session || !session.isActive) {
    return false;
  }

  const guess = message.content.toLowerCase().trim();
  
  // Get the primary answer (first answer) for display
  const primaryAnswer = session.currentMedia.answers && session.currentMedia.answers.length > 0 
    ? session.currentMedia.answers[0] 
    : session.currentMedia.title;
  
  // Get all valid answers for checking
  const validAnswers = session.currentMedia.answers && session.currentMedia.answers.length > 0
    ? session.currentMedia.answers.map((a: any) => {
        const answerText = typeof a === 'string' ? a : a.answer;
        return answerText.toLowerCase();
      })
    : [session.currentMedia.title.toLowerCase()];
  
  // Check for give up
  if (guess === 'give up') {
    // Clear timeout before ending session
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    const replayRow = createReplayButton();
    await safeReply(message, {
      content: `🏳️ The answer was: **${primaryAnswer}**`,
      components: [replayRow]
    });
    activeSessions.delete(channelId);
    return true;
  }

  // Check against all valid answers with exact matching first
  if (validAnswers.some((answer: string) => guess === answer)) {
    // Clear timeout before ending session
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    const replayRow = createReplayButton();
    await safeReply(message, {
      content: `🎉 Correct! It was **${primaryAnswer}**`,
      components: [replayRow]
    });
    activeSessions.delete(channelId);
    return true;
  }
  
  // Check if guess is reasonable length (at least 30% of shortest answer length)
  const minRequiredLength = Math.floor(Math.min(...validAnswers.map((a: string) => a.length)) * 0.3);
  if (guess.length < minRequiredLength) {
    return true; // Consider it a guess attempt but don't award points
  }
  
  // Check each valid answer with fuzzy matching
  const correctMatch = validAnswers.find((validAnswer: string) => {
    const distance = calculateLevenshteinDistance(guess, validAnswer);
    const maxAllowedDistance = Math.min(2, Math.floor(validAnswer.length * 0.15)); // Allow up to 15% character errors
    return distance <= maxAllowedDistance;
  });
  
  if (correctMatch) {
    // Clear timeout before ending session
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    const replayRow = createReplayButton();
    await safeReply(message, {
      content: `🎉 Correct! It was **${primaryAnswer}**`,
      components: [replayRow]
    });
    activeSessions.delete(channelId);
    return true;
  }

  // Give hints after wrong guesses
  session.hintsGiven++;
  
  if (session.hintsGiven === 3) {
    const hint = primaryAnswer.substring(0, Math.ceil(primaryAnswer.length * 0.3));
    await safeReply(message, `💡 Hint: The title starts with "${hint}..."`);
  } else if (session.hintsGiven === 6) {
    await safeReply(message, `💡 Hint: The full title is **${primaryAnswer.length}** characters long`);
  }

  return true;
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