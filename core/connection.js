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
import qrcode from 'qrcode-terminal';
import { clientBot } from './client.js';
import AuthStore from '../database/auth.js';
import { parsePhoneNumber } from 'awesome-phonenumber';
import log, { pinoLogger } from '../src/lib/logger.js';
import { Settings, store } from '../database/index.js';
import { restartManager } from '../src/lib/restartManager.js';
import { default as makeWASocket, jidNormalizedUser, fetchLatestBaileysVersion, Browsers, isJidBroadcast, makeCacheableSignalKeyStore } from 'baileys';

let phoneNumber;
let pairingStarted = false;
let isReconnecting = false;

const pairingCode = process.argv.includes('--qr') ? false : process.argv.includes('--pairing-code') || config.usePairingCode;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

function parseDisconnectReason(lastDisconnect) {
  if (!lastDisconnect?.error) return { reason: 'unknown', code: 0 };
  const error = lastDisconnect.error;
  const statusCode = error?.output?.statusCode || error?.statusCode || 0;
  const message = (error?.message || '').toLowerCase();
  const codeMap = {
    400: 'bad_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    408: 'request_timeout',
    409: 'conflict',
    410: 'gone',
    411: 'length_required',
    428: 'session_replaced',
    429: 'rate_limited',
    440: 'multi_device_migration',
    460: 'pairing_required',
    463: 'device_removed',
    470: 'bad_provisioning',
    471: 'stale_session',
    472: 'stale_socket',
    480: 'temporarily_unavailable',

    500: 'internal_server_error',
    501: 'not_implemented',
    502: 'bad_gateway',
    503: 'service_unavailable',
    504: 'gateway_timeout',
    515: 'restart_required',
    516: 'unknown_server_error',
    518: 'connection_replaced',
    540: 'too_many_sessions',

    600: 'restart_required',
    700: 'outdated_version'
  };
  let reason = codeMap[statusCode];
  if (!reason) {
    if (message.includes('logged out')) reason = 'logged_out';
    else if (message.includes('replaced')) reason = 'session_replaced';
    else if (message.includes('timeout')) reason = 'timeout';
    else if (message.includes('connection')) reason = 'connection_error';
    else if (message.includes('unauthorized')) reason = 'unauthorized';
    else if (message.includes('rate limit')) reason = 'rate_limited';
    else if (message.includes('unavailable')) reason = 'service_unavailable';
    else reason = statusCode ? `code_${statusCode}` : 'unknown';
  }
  if (statusCode && !codeMap[statusCode]) {
    log(`Unhandled status code: ${statusCode} (${message})`, true);
  }
  return { reason, code: statusCode };
}

function shouldAutoReconnect(reason) {
  const noAutoReconnect = [
    'logged_out',
    'unauthorized',
    'forbidden',
    'length_required',
    'device_removed',
    'outdated_version'
  ];
  return !noAutoReconnect.includes(reason);
}

function getReconnectDelay(reason, code) {
  const delayMap = {
    rate_limited: 15_000,
    too_many_sessions: 15_000,
    service_unavailable: 8_000,
    bad_gateway: 8_000,
    gateway_timeout: 8_000,
    timeout: 5_000,
    request_timeout: 5_000,
    connection_error: 3_000,
    stale_session: 2_000,
    stale_socket: 2_000,
    protocol_violation: 2_000,
    default: 5_000
  };
  if (code >= 500 && code < 600) {
    return delayMap.service_unavailable;
  }
  return delayMap[reason] || delayMap.default;
}

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
    browser: Browsers.appropriate('Desktop', 'FNBOTS'),
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
    keepAliveIntervalMs: 30_000,
    enableAutoSessionRecreation: true,
    enableRecentMessageCache: true
  });

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
    try {
      if ((connection === 'connecting' || !!qr) && pairingCode && phoneNumber && !fn.authState.creds.registered && !pairingStarted) {
        setTimeout(async () => {
          pairingStarted = true;
          await log('Requesting Pairing Code...');
          let code = await fn.requestPairingCode(phoneNumber);
          code = code?.match(/.{1,4}/g)?.join('-') || code;
          await log(`Your Pairing Code : ${code}`);
        }, 3000);
      }
      if (qr && !pairingCode) {
        log('Scan QR berikut:');
        qrcode.generate(qr, { small: true }, (qrcodeString) => {
          log(`\n${String(qrcodeString)}`);
        });
      }
      if (connection === 'open') {
        restartManager.reset();
        isReconnecting = false;
        if (dbSettings.restartState) {
          dbSettings.restartState = false;
          if (dbSettings.restartId?.includes('@g.us')) {
            const res = await store.getGroupMetadata(dbSettings.restartId);
            await fn.sendPesan(dbSettings.restartId, `✅ Restart sukses`, { ephemeralExpiration: res.ephemeralDuration });
          } else if (dbSettings.restartId?.includes('@s.whatsapp.net')) {
            const expiration = await fn.getEphemeralExpiration(dbSettings.restartId);
            await fn.sendPesan(dbSettings.restartId, `✅ Restart sukses`, { ephemeralExpiration: expiration });
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
          await log(`Error during group sync: ${error.message}`, true);
        }
        await log(`WA Version: ${global.version.join('.')}`);
        await log(`BOT Number: ${jidNormalizedUser(fn.user.id).split('@')[0]}`);
        await log(`${dbSettings.botName} Success Connected to WhatsApp`);
      }
      if (connection === 'close') {
        const { reason, code } = parseDisconnectReason(lastDisconnect);
        await log(`Connection closed. Reason: ${reason} (Code: ${code})`);
        const fatalCodes = [401, 402, 403, 411];
        if (fatalCodes.includes(code) || reason === 'logged_out') {
          await log(`Fatal auth error. Clearing session...`, true);
          isReconnecting = false;
          dbSettings.botNumber = null;
          await authStore.clearSession();
          await Settings.updateSettings(dbSettings);
          restartManager.forceExit(1);
          return;
        }
        if (shouldAutoReconnect(reason) && !isReconnecting) {
          isReconnecting = true;
          const delay = getReconnectDelay(reason, code);
          await log(`Auto-reconnect in ${(delay / 1000).toFixed(1)}s...`);
          const performanceManager = await import('../src/lib/performanceManager.js').then(m => m.performanceManager).catch(() => null);
          await new Promise(resolve => setTimeout(resolve, delay));
          await restartManager.restart(`Reconnecting after ${reason} (code: ${code})`, performanceManager, fn);
        } else if (!shouldAutoReconnect(reason)) {
          await log(`No auto-reconnect for reason: ${reason}. Manual intervention required.`, true);
          isReconnecting = false;
          restartManager.forceExit(1);
        } else {
          await log(`Reconnect already in progress, skipping duplicate.`);
        }
      }
      if (isNewLogin) {
        await log(`New device detected, session restarted!`);
        restartManager.reset();
      }
    } catch (error) {
      await log(`Connection update error: ${error.message}`, true);
      await log(error.stack, true);
      isReconnecting = false;
    }
  });
  return { fn, authStore };
}