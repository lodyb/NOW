import { MediaService } from '../../src/bot/services/MediaService';
import { initDatabase, getRandomMedia, Media } from '../../src/database/db';
import fs from 'fs';
import path from 'path';

describe('MediaService Integration Tests', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  describe('MediaService static methods', () => {
    it('should find media by search term', async () => {
      const result = await MediaService.findMedia('test', false, 1);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should get random media', async () => {
      const result = await MediaService.findMedia();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should resolve media paths correctly', () => {
      const mockMedia: Media = {
        id: 1,
        title: 'Test',
        filePath: '/test.mp4',
        normalizedPath: 'norm_test.mp4',
        answers: [],
        thumbnails: []
      };
      
      const result = MediaService.resolveMediaPath(mockMedia);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should validate file existence', () => {
      const exists = MediaService.validateMediaExists(__filename);
      expect(exists).toBe(true);
      
      const notExists = MediaService.validateMediaExists('/nonexistent/file.txt');
      expect(notExists).toBe(false);
    });
  });
});