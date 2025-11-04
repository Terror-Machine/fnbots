// ─── Info ────────────────────────────────────────
/*
 * Created with ❤️ and 💦 By FN
 * Follow https://github.com/Terror-Machine
 * Feel Free To Use
 */
// ─── Info src/lib/logger.js ──────────────────────

import pino from 'pino';
import path from 'path';
import util from 'util';
import fs from 'fs-extra';
import process from 'process';
import config from '../../config.js';
import { signalHandler } from './signalHandler.js';

const logFilePath = path.join(process.cwd(), config.paths.logsDir);
const blockedKeywords = config.logger.blockedKeywords;

function redactSecrets(input) {
  if (!input || typeof input !== 'string') return input;
  let redacted = input;
  const secrets = [config.openWather, config.huggigFace, config.geminiApikey];
  secrets.forEach((secret) => {
    if (typeof secret === 'string' && secret.length > 0) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  });
  return redacted;
}

class SafeRotatingFileStream {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxSize = options.maxSize || 10 * 1024 * 1024;
    this.maxFiles = options.maxFiles || 7;
    this.currentSize = 0;
    this.writeQueue = [];
    this.isWriting = false;
    this.isRotating = false;
    this.flushInterval = options.flushInterval || 1000;
    this.buffer = [];
    this.bufferSize = 0;
    this.maxBufferSize = options.maxBufferSize || 100;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.openStream();
    this.startFlushInterval();
    this.registerShutdownHandler();
  }
  openStream() {
    if (this.stream) {
      this.stream.end();
    }
    if (fs.existsSync(this.filePath)) {
      const stats = fs.statSync(this.filePath);
      this.currentSize = stats.size;
      if (this.currentSize >= this.maxSize) {
        this.rotate();
        this.currentSize = 0;
      }
    }
    this.stream = fs.createWriteStream(this.filePath, {
      flags: 'a',
      highWaterMark: 64 * 1024
    });
    this.stream.on('drain', () => {
      this.processQueue();
    });
    this.stream.on('error', (err) => {
      console.error('Stream error:', err);
      this.reopenStream();
    });
  }
  reopenStream() {
    setTimeout(() => {
      try {
        this.openStream();
      } catch (err) {
        console.error('Failed to reopen stream:', err);
        this.reopenStream();
      }
    }, 1000);
  }
  rotate() {
    if (this.isRotating) return;
    this.isRotating = true;
    try {
      this.flushBuffer();
      if (this.stream) {
        this.stream.end();
        this.stream = null;
      }
      const oldestFile = `${this.filePath}.${this.maxFiles}`;
      if (fs.existsSync(oldestFile)) {
        fs.unlinkSync(oldestFile);
      }
      for (let i = this.maxFiles - 1; i > 0; i--) {
        const oldFile = `${this.filePath}.${i}`;
        const newFile = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(oldFile)) {
          fs.renameSync(oldFile, newFile);
        }
      }
      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch (err) {
      console.error('Rotation error:', err);
    } finally {
      this.isRotating = false;
    }
  }
  write(data) {
    this.buffer.push(data);
    this.bufferSize++;
    if (this.bufferSize >= this.maxBufferSize) {
      this.flushBuffer();
    }
  }
  flushBuffer() {
    if (this.buffer.length === 0 || this.isRotating) return;
    const batchData = this.buffer.join('');
    this.buffer = [];
    this.bufferSize = 0;
    this.writeQueue.push(batchData);
    this.processQueue();
  }
  processQueue() {
    if (this.isWriting || this.writeQueue.length === 0 || this.isRotating) return;
    this.isWriting = true;
    const data = this.writeQueue.shift();
    const dataSize = Buffer.byteLength(data);
    if (this.currentSize + dataSize >= this.maxSize) {
      this.isWriting = false;
      this.rotate();
      this.currentSize = 0;
      this.openStream();
      this.writeQueue.unshift(data);
      this.processQueue();
      return;
    }
    const canContinue = this.stream.write(data, (err) => {
      if (err) {
        console.error('Write error:', err);
        this.writeQueue.unshift(data);
      } else {
        this.currentSize += dataSize;
      }
      this.isWriting = false;

      if (this.writeQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    });
    if (!canContinue) {
      this.isWriting = false;
    }
  }
  startFlushInterval() {
    this.flushTimer = setInterval(() => {
      this.flushBuffer();
    }, this.flushInterval);
  }
  registerShutdownHandler() {
    const handlerName = `rotating-stream-${this.filePath}`;
    signalHandler.register(
      handlerName,
      async () => {
        await this.close();
      },
      50
    );
  }
  close() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    this.flushBuffer();
    return new Promise((resolve) => {
      const waitForQueue = () => {
        if (this.writeQueue.length > 0 || this.isWriting) {
          setTimeout(waitForQueue, 100);
        } else {
          if (this.stream) {
            this.stream.end();
          }
          resolve();
        }
      };
      waitForQueue();
    });
  }
}

