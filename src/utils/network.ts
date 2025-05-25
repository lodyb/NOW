import { networkInterfaces } from 'os';

let cachedWanIp: string | null = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Get the server's WAN IP address
 */
export const getWanIp = async (): Promise<string> => {
  // Return cached IP if still valid
  if (cachedWanIp && Date.now() - cacheTimestamp < CACHE_DURATION) {
    return cachedWanIp;
  }

  try {
    // Try to get external IP from a service with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch('https://api.ipify.org?format=text', { 
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    
    const externalIp = await response.text();
    
    if (externalIp && /^\d+\.\d+\.\d+\.\d+$/.test(externalIp.trim())) {
      cachedWanIp = externalIp.trim();
      cacheTimestamp = Date.now();
      return cachedWanIp;
    }
  } catch (error) {
    console.warn('Failed to get external IP:', error);
  }

  // Fallback to local network interface IP
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal && alias.address !== '127.0.0.1') {
        cachedWanIp = alias.address;
        cacheTimestamp = Date.now();
        return cachedWanIp;
      }
    }
  }

  // Final fallback
  return 'localhost';
};

/**
 * Get the base URL for the web server
 */
export const getBaseUrl = async (): Promise<string> => {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  
  const ip = await getWanIp();
  const port = process.env.PORT || '3000';
  return `http://${ip}:${port}`;
};