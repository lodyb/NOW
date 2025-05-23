import { parseCommand } from '../src/bot/utils/helpers';

describe('Refactoring Validation Tests', () => {
  describe('Command parsing', () => {
    it('should parse NOW play commands correctly', () => {
      const mockMessage = {
        content: 'NOW play test song',
        author: { id: '123', username: 'testuser' },
        channel: { send: jest.fn() },
        guild: { id: '456' },
        reply: jest.fn()
      } as any;

      const result = parseCommand(mockMessage);
      
      expect(result).toBeTruthy();
      expect(result?.command).toBe('play');
      expect(result?.searchTerm).toBe('test song');
    });

    it('should parse NOW quiz commands correctly', () => {
      const mockMessage = {
        content: 'NOW quiz',
        author: { id: '123', username: 'testuser' },
        channel: { send: jest.fn() },
        guild: { id: '456' },
        reply: jest.fn()
      } as any;

      const result = parseCommand(mockMessage);
      
      expect(result).toBeTruthy();
      expect(result?.command).toBe('quiz');
    });

    it('should return null for non-NOW commands', () => {
      const mockMessage = {
        content: 'Hello world',
        author: { id: '123', username: 'testuser' },
        channel: { send: jest.fn() },
        guild: { id: '456' },
        reply: jest.fn()
      } as any;

      const result = parseCommand(mockMessage);
      expect(result).toBeNull();
    });
  });
});