import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Message, Client, User, TextChannel } from 'discord.js';
import { handleMention } from '../../src/llm/mentionHandler';
import * as llamaService from '../../src/llm/llamaService';

// Mock the dependencies
jest.mock('../../src/llm/llamaService');
jest.mock('../../src/bot/utils/helpers', () => ({
  safeReply: jest.fn().mockResolvedValue(true)
}));

describe('Mention Handler', () => {
  let mockMessage: Partial<Message>;
  let mockClient: Partial<Client>;
  let mockUser: Partial<User>;
  let mockChannel: Partial<TextChannel>;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create mock objects
    mockUser = {
      id: '12345',
      bot: false
    };
    
    mockClient = {
      user: { id: '67890' } as User
    };
    
    mockChannel = {
      sendTyping: jest.fn().mockResolvedValue(undefined)
    };
    
    mockMessage = {
      content: '<@67890> help me with a quiz',
      author: mockUser as User,
      client: mockClient as Client,
      channel: mockChannel as TextChannel,
      mentions: {
        users: new Map([[mockClient.user!.id, mockClient.user as User]]),
        has: (id: string) => id === mockClient.user!.id,
        everyone: false,
        repliedUser: null
      },
      reply: jest.fn().mockResolvedValue({ edit: jest.fn().mockResolvedValue({}) })
    };
    
    // Mock LLM service methods
    jest.spyOn(llamaService, 'isLLMServiceReady').mockReturnValue(true);
    jest.spyOn(llamaService, 'runInference').mockResolvedValue('This is a test response');
    jest.spyOn(llamaService, 'formatResponseForDiscord').mockReturnValue('Formatted test response');
  });
  
  it('should handle a mention message correctly', async () => {
    await handleMention(mockMessage as Message);
    
    // Verify typing indicator was sent
    expect(mockChannel.sendTyping).toHaveBeenCalled();
    
    // Verify LLM service was checked
    expect(llamaService.isLLMServiceReady).toHaveBeenCalled();
    
    // Verify query was extracted correctly
    expect(llamaService.runInference).toHaveBeenCalledWith(
      expect.stringContaining('help me with a quiz')
    );
    
    // Verify response was formatted
    expect(llamaService.formatResponseForDiscord).toHaveBeenCalledWith('This is a test response');
    
    // Verify reply was sent
    expect(mockMessage.reply).toHaveBeenCalled();
  });
  
  it('should handle empty queries', async () => {
    mockMessage.content = '<@67890>';
    
    await handleMention(mockMessage as Message);
    
    // Verify reply was sent for empty query
    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.stringMatching(/How can I help you\?/)
    );
    
    // Verify LLM inference was not called
    expect(llamaService.runInference).not.toHaveBeenCalled();
  });
  
  it('should handle unavailable LLM service', async () => {
    jest.spyOn(llamaService, 'isLLMServiceReady').mockReturnValue(false);
    
    await handleMention(mockMessage as Message);
    
    // Verify appropriate error message
    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.stringMatching(/service is not available/)
    );
    
    // Verify LLM inference was not called
    expect(llamaService.runInference).not.toHaveBeenCalled();
  });
});