import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';
import { Message, Client, GuildMember, TextChannel, Guild, VoiceChannel } from 'discord.js';
import { playCommand } from '../src/commands/play';
import { clipCommand } from '../src/commands/clip';
import { quiz, stopQuiz, processQuizMessage } from '../src/commands/quiz';
import { uploadCommand } from '../src/commands/upload';
import * as mediaProcessor from '../src/services/media/processor';
import { createClip } from '../src/services/media/clipper';
import { normalizeMedia, normalizeMediaIfNeeded } from '../src/services/media/normalizer';
import { processCommand } from '../src/commands/index';
import * as path from 'path';
import * as fs from 'fs';

// Define types for mock objects
interface MockMessage extends Partial<Message> {
  content: string;
  reply: jest.Mock;
  delete: jest.Mock;
  channel: {
    send: jest.Mock;
    type: string;
  };
  author: {
    id: string;
    tag: string;
    bot: boolean;
  };
  guild?: {
    id: string;
    name: string;
    members: {
      cache: Map<string, MockGuildMember>;
      fetch: jest.Mock;
    }
  };
}

interface MockGuildMember extends Partial<GuildMember> {
  voice: {
    channel: MockVoiceChannel | null;
  };
  displayName: string;
}

interface MockVoiceChannel extends Partial<VoiceChannel> {
  id: string;
  guild: {
    id: string;
    voiceAdapterCreator: unknown;
    members: {
      fetch: jest.Mock;
    };
  };
  name: string;
}

interface MockClient extends Partial<Client> {
  user: {
    tag: string;
    id: string;
  };
}

// Mock all TypeORM decorators and classes
jest.mock('typeorm', () => {
  const decoratorFn = jest.fn().mockImplementation(() => jest.fn());
  
  return {
    DataSource: jest.fn().mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(true),
      isInitialized: true,
      manager: {
        query: jest.fn().mockResolvedValue([{ id: 1 }]),
      },
      getRepository: jest.fn(),
      destroy: jest.fn(),
    })),
    Entity: decoratorFn,
    Column: decoratorFn,
    PrimaryColumn: decoratorFn,
    PrimaryGeneratedColumn: decoratorFn,
    CreateDateColumn: decoratorFn,
    OneToMany: decoratorFn,
    ManyToOne: decoratorFn,
    JoinColumn: decoratorFn,
    ManyToMany: decoratorFn,
    JoinTable: decoratorFn,
    ILike: jest.fn((str) => str),
  };
});

// Mock the database connection and repository
jest.mock('../src/database/connection', () => ({
  AppDataSource: {
    getRepository: jest.fn(() => ({
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: 1,
          title: 'Test Media',
          filePath: '/uploads/test.mp4',
          normalizedPath: 'normalized/test.mp4',
          metadata: { originalName: 'test.mp4' },
          answers: [{ answer: 'Test Media', isPrimary: true }]
        }),
        getMany: jest.fn().mockResolvedValue([{
          id: 1,
          title: 'Test Media',
          filePath: '/uploads/test.mp4',
          normalizedPath: 'normalized/test.mp4',
          metadata: { originalName: 'test.mp4' },
          answers: [{ answer: 'Test Media', isPrimary: true }]
        }]),
      })
    })),
    isInitialized: true,
    initialize: jest.fn().mockResolvedValue(true),
    manager: {
      query: jest.fn().mockResolvedValue([{ id: 1 }]),
    },
  },
  initializeDatabase: jest.fn().mockResolvedValue(true),
}));

// Mock the TypeORM entities to prevent decorator errors
jest.mock('../src/database/entities/Media', () => ({
  Media: class MockMedia {
    id = 1;
    title = 'Test Media';
    filePath = '/uploads/test.mp4';
    normalizedPath = 'normalized/test.mp4';
    year = 2023;
    metadata = '{"originalName": "test.mp4"}';
    createdAt = new Date();
    answers = [{ answer: 'Test Media', isPrimary: true }];
  }
}));

jest.mock('../src/database/entities/MediaAnswer', () => ({
  MediaAnswer: class MockMediaAnswer {
    id = 1;
    answer = 'Test Media';
    isPrimary = true;
    mediaId = 1;
  }
}));

// Mock other dependencies
jest.mock('../src/services/media/processor', () => ({
  processMedia: jest.fn().mockResolvedValue('/path/to/processed.mp3'),
}));

jest.mock('../src/services/media/clipper', () => ({
  createClip: jest.fn().mockResolvedValue('/path/to/clip.mp3'),
  getMediaDuration: jest.fn().mockResolvedValue(120),
}));

