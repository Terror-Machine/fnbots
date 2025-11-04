// ─── Info ─────────────────────────────────────
/*
 * Created with ❤️ and 💦 By FN
 * Follow https://github.com/Terror-Machine
 * Feel Free To Use
 */
// ─── Info core/connection.js ──────────────────

import 'dotenv/config.js';
import readline from 'readline';
import config from '../config.js';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { clientBot } from './client.js';
import AuthStore from '../database/auth.js';
import { parsePhoneNumber } from 'awesome-phonenumber';
import log, { pinoLogger } from '../src/lib/logger.js';
import { Settings, store } from '../database/index.js';
import { restartManager } from '../src/lib/restartManager.js';
import { default as makeWASocket, jidNormalizedUser, fetchLatestBaileysVersion, Browsers, isJidBroadcast, makeCacheableSignalKeyStore } from 'baileys';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const baileysPackage = require('baileys/package.json');

let phoneNumber;
let pairingStarted = false;

const pairingCode = process.argv.includes('--qr') ? false : process.argv.includes('--pairing-code') || config.usePairingCode;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

export async function createWASocket(dbSettings) {
  const { version } = await fetchLatestBaileysVersion();
  const authStore = await AuthStore();
  const { state, saveCreds } = authStore;
  const fn = makeWASocket({
    version: version,
    logger: pinoLogger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pinoLogger)
    },
    generateHighQualityLinkPreview: true,
    linkPreviewImageThumbnailWidth: 192,
    shouldIgnoreJid: (jid) => {
      return isJidBroadcast(jid) && jid !== 'status@broadcast';
    },
    browser: Browsers.macOS('Safari'),
    defaultQueryTimeoutMs: undefined,
    markOnlineOnConnect: false,
    retryRequestDelayMs: 500,
    shouldSyncHistoryMessage: () => true,
    maxMsgRetryCount: 5,
    emitOwnEvents: true,
    fireInitQueries: true,
    transactionOpts: {
      maxCommitRetries: 10,
      delayBetweenTriesMs: 3000
    },
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000
  });

  const originalGetUSyncDevices = fn.getUSyncDevices;
  fn.getUSyncDevices = async function (jids, useCache, ignoreZeroDevices) {
    const devices = await originalGetUSyncDevices(jids, useCache, ignoreZeroDevices);
    const seen = new Set();
    const unique = [];
    for (const device of devices) {
      const key = `${device.user}:${device.device}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(device);
      } else {
        await log(`[CRITICAL PATCH] Blocked duplicate device: ${device.jid} (${key})`, true);
      }
    }
    if (unique.length !== devices.length) {
      await log(`[CRITICAL PATCH] Deduplicated ${devices.length} → ${unique.length} devices`, true);
    }
    return unique;
  };

  global.version = version;

  fn.clearSession = authStore.clearSession;
  fn.getPN = (lid) => store.getPNForLID(lid);
  fn.getLID = (pn) => store.getLIDForPN(pn);
  fn.resolveJid = (id) => store.resolveJid(id);

  if (pairingCode && !phoneNumber && !fn.authState.creds.registered) {
    let numberToValidate = config.botNumber ? config.botNumber : dbSettings.botNumber;
    let isValid = false;
    while (!isValid) {
      if (!numberToValidate) {
        numberToValidate = await question('Please type your WhatsApp number : ');
      }
      const cleanedNumber = numberToValidate.replace(/[^0-9]/g, '');
      if (cleanedNumber.length >= 9 && parsePhoneNumber('+' + cleanedNumber).valid) {
        phoneNumber = cleanedNumber;
        dbSettings.botNumber = cleanedNumber;
        await Settings.updateSettings(dbSettings);
        isValid = true;
        await log('Phone number valid, continuing...');
      } else {
        await log('Invalid number. Start with your country code, Example: 628123456789');
        numberToValidate = null;
      }
    }
    await authStore.clearSession();
    dbSettings.botNumber = null;
    await Settings.updateSettings(dbSettings);
  }

  await clientBot(fn, dbSettings);
  fn.ev.on('creds.update', saveCreds);
  fn.ev.on('connection.update', async ({ connection, lastDisconnect, qr, isNewLogin }) => {
    const statusCode = lastDisconnect?.error ? new Boom(lastDisconnect.error).output.statusCode : 0;
    if ((connection === 'connecting' || !!qr) && pairingCode && phoneNumber && !fn.authState.creds.registered && !pairingStarted) {
      setTimeout(async () => {
        pairingStarted = true;
        await log('Requesting Pairing Code...');
        let code = await fn.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        await log(`Your Pairing Code : ${code}`);
      }, 3000);
    }
    if (connection === 'open') {
      restartManager.reset();
      if (dbSettings.restartState) {
        dbSettings.restartState = false;
        if (dbSettings.restartId?.includes('@g.us')) {
          const res = await store.getGroupMetadata(dbSettings.restartId);
          await fn.sendPesan(dbSettings.restartId, `Restart sukses..`, { ephemeralExpiration: res.ephemeralDuration });
        } else if (dbSettings.restartId?.includes('@s.whatsapp.net')) {
          const expiration = await fn.getEphemeralExpiration(dbSettings.restartId);
          await fn.sendPesan(dbSettings.restartId, `Restart sukses..`, { ephemeralExpiration: expiration });
        }
        dbSettings.restartId = undefined;
        await Settings.updateSettings(dbSettings);
      }
      await log(`Connecting to WhatsApp...`);
      try {
        await log('Starting group data synchronization...');
        const participatingGroups = await fn.groupFetchAllParticipating();
        const currentGroupIds = new Set(Object.keys(participatingGroups));
        const groupsToUpdate = Object.values(participatingGroups);
        await log(`Fetched ${groupsToUpdate.length} active groups from WhatsApp`);
        if (groupsToUpdate.length > 0) {
          await store.bulkUpsertGroups(groupsToUpdate);
        }
        await log('Checking for stale groups...');
        const syncResult = await store.syncStaleGroups(currentGroupIds);
        if (syncResult.removed > 0) {
          await log(`Cleaned up ${syncResult.removed} stale groups`);
        }
        if (syncResult.errors > 0) {
          await log(`${syncResult.errors} errors during cleanup`, true);
        }
        await log('Group synchronization completed successfully.');
      } catch (error) {
        await log(`Error during group sync: ${error}`, true);
      }
      await log(`WhatsAppWeb Version: ${global.version.join('.')}`);
      await log(`Baileys Version: ${baileysPackage.version}`);
      await log(`BOT Number: ${jidNormalizedUser(fn.user.id).split('@')[0]}`);
      await log(`${dbSettings.botName} Success Connected to WhatsApp`);
    }
    if (connection === 'close') {
      await log(`Error ${lastDisconnect.error?.message || lastDisconnect.error}`);
      const fatalCodes = [401, 402, 403, 411];
      const transientCodes = [408, 429, 440, 500, 503];
      if (fatalCodes.includes(statusCode)) {
        await log(`Fatal auth error (${statusCode}). Clearing session...`, true);
        dbSettings.botNumber = null;
        await authStore.clearSession();
        await Settings.updateSettings(dbSettings);
        restartManager.forceExit(1);
      } else if (transientCodes.includes(statusCode)) {
        await log(`Temporary disconnect (${statusCode}). Reconnecting in 15s...`);
        await new Promise((res) => setTimeout(res, 15_000));
        await restartManager.restart(`Reconnecting after code ${statusCode}`, (await import('../src/lib/performanceManager.js')).performanceManager);
      } else {
        await log(`Unexpected close (${statusCode}). Restarting...`);
        await restartManager.restart(`Restart after unknown code ${statusCode}`, (await import('../src/lib/performanceManager.js')).performanceManager);
      }
    }
    if (isNewLogin) {
      await log(`New device detected, session restarted!`);
      restartManager.reset();
    }
    if (qr && !pairingCode) {
      log('Scan QR berikut:');
      qrcode.generate(qr, { small: true }, (qrcodeString) => {
        log(`\n${String(qrcodeString)}`);
      });
    }
  });
  return { fn, authStore };
}
