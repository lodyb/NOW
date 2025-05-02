import { logFFmpegCommand } from '../utils/logger';

export type EffectType = 'audio' | 'video' | 'complex';

export interface Effect {
  type: EffectType;
  description?: string;
  validate?: (value?: number | string) => boolean;
  apply: (value?: number | string) => string;
}

// Format effect and its value for display in logs and UI
export const formatEffectForLogging = (name: string, value?: number | string): string => {
  if (value === undefined) return name;
  return `${name}=${value}`;
};

// Filter aliases for user-friendly alternative names
export const effectAliases: Record<string, string> = {
  'fast': 'speed',
  'slow': 'speed',
  'echo': 'aecho',
  'robot': 'robotize',
  'phone': 'telephone',
  'tv': 'vhs',
  'retro': 'vhs',
  'old': 'oldfilm',
  'mirror': 'hmirror',
  'flip': 'vmirror',
  'rainbow': 'huerotate',
  'pixelate': 'pixelize',
  'dream': 'dreameffect',
  'acid': 'psychedelic',
  'wave': 'waves',
  '8bit': 'retroaudio'
};

// Check if an effect exists by name (case-insensitive)
export const effectExists = (name: string): boolean => {
  const normalizedName = name.toLowerCase();
  return normalizedName in effectRegistry || normalizedName in effectAliases;
};

// Resolve an effect name to its canonical form
export const resolveEffectName = (name: string): string => {
  const normalizedName = name.toLowerCase();
  return effectAliases[normalizedName] || normalizedName;
};