jest.mock('../src/services/media/normalizer', () => ({
  normalizeMedia: jest.fn().mockImplementation((filePath: string) => {
    // Simple mock that returns a path in the normalized directory
    const fileName = path.basename(filePath);
    return Promise.resolve(path.join('normalized', fileName));
  }),
  normalizeMediaIfNeeded: jest.fn().mockImplementation((filePath: string) => {
    // Simple mock that returns a path in the normalized directory
    const fileName = path.basename(filePath);
    return Promise.resolve(path.join('normalized', fileName));
  }),
  hasNvidiaGpu: jest.fn().mockResolvedValue(false),
}));

// Mock filesystem
const mockFileData = new Map<string, Buffer>();
mockFileData.set('/home/lody/now/normalized/test.mp4', Buffer.from('mock file data'));
mockFileData.set('/home/lody/now/uploads/test.mp4', Buffer.from('mock file data'));

jest.mock('fs', () => {
  const originalFs = jest.requireActual('fs');
  return {
    ...originalFs, // Include the real fs functions Winston requires
    existsSync: jest.fn().mockImplementation((filePath: string) => {
      if (typeof filePath === 'string') {
        // Return true for specific test paths
        return filePath.includes('test.mp4') || 
               filePath.includes('normalized') ||
               filePath.includes('uploads') ||
               filePath.includes('processed.mp3') ||
               filePath.includes('clip.mp3');
      }
      return false;
    }),
    statSync: jest.fn().mockImplementation((filePath: string) => {
      // Return different sizes to test size-based normalization
      if (filePath.includes('big_file')) {
        return { size: 10 * 1024 * 1024 }; // 10MB, over Discord limit
      }
      return { size: 5 * 1024 * 1024 }; // 5MB, under Discord limit
    }),
    mkdirSync: jest.fn(),
    copyFileSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    unlinkSync: jest.fn(),
    readFileSync: jest.fn().mockImplementation((filePath: string) => {
      return mockFileData.get(filePath) || Buffer.from('mock file data');
    }),
    writeFileSync: jest.fn(),
    createReadStream: jest.fn().mockReturnValue({
      pipe: jest.fn(),
      on: jest.fn().mockImplementation(function(this: any, event: string, callback: () => void) {
        if (event === 'end') setTimeout(callback, 0);
        return this;
      }),
    }),
    createWriteStream: jest.fn().mockReturnValue({
      on: jest.fn().mockImplementation(function(this: any, event: string, callback: () => void) {
        if (event === 'finish') setTimeout(callback, 0);
        return this;
      }),
    }),
  };
});

jest.mock('@discordjs/voice', () => ({
  joinVoiceChannel: jest.fn().mockReturnValue({
    subscribe: jest.fn(),
    destroy: jest.fn(),
    on: jest.fn(),
    state: { status: 'ready' }
  }),
  createAudioPlayer: jest.fn().mockReturnValue({
    play: jest.fn(),
    stop: jest.fn(),
    on: jest.fn(),
  }),
  createAudioResource: jest.fn().mockReturnValue({
    volume: {
      setVolume: jest.fn()
    }
  }),
  AudioPlayerStatus: {
    Playing: 'playing',
    Idle: 'idle',
  },
  VoiceConnectionStatus: {
    Ready: 'ready',
  },
  entersState: jest.fn().mockResolvedValue(true),
  NoSubscriberBehavior: { Play: 'play' },
  StreamType: { Arbitrary: 'arbitrary' },
}));

jest.mock('fluent-ffmpeg', () => {
  const mockFfmpeg = jest.fn().mockReturnValue({
    audioFilters: jest.fn().mockReturnThis(),
    videoCodec: jest.fn().mockReturnThis(),
    size: jest.fn().mockReturnThis(),
    videoBitrate: jest.fn().mockReturnThis(),
    audioCodec: jest.fn().mockReturnThis(),
    audioBitrate: jest.fn().mockReturnThis(),
    output: jest.fn().mockReturnThis(),
    outputOptions: jest.fn().mockReturnThis(),
    setStartTime: jest.fn().mockReturnThis(),
    setDuration: jest.fn().mockReturnThis(),
    noVideo: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation(function(this: any, event: string, callback: () => void) {
      if (event === 'end') setTimeout(callback, 0);
      return this;
    }),
    run: jest.fn(),
  });
  
  mockFfmpeg.ffprobe = jest.fn().mockImplementation(
    (filePath: string, callback: (err: Error | null, data: any) => void) => {
      callback(null, {
        format: { duration: 180, bit_rate: 2000000 },
        streams: [
          { codec_type: 'video', width: 1280, height: 720 },
          { codec_type: 'audio' }
        ]
      });
    }
  );
  
  mockFfmpeg.setFfmpegPath = jest.fn();
  
  return mockFfmpeg;
});

