import { MediaService } from '../../src/bot/services/MediaService';
import path from 'path';
import * as db from '../../src/database/db';

// Mock the database module to avoid SQLite3 native binding issues in tests
jest.mock('../../src/database/db', () => ({
  findMediaBySearch: jest.fn(),
  getRandomMedia: jest.fn(),
  findAllMedia: jest.fn(),
  saveMedia: jest.fn(),
  saveMediaAnswers: jest.fn(),
  updateMediaWaveform: jest.fn(),
  getMediaById: jest.fn(),
}));

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

const mockFindMediaBySearch = db.findMediaBySearch as jest.MockedFunction<typeof db.findMediaBySearch>;
const mockGetRandomMedia = db.getRandomMedia as jest.MockedFunction<typeof db.getRandomMedia>;
const mockFs = require('fs');

describe('MediaService', () => {
  const mockMedia = {
    id: 1,
    title: 'Test Media',
    filePath: '/uploads/test.mp4',
    normalizedPath: 'norm_test.mp4',
    answers: ['test media'],
    thumbnails: []
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('resolveMediaPath', () => {
    it('should return normalized path when available', () => {
      const result = MediaService.resolveMediaPath(mockMedia);
      expect(result).toBe(path.join(process.cwd(), 'normalized', 'norm_test.mp4'));
    });

    it('should return original path when normalized path not available', () => {
      const mediaWithoutNormalized = { ...mockMedia, normalizedPath: undefined };
      const result = MediaService.resolveMediaPath(mediaWithoutNormalized);
      expect(result).toBe('/uploads/test.mp4');
    });

    it('should add norm_ prefix when missing', () => {
      const mediaWithUnprefixed = { ...mockMedia, normalizedPath: 'test.mp4' };
      const result = MediaService.resolveMediaPath(mediaWithUnprefixed);
      expect(result).toBe(path.join(process.cwd(), 'normalized', 'norm_test.mp4'));
    });
  });

  describe('findMedia', () => {
    it('should search for media when search term provided', async () => {
      mockFindMediaBySearch.mockResolvedValue([mockMedia]);
      
      const result = await MediaService.findMedia('test', false, 1);
      
      expect(mockFindMediaBySearch).toHaveBeenCalledWith('test', false, 1);
      expect(result).toEqual([mockMedia]);
    });

    it('should get random media when no search term', async () => {
      mockGetRandomMedia.mockResolvedValue([mockMedia]);
      
      const result = await MediaService.findMedia();
      
      expect(mockGetRandomMedia).toHaveBeenCalledWith(1);
      expect(result).toEqual([mockMedia]);
    });
  });

  describe('validateMediaExists', () => {
    it('should return true when file exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      
      const result = MediaService.validateMediaExists('/test/path');
      
      expect(result).toBe(true);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/test/path');
    });

    it('should return false when file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      
      const result = MediaService.validateMediaExists('/test/path');
      
      expect(result).toBe(false);
    });
  });
});