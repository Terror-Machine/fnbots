// ─── Info ─────────────────────────────────────────
/*
 * Created with ❤️ and 💦 By FN
 * Follow https://github.com/Terror-Machine
 * Feel Free To Use
 */
// ─── Info database/auth.js ────────────────────────

import { redis } from './index.js';
import log from '../src/lib/logger.js';
import { proto, initAuthCreds, BufferJSON } from 'baileys';

export default async function AuthStore() {
  const writeData = async (data, file) => {
    try {
      await redis.set(`sessions:${file}`, JSON.stringify(data, BufferJSON.replacer));
    } catch (error) {
      await log(`writeData error: ${error.message}`, true);
    }
  };
  const readData = async (file) => {
    try {
      const data = await redis.get(`sessions:${file}`);
      if (!data) return null;
      return JSON.parse(data, BufferJSON.reviver);
    } catch (error) {
      await log(`readData error for ${file}: ${error.message}`, true);
      return null;
    }
  };
  const removeData = async (file) => {
    try {
      await redis.del(`sessions:${file}`);
    } catch (error) {
      await log(`removeData error for ${file}: ${error.message}`, true);
    }
  };
  const creds = (await readData('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          try {
            const data = {};
            await Promise.all(
              ids.map(async (id) => {
                let value = await readData(`${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[id] = value;
              })
            );
            return data;
          } catch (error) {
            await log(`Failed to get keys for type ${type}: ${error.message}`, true);
            return {};
          }
        },
        set: async (data) => {
          try {
            const tasks = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const file = `${category}-${id}`;
                tasks.push(value ? writeData(value, file) : removeData(file));
              }
            }
            await Promise.all(tasks);
          } catch (error) {
            await log(`Failed to set keys: ${error.message}`, true);
            throw error;
          }
        }
      }
    },
    saveCreds: async () => {
      try {
        await writeData(creds, 'creds');
        return true;
      } catch (error) {
        await log(`Failed to save credentials: ${error.message}`, true);
        return false;
      }
    },
    clearSession: async () => {
      try {
        await log('Clearing all session data...');
        const stream = redis.scanStream({ match: 'sessions:*', count: 100 });
        const keysToDelete = [];
        stream.on('data', (keys) => {
          keysToDelete.push(...keys);
        });
        await new Promise((resolve) => stream.on('end', resolve));
        if (keysToDelete.length > 0) {
          for (let i = 0; i < keysToDelete.length; i += 1000) {
            const batch = keysToDelete.slice(i, i + 1000);
            await redis.del(batch);
          }
        }
        await log(`Session cleared. Deleted ${keysToDelete.length} keys.`);
        Object.keys(creds).forEach((key) => delete creds[key]);
        Object.assign(creds, initAuthCreds());
        await writeData(creds, 'creds');
        return true;
      } catch (error) {
        await log(`Failed to clear session: ${error.message}`, true);
        return false;
      }
    },
    getSessionStats: async () => {
      try {
        const stream = redis.scanStream({ match: 'sessions:*', count: 100 });
        const keysByCategory = {};
        stream.on('data', (keys) => {
          keys.forEach((key) => {
            const withoutPrefix = key.replace('sessions:', '');
            const category = withoutPrefix.split('-')[0];
            keysByCategory[category] = (keysByCategory[category] || 0) + 1;
          });
        });
        await new Promise((resolve) => stream.on('end', resolve));
        // prettier-ignore
        return Object.entries(keysByCategory).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
      } catch (error) {
        await log(`Failed to get session stats: ${error.message}`, true);
        return [];
      }
    }
  };
}