function formatLogObject(logObj) {
  const timestamp = formatTime(logObj.time);
  const level = logObj.level === 30 ? 'INFO' : logObj.level === 40 ? 'WARN' : logObj.level === 50 ? 'ERROR' : logObj.level === 60 ? 'FATAL' : logObj.level === 20 ? 'DEBUG' : logObj.level === 10 ? 'TRACE' : 'INFO';
  const logParts = [`[${timestamp}] ${level}: ${logObj.msg}`];
  const excludedKeys = ['time', 'level', 'msg', 'pid', 'hostname', 'v'];
  const additionalData = {};
  for (const key in logObj) {
    if (!excludedKeys.includes(key)) {
      additionalData[key] = logObj[key];
    }
  }
  if (Object.keys(additionalData).length > 0) {
    for (const [key, value] of Object.entries(additionalData)) {
      const formattedValue = typeof value === 'object' ? JSON.stringify(value, null, 2).split('\n').join('\n    ') : value;
      logParts.push(`    ${key}: ${formattedValue}`);
    }
  }
  return logParts.join('\n') + '\n';
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (num) => String(num).padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

let baileysFileStreamSingleton = null;

function getOrCreateBaileysFileStream() {
  if (!baileysFileStreamSingleton) {
    const rotatingStream = new SafeRotatingFileStream(path.join(logFilePath, 'baileys.log'), {
      maxSize: 10 * 1024 * 1024,
      maxFiles: 7,
      maxBufferSize: 100,
      flushInterval: 1000
    });
    baileysFileStreamSingleton = {
      write: (data) => {
        try {
          const logObj = JSON.parse(data);
          const formattedLog = formatLogObject(logObj);
          rotatingStream.write(formattedLog);
        } catch {
          rotatingStream.write(data);
        }
      }
    };
  }
  return baileysFileStreamSingleton;
}

function createFormattedStream(filePath) {
  const rotatingStream = new SafeRotatingFileStream(filePath, {
    maxSize: 10 * 1024 * 1024,
    maxFiles: 7,
    maxBufferSize: 100,
    flushInterval: 1000
  });
  return {
    write: (data) => {
      try {
        const logObj = JSON.parse(data);
        const formattedLog = formatLogObject(logObj);
        rotatingStream.write(formattedLog);
      } catch {
        rotatingStream.write(data);
      }
    }
  };
}

class BaileysLoggerWrapper {
  constructor() {
    this.consoleLogger = pino(
      pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
          ignore: 'pid,hostname,level'
        }
      })
    );
    this.fileStream = getOrCreateBaileysFileStream();
    this.fileLogger = pino({ level: 'trace' }, this.fileStream);
    this._consoleLevel = 'trace';
  }
  get level() {
    return this._consoleLevel;
  }
  set level(newLevel) {
    this._consoleLevel = newLevel;
    this.consoleLogger.level = newLevel;
  }
  trace(msg, ...args) {
    if (this._consoleLevel !== 'silent') {
      this.consoleLogger.trace(msg, ...args);
    }
    this.fileLogger.trace(msg, ...args);
  }
  debug(msg, ...args) {
    if (this._consoleLevel !== 'silent') {
      this.consoleLogger.debug(msg, ...args);
    }
    this.fileLogger.debug(msg, ...args);
  }
  info(msg, ...args) {
    if (this._consoleLevel !== 'silent') {
      this.consoleLogger.info(msg, ...args);
    }
    this.fileLogger.info(msg, ...args);
  }
  warn(msg, ...args) {
    if (this._consoleLevel !== 'silent') {
      this.consoleLogger.warn(msg, ...args);
    }
    this.fileLogger.warn(msg, ...args);
  }
  error(msg, ...args) {
    if (this._consoleLevel !== 'silent') {
      this.consoleLogger.error(msg, ...args);
    }
    this.fileLogger.error(msg, ...args);
  }
  fatal(msg, ...args) {
    if (this._consoleLevel !== 'silent') {
      this.consoleLogger.fatal(msg, ...args);
    }
    this.fileLogger.fatal(msg, ...args);
  }
  child(options) {
    const childWrapper = new BaileysLoggerWrapper();
    childWrapper._consoleLevel = this._consoleLevel;
    childWrapper.consoleLogger = this.consoleLogger.child(options);
    childWrapper.fileLogger = this.fileLogger.child(options);
    return childWrapper;
  }
  bind() {
    return this;
  }
}

