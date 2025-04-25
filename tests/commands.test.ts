import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import { play } from '../src/commands/play';
import { clip } from '../src/commands/clip';
import { quiz, stopQuiz } from '../src/commands/quiz';
import { upload } from '../src/commands/upload';
import { processMedia } from '../src/services/media/processor';
import { createClip } from '../src/services/media/clipper';
import { normalizeMedia } from '../src/services/media/normalizer';

// Mock TypeORM and other dependencies
jest.mock('typeorm', () => ({
  ILike: jest.fn((str) => str),
}));

jest.mock('../src/database/connection', () => ({
  AppDataSource: {
    getRepository: jest.fn(() => ({
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(1)
    }))
  },
  initializeDatabase: jest.fn(),
}));

jest.mock('../src/services/media/processor', () => ({
  processMedia: jest.fn().mockResolvedValue('/path/to/processed.mp3'),
}));

jest.mock('../src/services/media/clipper', () => ({
  createClip: jest.fn().mockResolvedValue('/path/to/clip.mp3'),
}));

jest.mock('../src/services/media/normalizer', () => ({
  normalizeMedia: jest.fn().mockResolvedValue('/path/to/normalized.mp3'),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  statSync: jest.fn().mockReturnValue({ size: 5000000 }),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  unlinkSync: jest.fn(),
}));

jest.mock('@discordjs/voice', () => ({
  joinVoiceChannel: jest.fn().mockReturnValue({
    subscribe: jest.fn(),
    destroy: jest.fn(),
  }),
  createAudioPlayer: jest.fn().mockReturnValue({
    play: jest.fn(),
    stop: jest.fn(),
  }),
  createAudioResource: jest.fn(),
  AudioPlayerStatus: {
    Playing: 'playing',
    Idle: 'idle',
  },
  VoiceConnectionStatus: {
    Ready: 'ready',
  },
  entersState: jest.fn(),
}));

// Create mock Message, Client, etc.
const createMockMessage = () => ({
  content: 'NOW play test',
  reply: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
  channel: {
    send: jest.fn().mockResolvedValue({}),
  },
  author: {
    id: '123456789',
    tag: 'User#1234',
  },
  guild: {
    members: {
      cache: new Map([
        ['123456789', {
          voice: {
            channel: {
              id: 'voice-channel-id',
              guild: {
                id: 'guild-id',
                voiceAdapterCreator: {},
                members: {
                  fetch: jest.fn().mockResolvedValue({ displayName: 'Test User' }),
                },
              },
              name: 'Voice Channel',
            },
          },
          displayName: 'Test User',
        }],
      ]),
    },
  },
});

const createMockClient = () => ({
  user: {
    tag: 'Otoq#0000',
  },
});

describe('Command Tests', () => {
  let mockMessage;
  let mockClient;

  beforeEach(() => {
    mockMessage = createMockMessage();
    mockClient = createMockClient();
    jest.clearAllMocks();
  });

  describe('play command', () => {
    test('should reply with an error message when no search term is provided', async () => {
      await play([], mockMessage, mockClient);
      expect(mockMessage.reply).toHaveBeenCalledWith('Please provide a search term!');
    });

    test('should process search term correctly', async () => {
      // Mock the database response
      const AppDataSource = require('../src/database/connection').AppDataSource;
      AppDataSource.getRepository().findOne.mockResolvedValueOnce({
        id: 1,
        title: 'Test Media',
        normalizedPath: 'test.mp3',
      });

      await play(['test', 'search'], mockMessage, mockClient);
      expect(AppDataSource.getRepository().findOne).toHaveBeenCalled();
      expect(mockMessage.reply).toHaveBeenCalled();
    });
  });

  describe('clip command', () => {
    test('should require a clip duration', async () => {
      await clip(['test', 'search'], mockMessage, mockClient);
      expect(mockMessage.reply).toHaveBeenCalledWith('You must specify a clip duration using clip=Xs format!');
    });

    test('should process clip with duration and search term', async () => {
      // Mock the database response
      const AppDataSource = require('../src/database/connection').AppDataSource;
      AppDataSource.getRepository().findOne.mockResolvedValueOnce({
        id: 1,
        title: 'Test Media',
        normalizedPath: 'test.mp3',
      });

      await clip(['clip=5s', 'test', 'search'], mockMessage, mockClient);
      expect(createClip).toHaveBeenCalled();
      expect(mockMessage.reply).toHaveBeenCalled();
    });
  });

  describe('quiz command', () => {
    test('should require user to be in a voice channel', async () => {
      // Create a message with no voice channel
      const noVoiceMessage = {
        ...mockMessage,
        guild: {
          members: {
            cache: new Map([
              ['123456789', {
                voice: { channel: null },
                displayName: 'Test User',
              }],
            ]),
          },
        },
      };

      await quiz([], noVoiceMessage, mockClient);
      expect(noVoiceMessage.reply).toHaveBeenCalledWith('You must be in a voice channel to start a quiz!');
    });

    test('should start a quiz when user is in a voice channel', async () => {
      await quiz([], mockMessage, mockClient);
      expect(mockMessage.channel.send).toHaveBeenCalled();
    });
  });

  describe('upload command', () => {
    test('should generate an upload link', async () => {
      await upload([], mockMessage, mockClient);
      expect(mockMessage.reply).toHaveBeenCalled();
    });
  });
});