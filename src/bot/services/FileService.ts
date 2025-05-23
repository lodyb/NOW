import fs from 'fs';
import path from 'path';

export class FileService {
  static cleanupTempFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`Failed to delete temporary file ${filePath}:`, err);
        }
      }
    }
  }

  static ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  static generateRandomId(): string {
    return Math.floor(Math.random() * 1000000000).toString();
  }

  static generateCryptoId(): string {
    const crypto = require('crypto');
    return crypto.randomBytes(4).toString('hex');
  }
}