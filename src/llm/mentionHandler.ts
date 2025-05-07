import { Message, TextChannel, MessagePayload, MessageCreateOptions, AttachmentBuilder } from 'discord.js';
import { runInference, formatResponseForDiscord, isLLMServiceReady, prepareDiscordResponse } from './llamaService';
import { safeReply } from '../bot/utils/helpers';
import fs from 'fs';
import path from 'path';

// AI channel configuration
const AI_CHANNEL_ID = '1369649491573215262';

// Extract the query from a message mentioning the bot
const extractQuery = (message: Message): string => {
  // Remove the mention and extract the actual query
  let content = message.content.trim();
  
  // Remove all mentions of the bot
  message.mentions.users.forEach(user => {
    if (user.id === message.client.user?.id) {
      const mentionRegex = new RegExp(`<@!?${user.id}>`, 'g');
      content = content.replace(mentionRegex, '').trim();
    }
  });
  
  return content;
};

// Process an @NOW mention message
export const handleMention = async (message: Message, contextPrompt?: string): Promise<void> => {
  try {
    // Check if LLM service is ready
    if (!(await isLLMServiceReady())) {
      await safeReply(message, 'Sorry, the AI service is not available at the moment.');
      return;
    }
    
    // Check if message is in the AI channel
    const isInAIChannel = message.channelId === AI_CHANNEL_ID;
    
    // Get the AI channel for redirected responses
    const aiChannel = message.client.channels.cache.get(AI_CHANNEL_ID) as TextChannel;
    if (!aiChannel) {
      console.error(`AI channel with ID ${AI_CHANNEL_ID} not found`);
      await safeReply(message, "Sorry, I can't find the designated AI channel.");
      return;
    }
    
    // If contextPrompt is provided (from a reply), use that directly
    // Otherwise extract query from message
    const query = contextPrompt || extractQuery(message);
    
    // Don't process empty queries
    if (!query.trim() && message.attachments.size === 0) {
      const response = 'How can I help you? (Please include a question or prompt after mentioning me)';
      
      if (isInAIChannel) {
        await safeReply(message, response);
      } else {
        await aiChannel.send(`<@${message.author.id}> asked me something in <#${message.channelId}> but didn't provide a question.\n\n${response}`);
        // Add a frog reaction to the original message
        await message.react('🐸');
      }
      return;
    }
    
    console.log(`Processing LLM query: ${query}`);
    
    // Prepare a clean prompt without chat markers
    const prompt = query.trim();
    
    // If this is just an empty mention with an attachment, add a default prompt
    const promptWithDefault = message.attachments.size > 0 && !prompt ? 
      "Please analyze this attachment" : prompt;
    
    // Show typing indicator
    if (isInAIChannel) {
      // Skip typing indicator - too many type issues
      console.log('Processing request in AI channel');
    } else {
      // Skip typing indicator - too many type issues
      console.log('Processing request for redirect to AI channel');
    }
    
    // Run inference - pass the message to handle attachments
    const response = await runInference(promptWithDefault, message);
    
    // Format text response for Discord
    const formattedText = formatResponseForDiscord(response.text);
    
    // Prepare full response with any images
    const discordResponse = prepareDiscordResponse(formattedText, response.images);
    
    // Send the response to the appropriate channel
    if (isInAIChannel) {
      // Reply directly in the AI channel
      await safeReply(message, discordResponse);
      
      // Clean up any images after sending
      if (response.images) {
        cleanupTempImages(response.images);
      }
    } else {
      // Create content with attribution
      let redirectContent = `<@${message.author.id}> asked me in <#${message.channelId}>:\n`;
      
      // Include original query text if provided
      if (prompt) {
        redirectContent += `> ${prompt}\n\n`;
      } else if (message.attachments.size > 0) {
        redirectContent += `> [Sent ${message.attachments.size} attachment(s)]\n\n`;
      }
      
      // Add the response text
      redirectContent += formattedText;
      
      // Create a new MessageCreateOptions with the updated content
      const redirectOptions: MessageCreateOptions = {
        content: redirectContent,
        files: discordResponse.files || []
      };
      
      // Send to AI channel with context about the original message
      await aiChannel.send(redirectOptions);
      
      // Clean up any images after sending
      if (response.images) {
        cleanupTempImages(response.images);
      }
      
      // Add a frog reaction to the original message
      await message.react('🐸');
    }
  } catch (error) {
    console.error('Error handling LLM mention:', error);
    // Add an error reaction to the original message
    if (message.channelId !== AI_CHANNEL_ID) {
      try {
        await message.react('❌');
      } catch (reactionError) {
        console.error('Failed to add error reaction:', reactionError);
      }
    } else {
      await safeReply(message, `Sorry, I encountered an error: ${(error as Error).message}`);
    }
  }
};

// Helper function to clean up temporary image files
const cleanupTempImages = (imagePaths: string[]): void => {
  for (const imagePath of imagePaths) {
    try {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch (error) {
      console.error(`Error cleaning up temporary image ${imagePath}:`, error);
    }
  }
};