export const effectRegistry: Record<string, Effect> = {
  // === Audio Effects ===
  'aecho': {
    type: 'audio',
    description: 'Echo effect for audio',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 2,
    apply: (level = 0.6) => `aecho=0.8:0.8:${90 + (typeof level === 'number' ? level : 0.6) * 100}:0.6`
  },
  
  'robotize': {
    type: 'audio',
    description: 'Robot voice effect',
    apply: () => 'asetrate=8000,vibrato=f=5:d=0.5,aresample=8000'
  },
  
  'telephone': {
    type: 'audio',
    description: 'Telephone effect',
    apply: () => 'highpass=600,lowpass=3000,equalizer=f=1200:t=q:g=10'
  },
  
  'retroaudio': {
    type: 'audio',
    description: '8-bit retro game audio',
    apply: () => 'aresample=8000,aformat=sample_fmts=u8'
  },
  
  'stutter': {
    type: 'audio',
    description: 'Stutter effect',
    validate: (v) => typeof v === 'number' && v > 0 && v < 1,
    apply: (rate = 0.5) => {
      const r = typeof rate === 'number' ? rate : 0.5;
      return `aevalsrc=0:d=${r}:sample_rate=44100[silence];[0][silence]acrossfade=d=${r}:c1=exp:c2=exp,atempo=1/${1-r}`;
    }
  },
    
  'phaser': {
    type: 'audio',
    description: 'Phaser effect',
    validate: (v) => typeof v === 'number' && v > 0,
    apply: (rate = 1) => `aphaser=type=t:speed=${Math.max(0.1, (typeof rate === 'number' ? rate : 1) * 0.7)}:decay=0.5`
  },
    
  'flanger': {
    type: 'audio',
    description: 'Flanger effect',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 10,
    apply: (depth = 0.5) => {
      const d = typeof depth === 'number' ? depth : 0.5;
      return `flanger=delay=${Math.max(1, d * 10)}:depth=${Math.max(1, d * 10)}`;
    }
  },
    
  'tremolo': {
    type: 'audio',
    description: 'Tremolo effect',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 20,
    apply: (rate = 4) => `tremolo=f=${Math.max(0.5, (typeof rate === 'number' ? rate : 4) * 2)}:d=0.8`
  },
    
  'vibrato': {
    type: 'audio',
    description: 'Vibrato effect',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 20,
    apply: (rate = 5) => `vibrato=f=${Math.max(1, (typeof rate === 'number' ? rate : 5) * 2)}:d=0.5`
  },
    
  'chorus': {
    type: 'audio',
    description: 'Chorus effect',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 5,
    apply: (strength = 0.5) => {
      const s = typeof strength === 'number' ? strength : 0.5;
      return `chorus=0.5:0.9:${50+s*20}:0.4:0.25:2`;
    }
  },

  'bass': {
    type: 'audio',
    description: 'Bass boost effect',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 30,
    apply: (gain = 10) => `bass=g=${Math.min(30, typeof gain === 'number' ? gain : 10)}`
  },
  
  'crystalizer': {
    type: 'audio',
    description: 'Audio crystalizer effect',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 10,
    apply: (intensity = 5) => `crystalizer=i=${Math.min(9.9, typeof intensity === 'number' ? intensity : 5)}`
  },
  
  'whisper': {
    type: 'audio',
    description: 'Whisper effect',
    apply: () => "afftfilt=real='hypot(re,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8"
  },
  
  'clipping': {
    type: 'audio',
    description: 'Audio clipping effect',
    apply: () => 'acrusher=.1:1:64:0:log'
  },
  
  'ess': {
    type: 'audio',
    description: 'De-esser effect',
    apply: () => 'deesser=i=1:s=e'
  },
  
  'mountains': {
    type: 'audio',
    description: 'Echo mountains effect',
    apply: () => 'aecho=0.8:0.9:500|1000:0.2|0.1'
  },
  
  // === Video Effects ===
  'hmirror': {
    type: 'video',
    description: 'Horizontal mirror',
    apply: () => 'hflip'
  },
  
  'vmirror': {
    type: 'video',
    description: 'Vertical mirror',
    apply: () => 'vflip'
  },
  
  'vhs': {
    type: 'video',
    description: 'VHS tape effect',
    apply: () => 'noise=alls=15:allf=t,curves=r=0.2:g=0.1:b=0.2,hue=h=5,colorbalance=rs=0.1:bs=-0.1,format=yuv420p,drawgrid=w=iw/24:h=2*ih:t=1:c=white@0.2'
  },
  
  'oldfilm': {
    type: 'video',
    description: 'Old film effect',
    apply: () => 'curves=r=0.2:g=0.1:b=0.2,noise=alls=7:allf=t,hue=h=9,eq=brightness=0.05:saturation=0.5,vignette'
  },
    
  'huerotate': {
    type: 'video',
    description: 'Rainbow hue rotation',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 100,
    apply: (speed = 1) => `hue=h=mod(t*${Math.max(10, (typeof speed === 'number' ? speed : 1)*20)}\,360)`
  },
    
  'kaleidoscope': {
    type: 'video',
    description: 'Kaleidoscope effect',
    apply: () => 'split[a][b];[a]crop=iw/2:ih/2:0:0,hflip[a1];[b]crop=iw/2:ih/2:iw/2:0,vflip[b1];[a1][b1]hstack[top];[top][top]vstack'
  },
    
  'dreameffect': {
    type: 'video',
    description: 'Dreamy blur effect',
    apply: () => 'gblur=sigma=5,eq=brightness=0.1:saturation=1.5'
  },
    
  'ascii': {
    type: 'video',
    description: 'ASCII-like effect',
    apply: () => 'format=gray,scale=iw*0.2:-1,eq=brightness=0.3,boxblur=1:1,scale=iw*5:-1:flags=neighbor'
  },
    
  'crt': {
    type: 'video',
    description: 'CRT monitor effect',
    apply: () => 'scale=iw:ih,pad=iw+6:ih+6:3:3:black,curves=r=0.2:g=0.1:b=0.28,drawgrid=w=iw/100:h=ih:t=1:c=black@0.4,drawgrid=w=iw:h=1:t=1:c=blue@0.2'
  },
    
  'psychedelic': {
    type: 'video',
    description: 'Psychedelic effect',
    apply: () => 'hue=h=mod(t*40\,360):b=0.4,eq=contrast=2:saturation=8,gblur=sigma=5:sigmaV=5'
  },
    
  'slowmo': {
    type: 'complex',
    description: 'Slow motion effect',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 10,
    apply: (factor = 0.5) => {
      const f = typeof factor === 'number' ? factor : 0.5;
      return `setpts=${Math.max(1, 1/f)}*PTS;atempo=${f}`;
    }
  },
    
  'waves': {
    type: 'video',
    description: 'Wave effect',
    apply: () => 'noise=alls=20:allf=t,eq=contrast=1.5:brightness=-0.1:saturation=1.2'
  },
    
  'pixelize': {
    type: 'video',
    description: 'Pixelation effect',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 1,
    apply: (pixelSize = 0.05) => {
      const size = typeof pixelSize === 'number' ? pixelSize : 0.05;
      return `scale=iw*${Math.max(0.01, size)}:-1:flags=neighbor,scale=iw*${1/Math.max(0.01, size)}:-1:flags=neighbor`;
    }
  },

  'v360_fisheye': {
    type: 'video',
    description: 'Convert 360 video to fisheye',
    apply: () => 'v360=equirect:fisheye:w=720:h=720'
  },
  
  'v360_cube': {
    type: 'video',
    description: 'Convert 360 video to cube map',
    apply: () => 'v360=equirect:cube:w=1080:h=720'
  },
  
  'planet': {
    type: 'video',
    description: 'Convert 360 video to planet view',
    apply: () => 'v360=equirect:stereographic:w=720:h=720:in_stereo=0:out_stereo=0'
  },
  
  'tiny_planet': {
    type: 'video',
    description: 'Convert 360 video to tiny planet',
    apply: () => 'v360=equirect:stereographic:w=720:h=720:in_stereo=0:out_stereo=0:yaw=0:pitch=-90'
  },
  
  'signalstats': {
    type: 'video',
    description: 'Video signal statistics overlay',
    apply: () => 'signalstats=stat=all:color=cyan'
  },
  
  'waveform': {
    type: 'video',
    description: 'Audio waveform visualization',
    apply: () => 'waveform=filter=lowpass:mode=column:mirror=1:display=stack:components=7'
  },

  'drunk': {
    type: 'video',
    description: 'Drunk/blur effect',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 48,
    apply: (frames = 8) => `tmix=frames=${Math.min(48, typeof frames === 'number' ? frames : 8)}`
  },
  
  'oscilloscope': {
    type: 'video',
    description: 'Audio oscilloscope visualization',
    apply: () => 'oscilloscope=size=1:rate=1'
  },
  
  'vectorscope': {
    type: 'video',
    description: 'Color vectorscope visualization',
    apply: () => 'vectorscope=mode=color:m=color3:intensity=0.89:i=0.54'
  },
  
  'interlace': {
    type: 'video',
    description: 'Interlace effect',
    apply: () => 'telecine'
  },
  
  '360': {
    type: 'video',
    description: 'Convert 360 video to flat',
    apply: () => 'v360=equirect:flat'
  },
  
  // === Complex Effects (affect both audio and video) ===
  'reverse': {
    type: 'complex',
    description: 'Reverse audio and video',
    apply: () => '[0:v]reverse[v];[0:a]areverse[a]'
  },
  
  'speed': {
    type: 'complex',
    description: 'Change playback speed',
    validate: (v) => typeof v === 'number' && v > 0 && v <= 8,
    apply: (speed = 1) => {
      const s = typeof speed === 'number' ? speed : 1;
      // Complex filter to adjust both video and audio speed
      if (s >= 0.5 && s <= 2.0) {
        return `setpts=${1/s}*PTS;atempo=${s}`;
      } else if (s < 0.5) {
        // For very slow speeds
        let filter = `setpts=${1/s}*PTS;`;
        let remainingSpeed = s;
        // Chain multiple atempo filters for extreme slowdown (atempo range is 0.5-2.0)
        while (remainingSpeed < 0.5) {
          filter += 'atempo=0.5,';
          remainingSpeed /= 0.5;
        }
        filter += `atempo=${remainingSpeed}`;
        return filter;
      } else {
        // For very fast speeds
        let filter = `setpts=${1/s}*PTS;`;
        let remainingSpeed = s;
        // Chain multiple atempo filters for extreme speedup (atempo range is 0.5-2.0)
        while (remainingSpeed > 2.0) {
          filter += 'atempo=2.0,';
          remainingSpeed /= 2.0;
        }
        filter += `atempo=${remainingSpeed}`;
        return filter;
      }
    }
  },
  
  'macroblock': {
    type: 'video',
    description: 'Macroblock compression artifacts',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 30,
    apply: (strength = 5) => {
      const qValue = Math.min(300000, Math.max(2, Math.floor(2 + ((typeof strength === 'number' ? strength : 5) * 3))));
      // This is handled specially in the processor
      return `noise=alls=12:allf=t,qscale=${qValue}`;
    }
  },
  
  'glitch': {
    type: 'complex',
    description: 'Digital glitch effect',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 20,
    apply: (level = 3) => {
      const amount = Math.max(1, Math.min(40, Math.floor((typeof level === 'number' ? level : 3) * 5)));
      return `noise=c0s=${amount}:c1s=${amount}:c2s=${amount}:all_seed=${Math.floor(Math.random() * 10000)}`;
    }
  },
  
  'datamosh': {
    type: 'complex',
    description: 'Datamoshing effect',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 20,
    apply: (level = 3) => {
      const amount = Math.max(1, Math.min(40, Math.floor((typeof level === 'number' ? level : 3) * 5)));
      return `noise=c0s=${amount}:c1s=${amount}:c2s=${amount}:all_seed=${Math.floor(Math.random() * 10000)}`;
    }
  },
  
  'noise': {
    type: 'complex',
    description: 'Add noise',
    validate: (v) => typeof v === 'string' && ['bw', 'mono', 'color'].includes(v.toLowerCase()),
    apply: (type = 'color') => {
      const colorNoise = typeof type === 'string' && (type.toLowerCase() === 'mono' || type.toLowerCase() === 'bw');
      // This is handled specially in the processor
      return colorNoise 
        ? `noise=c0s=20:c1s=0:c2s=0:all_seed=${Math.floor(Math.random() * 10000)}`
        : `noise=c0s=20:c1s=20:c2s=20:all_seed=${Math.floor(Math.random() * 10000)}`;
    }
  },
  
  'pixelshift': {
    type: 'video',
    description: 'Pixel format shifting',
    validate: (v) => typeof v === 'string' && ['rgb', 'yuv', 'gray', 'bgr', 'gbr', 'yuv10', 'yuv16'].includes(v.toLowerCase()),
    apply: (mode = 'yuv16') => {
      // Map different format modes
      const pixelFormats: Record<string, string> = {
        'rgb': 'rgb24',
        'yuv': 'yuv422p16le',
        'gray': 'gray16le',
        'bgr': 'bgr444le',
        'gbr': 'gbrp10le',
        'yuv10': 'yuv420p10le',
        'yuv16': 'yuv420p16le'
      };
      
      const pixFormat = pixelFormats[typeof mode === 'string' ? mode.toLowerCase() : 'yuv16'] || 'yuv420p16le';
      return `format=${pixFormat},format=yuv420p`;
    }
  }
};