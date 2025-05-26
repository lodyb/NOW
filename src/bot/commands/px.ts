import { Message } from 'discord.js';
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
}

const activeSessions = new Map<string, PxGameSession>();

export const handlePxCommand = async (message: Message): Promise<void> => {
  try {
    const channelId = message.channel.id;
    
    // Check if there's already an active session
    if (activeSessions.has(channelId)) {
      await safeReply(message, '🎮 A pixel game is already active in this channel! Try guessing the current image first.');
      return;
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
      setTimeout(async () => {
        if (activeSessions.has(channelId)) {
          const timeoutSession = activeSessions.get(channelId);
          if (timeoutSession?.isActive) {
            try {
              await safeReply(message, `⏰ **Time's up!** The answer was: **${timeoutSession.currentMedia.title}**`);
            } catch (error) {
              console.error('Error sending timeout message:', error);
            }
          }
          activeSessions.delete(channelId);
        }
      }, 60 * 1000); // 1 minute timeout
    }

  } catch (error) {
    console.error('Error in px command:', error);
    await safeReply(message, '❌ An error occurred while starting the pixel game.');
  }
};

// Function to handle guesses (called from main message handler)
export const handlePxGuess = async (message: Message): Promise<boolean> => {
  const channelId = message.channel.id;
  const session = activeSessions.get(channelId);
  
  if (!session || !session.isActive) {
    return false;
  }

  const guess = message.content.toLowerCase().trim();
  
  // Check for give up
  if (guess === 'give up') {
    await safeReply(message, `🏳️ The answer was: **${session.currentMedia.title}**`);
    activeSessions.delete(channelId);
    return true;
  }

  // Check against media title and answers with strict matching
  const mediaTitle = session.currentMedia.title.toLowerCase();
  
  // First check exact match
  if (guess === mediaTitle) {
    await safeReply(message, `🎉 Correct! It was **${session.currentMedia.title}**`);
    activeSessions.delete(channelId);
    return true;
  }
  
  // Check if guess is reasonable length (at least 30% of title length)
  const minRequiredLength = Math.floor(mediaTitle.length * 0.3);
  if (guess.length < minRequiredLength) {
    return true; // Consider it a guess attempt but don't award points
  }
  
  // Check with strict character-level distance (same as quiz)
  const distance = calculateLevenshteinDistance(guess, mediaTitle);
  const maxAllowedDistance = Math.min(2, Math.floor(mediaTitle.length * 0.1)); // Max 2 chars or 10% of length
  
  if (distance <= maxAllowedDistance) {
    await safeReply(message, `🎉 Correct! It was **${session.currentMedia.title}**`);
    activeSessions.delete(channelId);
    return true;
  }

  // Give hints after wrong guesses
  session.hintsGiven++;
  
  if (session.hintsGiven === 3) {
    const hint = session.currentMedia.title.substring(0, Math.ceil(session.currentMedia.title.length * 0.3));
    await safeReply(message, `💡 Hint: The title starts with "${hint}..."`);
  } else if (session.hintsGiven === 6) {
    await safeReply(message, `💡 Hint: The full title is **${session.currentMedia.title.length}** characters long`);
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