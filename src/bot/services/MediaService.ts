import path from 'path';
import fs from 'fs';
import { findMediaBySearch, getRandomMedia } from '../../database/db';

export interface MediaFile {
  id: number;
  title: string;
  filePath: string;
  normalizedPath?: string;
}

export class MediaService {
  private static readonly NORMALIZED_DIR = path.join(process.cwd(), 'normalized');
  private static readonly TEMP_DIR = path.join(process.cwd(), 'temp');

  static resolveMediaPath(media: MediaFile): string {
    if (!media.normalizedPath) return media.filePath;
    
    const filename = path.basename(media.normalizedPath);
    const normalizedFilename = filename.startsWith('norm_') ? filename : `norm_${filename}`;
    return path.join(this.NORMALIZED_DIR, normalizedFilename);
  }

  static async findMedia(searchTerm?: string, requireVideo = false, limit = 1): Promise<MediaFile[]> {
    // Treat empty strings and undefined as requests for random media
    const hasValidSearchTerm = searchTerm && searchTerm.trim() !== '';
    
    return hasValidSearchTerm 
      ? await findMediaBySearch(searchTerm, requireVideo, limit)
      : await getRandomMedia(limit);
  }

  static validateMediaExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  static getTempDir(): string {
    return this.TEMP_DIR;
  }
}