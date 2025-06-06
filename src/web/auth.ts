// filepath: /home/lody/now/src/web/auth.ts
import passport from 'passport';
import { Strategy as DiscordStrategy, Profile } from 'passport-discord';
import { Request, Response, NextFunction } from 'express';
import { db } from '../database/db';

// Define Discord user interface
interface DiscordUser {
  id: string;
  username: string;
  avatar: string;
  discriminator: string;
  email: string;
}

// Configure Discord OAuth strategy
export const setupAuth = () => {
  // Passport serialization
  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((obj: Express.User, done) => {
    done(null, obj);
  });

  // Only set up Discord strategy if credentials are provided
  const clientID = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  
  if (clientID && clientSecret) {
    // Discord OAuth2 strategy
    passport.use(new DiscordStrategy({
      clientID,
      clientSecret,
      callbackURL: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
      scope: ['identify', 'email']
    }, async (accessToken: string, refreshToken: string, profile: Profile, done: (err: any, user?: any, info?: any) => void) => {
      try {
        // Check if user exists in the database
        const user = await getUserById(profile.id);
        
        if (!user) {
          return done(null, false, { message: 'User not in authorized list' });
        }
        
        return done(null, {
          id: profile.id,
          username: profile.username,
          avatar: profile.avatar
        });
      } catch (error) {
        return done(error as Error);
      }
    }));
    console.log('Discord authentication enabled');
  } else {
    console.warn('Discord authentication credentials not found. Authentication disabled.');
  }
};

// Get user from database
export const getUserById = (id: string): Promise<{ id: string, username: string } | null> => {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, username FROM users WHERE id = ?', [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (!row) {
        resolve(null);
        return;
      }
      
      resolve(row as { id: string, username: string });
    });
  });
};

// Auth middleware for protecting routes
export const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
  // Skip auth check if Discord credentials aren't configured
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return next();
  }
  
  if (req.isAuthenticated()) {
    return next();
  }
  
  // If API request, return 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Otherwise redirect to login
  res.redirect('/auth/login');
};