export const pinoLogger = new BaileysLoggerWrapper();

const appFileStream = createFormattedStream(path.join(logFilePath, 'app_activity.log'));

export const appLogger = pino(
  {
    level: 'trace'
  },
  pino.multistream([
    {
      level: 'trace',
      stream: pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
          ignore: 'pid,hostname,level'
        }
      })
    },
    {
      level: 'trace',
      stream: appFileStream
    }
  ])
);

export function updatePinoLoggerLevel(level) {
  pinoLogger.level = level;
}

console.log = (...args) => {
  const message = args.length === 1 ? args[0] : args;
  log(message);
};
console.info = (...args) => {
  const message = args.length === 1 ? args[0] : args;
  log(message);
};
console.error = (...args) => {
  const message = args.length === 1 ? args[0] : args;
  log(message, true);
};
console.warn = (...args) => {
  const message = args.length === 1 ? args[0] : args;
  log(message, true);
};

export default async function log(message, isError = false) {
  try {
    if (message instanceof Error) {
      const errorObj = {
        name: message.name,
        message: message.message,
        stack: message.stack,
        ...Object.getOwnPropertyNames(message).reduce((acc, key) => {
          if (!['name', 'message', 'stack'].includes(key)) {
            try {
              acc[key] = message[key];
            } catch {
              acc[key] = `[unserializable:${key}]`;
            }
          }
          return acc;
        }, {})
      };
      const errorString = util.inspect(errorObj, { depth: null, colors: false });
      if (blockedKeywords.some((keyword) => errorString.includes(keyword))) return;
      appLogger.error(errorString);
      return;
    }
    const inspectedMessage = typeof message === 'string' ? message : util.inspect(message, { depth: null });
    if (blockedKeywords.some((keyword) => inspectedMessage.includes(keyword))) return;
    if (isError) {
      appLogger.error(inspectedMessage);
    } else {
      appLogger.info(inspectedMessage);
    }
  } catch (loggerError) {
    if (isError) {
      console.error('Logger error:', loggerError);
      if (message instanceof Error) {
        console.error(redactSecrets(message.message));
        console.error(redactSecrets(message.stack));
      } else {
        console.error(redactSecrets(message));
      }
    } else {
      console.log(redactSecrets(message));
    }
  }
}
