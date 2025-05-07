import { Message, TextChannel } from 'discord.js';
import { runInference, formatResponseForDiscord, isLLMServiceReady } from './llamaService';
import { safeReply } from '../bot/utils/helpers';

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
export const handleMention = async (message: Message): Promise<void> => {
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
    
    // Extract query from message
    const query = extractQuery(message);
    
    // Don't process empty queries
    if (!query.trim()) {
      const response = 'How can I help you? (Please include a question or prompt after mentioning me)';
      
      if (isInAIChannel) {
        await safeReply(message, response);
      } else {
        await aiChannel.send(`<@${message.author.id}> asked me something in <#${message.channelId}> but didn't provide a question.\n\n${response}`);
        // Add a checkmark reaction to the original message
        await message.react('🐸');
      }
      return;
    }
    
    console.log(`Processing LLM query: ${query}`);
    
    // Prepare a clean prompt without chat markers
    const prompt = query.trim();
    
    // Run inference
    const response = await runInference(prompt);
    
    // Format response for Discord
    const formattedResponse = formatResponseForDiscord(response);
    
    // Send the response to the appropriate channel
    if (isInAIChannel) {
      // Reply directly in the AI channel
      await safeReply(message, formattedResponse);
    } else {
      // Send to AI channel with context about the original message
      await aiChannel.send(`<@${message.author.id}> asked me in <#${message.channelId}>:\n> ${query}\n\n${formattedResponse}`);
      // Add a checkmark reaction to the original message
      await message.react('✅');
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