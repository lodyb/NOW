// filepath: /home/lody/now/src/web/auth-routes.ts
import express from 'express';
import passport from 'passport';
import path from 'path';
import { isAuthenticated } from './auth';

const router = express.Router();

// Login page
router.get('/auth/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.sendFile(path.join(process.cwd(), 'src/web/public/login.html'));
});

// Discord OAuth2 routes
router.get('/auth/discord', passport.authenticate('discord'));

router.get('/auth/discord/callback', 
  passport.authenticate('discord', {
    failureRedirect: '/auth/login?error=unauthorized',
    successRedirect: '/'
  })
);

// Logout route
router.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/auth/login');
  });
});

// User info API
router.get('/api/user', isAuthenticated, (req, res) => {
  res.json(req.user);
});

export default router;