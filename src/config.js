const fs = require('fs');
const path = require('path');

// Cross-platform config directory
const CONFIG_DIR = path.join(
  process.env.APPDATA || (process.env.HOME || process.env.USERPROFILE || process.cwd()),
  '.queuectl'
);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Default configuration
const DEFAULT_CONFIG = {
  maxRetries: 3,
  backoffBase: 2,
  dataDir: path.join(CONFIG_DIR, 'data'),
  workers: {
    pidFile: path.join(CONFIG_DIR, 'workers.pid')
  }
};

class Config {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.load();
  }

  load() {
    try {
      // Ensure config directory exists
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      // Ensure data directory exists
      if (!fs.existsSync(this.config.dataDir)) {
        fs.mkdirSync(this.config.dataDir, { recursive: true });
      }

      if (fs.existsSync(CONFIG_FILE)) {
        const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(fileContent) };
      } else {
        this.save();
      }
    } catch (error) {
      console.error('Error loading config:', error.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Error saving config:', error.message);
    }
  }

  get(key) {
    const keys = key.split('.');
    let value = this.config;
    for (const k of keys) {
      value = value?.[k];
    }
    return value;
  }

  set(key, value) {
    const keys = key.split('.');
    const lastKey = keys.pop();
    let obj = this.config;
    
    for (const k of keys) {
      if (!obj[k]) obj[k] = {};
      obj = obj[k];
    }
    
    obj[lastKey] = value;
    this.save();
  }

  getAll() {
    return { ...this.config };
  }
}

module.exports = new Config();

