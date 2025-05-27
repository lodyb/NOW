import path from 'path';
import fs from 'fs';
import { findMediaBySearch, getRandomMedia } from '../../database/db';

export interface MediaFile {
  id: number;
  title: string;
  filePath: string;
  normalizedPath?: string;
  answers: string[];
  thumbnails: string[];
  metadata?: any;
  isTemporary?: boolean;
}

export interface MusicLibraryFile {
  title: string;
  filePath: string;
  isTemporary: boolean;
  answers: string[];
}

export class MediaService {
  private static readonly NORMALIZED_DIR = path.join(process.cwd(), 'normalized');
  private static readonly TEMP_DIR = path.join(process.cwd(), 'temp');
  private static readonly MUSIC_LIBRARY_PATH = process.env.MUSIC_LIBRARY_PATH || '/media/enka/music';

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

  static async searchMusicLibrary(searchTerm: string, limit = 1): Promise<MusicLibraryFile[]> {
    if (!fs.existsSync(this.MUSIC_LIBRARY_PATH)) {
      return [];
    }

    const results: MusicLibraryFile[] = [];
    const searchLower = searchTerm.toLowerCase();

    const searchDirectory = (dir: string, depth = 0): void => {
      if (depth > 3 || results.length >= limit) return; // Limit depth and results

      try {
        const items = fs.readdirSync(dir);
        
        for (const item of items) {
          if (results.length >= limit) break;
          
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          
          if (stat.isDirectory()) {
            searchDirectory(fullPath, depth + 1);
          } else if (this.isMusicFile(item)) {
            const filename = path.parse(item).name;
            
            if (filename.toLowerCase().includes(searchLower)) {
              results.push({
                title: filename,
                filePath: fullPath,
                isTemporary: false,
                answers: [filename]
              });
            }
          }
        }
      } catch (error) {
        // Skip directories we can't read
      }
    };

    searchDirectory(this.MUSIC_LIBRARY_PATH);
    return results;
  }

  private static isMusicFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac'].includes(ext);
  }

  static validateMediaExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  static getTempDir(): string {
    return this.TEMP_DIR;
  }
}