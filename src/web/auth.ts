// filepath: /home/lody/now/src/web/auth.ts
import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
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

  // Discord OAuth2 strategy
  passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    callbackURL: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
    scope: ['identify', 'email']
  }, async (accessToken, refreshToken, profile, done) => {
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
export const isAuthenticated = (req: any, res: any, next: any) => {
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