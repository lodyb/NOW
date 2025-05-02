import { Message, AttachmentBuilder } from 'discord.js';
import { findMediaBySearch, getRandomMedia } from '../../database/db';
import { safeReply } from '../utils/helpers';
import path from 'path';
import fs from 'fs';
import { generateWaveformForMedia, generateSpectrogramForMedia } from '../../media/visualizer';

export const handleWaveformCommand = async (message: Message, searchTerm?: string) => {
  try {
    const media = await findMediaItem(message, searchTerm);
    if (!media) return;
    
    const visualizationPath = await generateWaveformForMedia(media);
    await sendVisualization(message, visualizationPath, media.title, 'waveform');
  } catch (error) {
    console.error('Error handling waveform command:', error);
    await safeReply(message, `Error generating waveform: ${(error as Error).message}`);
  }
};

export const handleSpectrogramCommand = async (message: Message, searchTerm?: string) => {
  try {
    const media = await findMediaItem(message, searchTerm);
    if (!media) return;
    
    const visualizationPath = await generateSpectrogramForMedia(media);
    await sendVisualization(message, visualizationPath, media.title, 'spectrogram');
  } catch (error) {
    console.error('Error handling spectrogram command:', error);
    await safeReply(message, `Error generating spectrogram: ${(error as Error).message}`);
  }
};

// Helper function to find media by search term or get a random item
const findMediaItem = async (message: Message, searchTerm?: string) => {
  if (!searchTerm) {
    const randomResults = await getRandomMedia(1);
    if (randomResults.length === 0) {
      await safeReply(message, 'No media found in the database');
      return null;
    }
    return randomResults[0];
  } else {
    const results = await findMediaBySearch(searchTerm);
    if (results.length === 0) {
      await safeReply(message, `No media found for "${searchTerm}"`);
      return null;
    }
    return results[0];
  }
};

// Helper function to send the visualization to Discord
const sendVisualization = async (message: Message, filePath: string, title: string, type: 'waveform' | 'spectrogram') => {
  if (!fs.existsSync(filePath)) {
    await safeReply(message, `Could not generate ${type} for the media`);
    return;
  }
  
  const attachment = new AttachmentBuilder(filePath);
  await safeReply(message, { 
    content: `Here's a ${type} for **${title}**:`,
    files: [attachment] 
  });
};