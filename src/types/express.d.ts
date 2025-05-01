// src/types/express.d.ts
import { Express } from 'express';

declare global {
  namespace Express {
    interface Request {
      fileValidationError?: string;
    }
  }
}