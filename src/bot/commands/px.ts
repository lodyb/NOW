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

    // Get a random video from the database
    const mediaItems = await MediaService.findMedia(undefined, true, 1);
    
    if (!mediaItems || mediaItems.length === 0) {
      await safeReply(message, '❌ No video media found in the database.');
      return;
    }

    const selectedMedia = mediaItems[0];
    
    // Generate a random frame from the video
    const frameBuffer = await generateRandomFrame(MediaService.resolveMediaPath(selectedMedia));
    
    if (!frameBuffer) {
      await safeReply(message, '❌ Failed to extract frame from video.');
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

      // Set up automatic cleanup after 5 minutes
      setTimeout(() => {
        if (activeSessions.has(channelId)) {
          activeSessions.delete(channelId);
        }
      }, 5 * 60 * 1000);
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

  // Check against media title and answers
  const mediaTitle = session.currentMedia.title.toLowerCase();
  
  if (guess.includes(mediaTitle) || mediaTitle.includes(guess)) {
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