jest.mock('crypto', () => ({
  createHmac: jest.fn().mockReturnValue({
    update: jest.fn(),
    digest: jest.fn().mockReturnValue('mockhash'),
  }),
  randomBytes: jest.fn().mockReturnValue(Buffer.from('1234567890')),
}));

jest.mock('os', () => ({
  tmpdir: jest.fn().mockReturnValue('/tmp'),
}));

// Create mock Message, Client, etc.
const createMockMessage = (content = 'NOW play test'): MockMessage => ({
  content,
  reply: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
  channel: {
    send: jest.fn().mockResolvedValue({}),
    type: 'text',
  },
  author: {
    id: '123456789',
    tag: 'User#1234',
    bot: false,
  },
  guild: {
    id: 'guild-id',
    name: 'Test Server',
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
      fetch: jest.fn().mockResolvedValue({ displayName: 'Test User' }),
    },
  },
} as MockMessage);

const createMockClient = (): MockClient => ({
  user: {
    tag: 'NOW#0000',
    id: 'bot-id',
  },
});

describe('NOW Discord Bot Command Tests', () => {
  let mockMessage: MockMessage;
  let mockClient: MockClient;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    mockMessage = createMockMessage();
    mockClient = createMockClient();
    jest.clearAllMocks();
    env = process.env;
    process.env = { ...env, MAX_FILE_SIZE: '8' }; // 8MB limit
  });

  afterEach(() => {
    process.env = env;
  });

  describe('Command Processing', () => {
    test('should ignore messages from bots', async () => {
      const botMessage = { 
        ...mockMessage, 
        author: { ...mockMessage.author, bot: true } 
      } as MockMessage;
      
      // This is a typecasting workaround for the test
      await processCommand(botMessage as unknown as Message);
      expect(botMessage.reply).not.toHaveBeenCalled();
    });

    test('should ignore messages without the NOW prefix', async () => {
      const nonPrefixMessage = createMockMessage('play test');
      
      // This is a typecasting workaround for the test
      await processCommand(nonPrefixMessage as unknown as Message);
      expect(nonPrefixMessage.reply).not.toHaveBeenCalled();
    });

    test('should process a valid play command', async () => {
      const playMessage = createMockMessage('NOW play imperial march');
      
      // This is a typecasting workaround for the test
      await processCommand(playMessage as unknown as Message);
      expect(playMessage.channel.send).toHaveBeenCalled();
    });
  });

  describe('play command', () => {
    test('should reply with an error when no search term is provided', async () => {
      // Mock the implementation of the playCommand directly
      const message = createMockMessage('NOW play');
      
      // Mock the implementation to capture the actual call
      const replyMock = jest.fn().mockResolvedValue({});
      message.reply = replyMock;
      
      // This is a typecasting workaround for the test
      await playCommand(message as unknown as Message);
      expect(replyMock).toHaveBeenCalledWith('Please specify what to search for. Example: `NOW play imperial march`');
    });

    test('should find and play media when valid search term is provided', async () => {
      const message = createMockMessage('NOW play imperial march');
      // Mock the implementation of channel.send
      jest.spyOn(message.channel, 'send').mockImplementation(() => Promise.resolve({} as any));
      
      // This is a typecasting workaround for the test
      await playCommand(message as unknown as Message);
      expect(message.channel.send).toHaveBeenCalled();
    });

    test('should apply filters when options are provided', async () => {
      // Create a message with filter options
      const message = createMockMessage('NOW play imperial march {amplify=2,reverse=1}');
      
      // Create a direct mock of the processMedia function
      const processMediaMock = jest.fn().mockResolvedValue('/path/to/processed.mp3');
      
      // Replace the processMedia implementation for this test
      const originalProcessMedia = mediaProcessor.processMedia;
      mediaProcessor.processMedia = processMediaMock;
      
      try {
        // This is a typecasting workaround for the test
        await playCommand(message as unknown as Message);
        expect(processMediaMock).toHaveBeenCalled();
      } finally {
        // Restore the original implementation
        mediaProcessor.processMedia = originalProcessMedia;
      }
    });

    test('should normalize large files on-demand for Discord compatibility', async () => {
      // Mock the path to be over Discord's limit
      jest.spyOn(fs, 'statSync').mockReturnValueOnce({ size: 10 * 1024 * 1024 } as fs.Stats);
      
      const message = createMockMessage('NOW play big_file');
      // This is a typecasting workaround for the test
      await playCommand(message as unknown as Message);
      expect(normalizeMediaIfNeeded).toHaveBeenCalled();
      expect(message.channel.send).toHaveBeenCalled();
    });

    test('should handle file not found errors', async () => {
      // Mock file not existing
      jest.spyOn(fs, 'existsSync').mockReturnValueOnce(false);
      
      const message = createMockMessage('NOW play missing_file');
      // This is a typecasting workaround for the test
      await playCommand(message as unknown as Message);
      expect(message.reply).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });
  });

  describe('clip command', () => {
    test('should require a search term', async () => {
      const message = createMockMessage('NOW clip=5s');
      // This is a typecasting workaround for the test
      await clipCommand(message as unknown as Message);
      expect(message.reply).toHaveBeenCalledWith(expect.stringContaining('Please specify what to search for'));
    });

    test('should create a clip with specified duration', async () => {
      const message = createMockMessage('NOW clip=5s imperial march');
      // This is a typecasting workaround for the test
      await clipCommand(message as unknown as Message);
      expect(createClip).toHaveBeenCalledWith(expect.any(String), 5, null);
      expect(message.channel.send).toHaveBeenCalled();
    });

    test('should create a clip with specified duration and start position', async () => {
      const message = createMockMessage('NOW clip=5s start=10s imperial march');
      // This is a typecasting workaround for the test
      await clipCommand(message as unknown as Message);
      expect(createClip).toHaveBeenCalledWith(expect.any(String), 5, 10);
    });

    test('should handle file not found errors', async () => {
      // Mock file not existing
      jest.spyOn(fs, 'existsSync').mockReturnValueOnce(false);
      
      const message = createMockMessage('NOW clip=5s missing_file');
      // This is a typecasting workaround for the test
      await clipCommand(message as unknown as Message);
      expect(message.reply).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });
  });

  describe('quiz command', () => {
    test('should require user to be in a voice channel', async () => {
      // Create a message with no voice channel
      const noVoiceMessage = {
        ...mockMessage,
        guild: {
          ...mockMessage.guild!,
          members: {
            cache: new Map([
              ['123456789', {
                voice: { channel: null },
                displayName: 'Test User',
              }],
            ]),
            fetch: jest.fn().mockResolvedValue({ displayName: 'Test User' }),
          },
        },
      } as MockMessage;

      // This is a typecasting workaround for the test
      await quiz([], noVoiceMessage as unknown as Message, mockClient as unknown as Client);
      expect(noVoiceMessage.reply).toHaveBeenCalledWith('You must be in a voice channel to start a quiz!');
    });

    test('should start a quiz when user is in a voice channel', async () => {
      // Use our mockMessage since it already has a voice channel
      // This is a typecasting workaround for the test
      await quiz([], mockMessage as unknown as Message, mockClient as unknown as Client);
      expect(mockMessage.channel.send).toHaveBeenCalled();
    });

    test('should stop an active quiz', async () => {
      // First start a quiz
      // This is a typecasting workaround for the test
      await quiz([], mockMessage as unknown as Message, mockClient as unknown as Client);
      
      // Then stop it
      // This is a typecasting workaround for the test
      await stopQuiz(mockMessage as unknown as Message);
      expect(mockMessage.reply).toHaveBeenCalled();
    });

    test('should process quiz messages correctly', () => {
      // This is a typecasting workaround for the test
      processQuizMessage(mockMessage as unknown as Message);
      // This is mostly testing that the function doesn't throw
      expect(true).toBeTruthy();
    });

    test('should support custom options like clip duration', async () => {
      // Create a fresh message to avoid state from previous tests
      const message = createMockMessage('NOW quiz clip=3s');
      
      // Mock the channel.send call
      jest.spyOn(message.channel, 'send').mockImplementation(() => Promise.resolve({} as any));
      
      // This is a typecasting workaround for the test
      await quiz(['clip=3s'], message as unknown as Message, mockClient as unknown as Client);
      expect(message.channel.send).toHaveBeenCalled();
    });
  });

  describe('upload command', () => {
    test('should generate an upload token and link', async () => {
      // This is a typecasting workaround for the test
      await uploadCommand(mockMessage as unknown as Message, mockClient as unknown as Client);
      // The upload command uses a rich embed, so we need to check that reply was called
      // without checking the exact content
      expect(mockMessage.reply).toHaveBeenCalled();
    });
  });
});